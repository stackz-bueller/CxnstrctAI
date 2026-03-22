import { openai } from "@workspace/integrations-openai-ai-server";
import type { SchemaField } from "@workspace/db/schema";

export interface ExtractionFieldResult {
  name: string;
  label: string;
  value: unknown;
  confidence: number;
  present: boolean;
}

/**
 * Schema-anchored OCR extraction pipeline.
 *
 * Inspired by academic information extraction pipelines (e.g. named entity recognition
 * pipelines with schema constraints), this performs a two-pass extraction:
 *
 * Pass 1 — OCR: Extract raw text from the document image using vision AI.
 * Pass 2 — Schema-anchored field extraction: Given the raw text and the locked schema,
 *           extract ONLY the defined fields. The schema acts as an anchor preventing
 *           hallucination of new fields (schema drift prevention).
 *
 * The model is instructed to:
 * - Return ONLY the fields defined in the schema
 * - Provide a confidence score per field (0-1)
 * - Mark fields as absent rather than invent values
 * - Coerce values to the declared field type
 *
 * This mirrors the "constrained slot filling" approach described in
 * structured prediction literature where a pre-defined ontology/schema
 * constrains model output to prevent unbounded label sets.
 */
export async function runExtractionPipeline(
  imageBase64: string,
  mimeType: string,
  fields: SchemaField[],
  schemaName: string,
  schemaDescription: string,
): Promise<{ rawText: string; fields: ExtractionFieldResult[]; processingTimeMs: number }> {
  const startTime = Date.now();

  const ocrResponse = await openai.chat.completions.create({
    model: "gpt-5.2",
    max_completion_tokens: 4096,
    messages: [
      {
        role: "system",
        content:
          "You are a precise OCR engine. Extract ALL visible text from the document image exactly as it appears, preserving structure. Output only the raw text, nothing else.",
      },
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: `data:${mimeType};base64,${imageBase64}` },
          },
          {
            type: "text",
            text: "Extract all text from this document. Preserve line breaks, amounts, dates, and labels exactly as shown.",
          },
        ],
      },
    ],
  });

  const rawText = ocrResponse.choices[0]?.message?.content ?? "";

  const fieldDefs = fields
    .map(
      (f, i) =>
        `${i + 1}. name="${f.name}", label="${f.label}", type=${f.type}, required=${f.required}, description="${f.description}"${f.example ? `, example="${f.example}"` : ""}`,
    )
    .join("\n");

  const schemaPrompt = `You are a schema-anchored information extraction system for "${schemaName}" documents (${schemaDescription}).

CRITICAL SCHEMA CONTRACT — You MUST extract ONLY these ${fields.length} fields. Do NOT add, remove, or rename any fields. This is the complete locked schema:
${fieldDefs}

For each field, return a JSON object with:
- "name": exactly the field name as listed above
- "value": the extracted value coerced to the declared type (null if not found)
- "confidence": a number 0.0-1.0 (1.0 = certain, 0.0 = not found/guessed)
- "present": true if the field was found, false if absent

Return ONLY a JSON array of ${fields.length} objects, one per field, in the exact order listed. No markdown, no explanation.`;

  const extractionResponse = await openai.chat.completions.create({
    model: "gpt-5.2",
    max_completion_tokens: 4096,
    messages: [
      {
        role: "system",
        content: schemaPrompt,
      },
      {
        role: "user",
        content: `Document raw text:\n\n${rawText}\n\nExtract the ${fields.length} schema fields now. Return only the JSON array.`,
      },
    ],
  });

  const extractionText = extractionResponse.choices[0]?.message?.content ?? "[]";

  let rawResults: Array<{ name: string; value: unknown; confidence: number; present: boolean }> = [];
  try {
    const jsonMatch = extractionText.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      rawResults = JSON.parse(jsonMatch[0]);
    }
  } catch {
    rawResults = [];
  }

  const resultMap = new Map(rawResults.map((r) => [r.name, r]));

  const extractedFields: ExtractionFieldResult[] = fields.map((field) => {
    const result = resultMap.get(field.name);
    return {
      name: field.name,
      label: field.label,
      value: result?.value ?? null,
      confidence: Math.min(1, Math.max(0, result?.confidence ?? 0)),
      present: result?.present ?? false,
    };
  });

  const processingTimeMs = Date.now() - startTime;

  return { rawText, fields: extractedFields, processingTimeMs };
}

export function computeOverallConfidence(fields: ExtractionFieldResult[]): number {
  if (fields.length === 0) return 0;
  const total = fields.reduce((sum, f) => sum + f.confidence, 0);
  return Math.round((total / fields.length) * 100) / 100;
}
