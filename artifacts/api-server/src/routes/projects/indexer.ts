import { db } from "@workspace/db";
import {
  specExtractionsTable,
  constructionExtractionsTable,
  financialExtractionsTable,
  extractionsTable,
  documentChunksTable,
  projectDocumentsTable,
  type SpecSection,
  type ConstructionPageResult,
  type FinancialDocument,
} from "@workspace/db";
import { openai } from "@workspace/integrations-openai-ai-server";
import { eq, and } from "drizzle-orm";

const CHUNK_OVERLAP = 50;
const MAX_CHUNK_LENGTH = 1200;

function splitIntoChunks(text: string, sectionLabel: string): Array<{ content: string; sectionLabel: string }> {
  const trimmed = text.trim();
  if (!trimmed) return [];

  if (trimmed.length <= MAX_CHUNK_LENGTH) {
    return [{ content: trimmed, sectionLabel }];
  }

  const chunks: Array<{ content: string; sectionLabel: string }> = [];
  let start = 0;
  while (start < trimmed.length) {
    const end = Math.min(start + MAX_CHUNK_LENGTH, trimmed.length);
    const chunk = trimmed.slice(start, end);
    chunks.push({ content: chunk, sectionLabel });
    start = end - CHUNK_OVERLAP;
    if (start >= trimmed.length) break;
  }
  return chunks;
}

async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: texts,
  });
  return response.data.map((d) => d.embedding);
}

function chunksFromSpec(sections: SpecSection[]): Array<{ content: string; sectionLabel: string }> {
  const chunks: Array<{ content: string; sectionLabel: string }> = [];
  for (const section of sections) {
    const label = `${section.section_number} ${section.section_title} (${section.division_title})`;
    for (const part of section.parts) {
      for (const sub of part.subsections) {
        const text = `${label} / ${part.name} / ${sub.identifier}${sub.title ? " " + sub.title : ""}:\n${sub.content}`;
        chunks.push(...splitIntoChunks(text, label));
      }
    }
    if (section.full_text && section.parts.length === 0) {
      chunks.push(...splitIntoChunks(section.full_text, label));
    }
  }
  return chunks;
}

function chunksFromConstruction(pages: ConstructionPageResult[]): Array<{ content: string; sectionLabel: string }> {
  const chunks: Array<{ content: string; sectionLabel: string }> = [];
  for (const page of pages) {
    const label = `Drawing Page ${page.page_number}${page.title_block.drawing_title ? " – " + page.title_block.drawing_title : ""}${page.title_block.sheet_number ? " (" + page.title_block.sheet_number + ")" : ""}`;

    if (page.general_notes.length > 0) {
      const text = `${label} – General Notes:\n${page.general_notes.join("\n")}`;
      chunks.push(...splitIntoChunks(text, label));
    }

    if (page.callouts.length > 0) {
      const text = `${label} – Callouts:\n${page.callouts.map((c) => `[${c.type}] ${c.text}`).join("\n")}`;
      chunks.push(...splitIntoChunks(text, label));
    }

    if (page.all_text) {
      chunks.push(...splitIntoChunks(`${label} – Full Text:\n${page.all_text}`, label));
    }
  }
  return chunks;
}

function chunksFromFinancial(documents: FinancialDocument[]): Array<{ content: string; sectionLabel: string }> {
  const chunks: Array<{ content: string; sectionLabel: string }> = [];
  for (const doc of documents) {
    const label = `${doc.type} (pages ${doc.page_start}–${doc.page_end})`;

    const fieldLines = Object.entries(doc.fields)
      .filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
    if (fieldLines) chunks.push(...splitIntoChunks(`${label} – Fields:\n${fieldLines}`, label));

    if (doc.line_items.length > 0) {
      const lineText = doc.line_items
        .map((li) => {
          const parts = [li.description];
          if (li.quantity) parts.push(`qty: ${li.quantity}`);
          if (li.unit) parts.push(`unit: ${li.unit}`);
          if (li.unit_price) parts.push(`unit price: ${li.unit_price}`);
          if (li.extension) parts.push(`extension: ${li.extension}`);
          if (li.rate) parts.push(`rate: ${li.rate}`);
          if (li.part_number) parts.push(`part#: ${li.part_number}`);
          return parts.join(", ");
        })
        .join("\n");
      chunks.push(...splitIntoChunks(`${label} – Line Items:\n${lineText}`, label));
    }

    const totalLines = Object.entries(doc.totals)
      .filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
    if (totalLines) chunks.push(...splitIntoChunks(`${label} – Totals:\n${totalLines}`, label));

    if (doc.raw_text) {
      chunks.push(...splitIntoChunks(`${label} – Raw Text:\n${doc.raw_text}`, label));
    }
  }
  return chunks;
}

async function chunksFromOcr(extractionId: number): Promise<Array<{ content: string; sectionLabel: string }>> {
  const [row] = await db
    .select()
    .from(extractionsTable)
    .where(eq(extractionsTable.id, extractionId));
  if (!row) return [];

  const chunks: Array<{ content: string; sectionLabel: string }> = [];
  const label = row.fileName;

  if (row.rawText) {
    chunks.push(...splitIntoChunks(`${label} – Raw OCR:\n${row.rawText}`, label));
  }

  if (row.fields && typeof row.fields === "object") {
    const fieldLines = Object.entries(row.fields as Record<string, unknown>)
      .filter(([, v]) => v != null)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join("\n");
    if (fieldLines) {
      chunks.push(...splitIntoChunks(`${label} – Extracted Fields:\n${fieldLines}`, label));
    }
  }

  return chunks;
}

export async function indexProjectDocument(
  projectId: number,
  projectDocumentId: number,
  documentType: string,
  documentId: number,
): Promise<void> {
  await db
    .update(projectDocumentsTable)
    .set({ indexStatus: "indexing" })
    .where(eq(projectDocumentsTable.id, projectDocumentId));

  try {
    let rawChunks: Array<{ content: string; sectionLabel: string }> = [];

    if (documentType === "spec") {
      const [row] = await db
        .select()
        .from(specExtractionsTable)
        .where(eq(specExtractionsTable.id, documentId));
      if (row?.sections) {
        rawChunks = chunksFromSpec(row.sections as SpecSection[]);
      }
    } else if (documentType === "construction") {
      const [row] = await db
        .select()
        .from(constructionExtractionsTable)
        .where(eq(constructionExtractionsTable.id, documentId));
      if (row?.pages) {
        rawChunks = chunksFromConstruction(row.pages as ConstructionPageResult[]);
      }
    } else if (documentType === "financial") {
      const [row] = await db
        .select()
        .from(financialExtractionsTable)
        .where(eq(financialExtractionsTable.id, documentId));
      if (row?.documents) {
        rawChunks = chunksFromFinancial(row.documents as FinancialDocument[]);
      }
    } else if (documentType === "ocr") {
      rawChunks = await chunksFromOcr(documentId);
    }

    await db
      .delete(documentChunksTable)
      .where(
        and(
          eq(documentChunksTable.projectDocumentId, projectDocumentId),
          eq(documentChunksTable.projectId, projectId),
        )
      );

    const BATCH_SIZE = 50;
    let chunkIndex = 0;
    let totalIndexed = 0;

    for (let i = 0; i < rawChunks.length; i += BATCH_SIZE) {
      const batch = rawChunks.slice(i, i + BATCH_SIZE);
      const texts = batch.map((c) => c.content);
      const embeddings = await embedTexts(texts);

      await db.insert(documentChunksTable).values(
        batch.map((chunk, j) => ({
          projectId,
          projectDocumentId,
          documentType,
          documentId,
          chunkIndex: chunkIndex + j,
          content: chunk.content,
          sectionLabel: chunk.sectionLabel,
          embedding: embeddings[j],
        }))
      );

      chunkIndex += batch.length;
      totalIndexed += batch.length;
    }

    await db
      .update(projectDocumentsTable)
      .set({ indexStatus: "indexed", chunkCount: totalIndexed })
      .where(eq(projectDocumentsTable.id, projectDocumentId));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    await db
      .update(projectDocumentsTable)
      .set({ indexStatus: "failed", errorMessage: msg })
      .where(eq(projectDocumentsTable.id, projectDocumentId));
    throw err;
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function semanticSearch(
  projectId: number,
  questionEmbedding: number[],
  topK = 8,
): Promise<Array<{ content: string; sectionLabel: string | null; documentName: string; documentType: string; score: number }>> {
  const chunks = await db
    .select()
    .from(documentChunksTable)
    .where(eq(documentChunksTable.projectId, projectId));

  const scored = chunks
    .filter((c) => c.embedding != null)
    .map((c) => ({
      content: c.content,
      sectionLabel: c.sectionLabel,
      documentType: c.documentType,
      projectDocumentId: c.projectDocumentId,
      score: cosineSimilarity(questionEmbedding, c.embedding as number[]),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  const docIds = [...new Set(scored.map((s) => s.projectDocumentId))];
  const docs = await db
    .select({ id: projectDocumentsTable.id, documentName: projectDocumentsTable.documentName })
    .from(projectDocumentsTable)
    .where(eq(projectDocumentsTable.projectId, projectId));

  const docMap = new Map(docs.map((d) => [d.id, d.documentName]));

  return scored.map((s) => ({
    content: s.content,
    sectionLabel: s.sectionLabel,
    documentName: docMap.get(s.projectDocumentId) ?? "Unknown",
    documentType: s.documentType,
    score: s.score,
  }));
}

export { embedTexts };
