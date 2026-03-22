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

const EMBED_BATCH_SIZE = 20;
const MAX_CHUNK_CHARS = 800;

function truncate(text: string): string {
  return text.length > MAX_CHUNK_CHARS ? text.slice(0, MAX_CHUNK_CHARS) : text;
}

function makeChunks(text: string, label: string): Array<{ content: string; sectionLabel: string }> {
  const t = text.trim();
  if (!t) return [];
  if (t.length <= MAX_CHUNK_CHARS) return [{ content: t, sectionLabel: label }];
  const chunks: Array<{ content: string; sectionLabel: string }> = [];
  let start = 0;
  while (start < t.length) {
    chunks.push({ content: t.slice(start, start + MAX_CHUNK_CHARS), sectionLabel: label });
    start += MAX_CHUNK_CHARS - 100;
  }
  return chunks;
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: texts,
  });
  return response.data.map((d) => d.embedding);
}

async function flushChunks(
  projectId: number,
  projectDocumentId: number,
  documentType: string,
  documentId: number,
  batch: Array<{ content: string; sectionLabel: string }>,
  startIndex: number,
): Promise<void> {
  if (batch.length === 0) return;
  const embeddings = await embedBatch(batch.map((c) => c.content));
  await db.insert(documentChunksTable).values(
    batch.map((chunk, j) => ({
      projectId,
      projectDocumentId,
      documentType,
      documentId,
      chunkIndex: startIndex + j,
      content: chunk.content,
      sectionLabel: chunk.sectionLabel,
      embedding: embeddings[j],
    }))
  );
}

async function indexSpec(
  projectId: number,
  projectDocumentId: number,
  documentId: number,
): Promise<number> {
  const [row] = await db
    .select({ sections: specExtractionsTable.sections })
    .from(specExtractionsTable)
    .where(eq(specExtractionsTable.id, documentId));

  if (!row?.sections) return 0;
  const sections = row.sections as SpecSection[];

  let pending: Array<{ content: string; sectionLabel: string }> = [];
  let totalIndexed = 0;

  for (const section of sections) {
    const label = `${section.section_number} ${section.section_title} (${section.division_title})`;

    for (const part of section.parts) {
      for (const sub of part.subsections) {
        const text = `${label} / ${part.name} / ${sub.identifier}${sub.title ? " " + sub.title : ""}:\n${sub.content}`;
        pending.push(...makeChunks(text, label));
      }
    }

    if (section.full_text && section.parts.length === 0) {
      pending.push(...makeChunks(section.full_text, label));
    }

    while (pending.length >= EMBED_BATCH_SIZE) {
      const batch = pending.splice(0, EMBED_BATCH_SIZE);
      await flushChunks(projectId, projectDocumentId, "spec", documentId, batch, totalIndexed);
      totalIndexed += batch.length;
    }
  }

  if (pending.length > 0) {
    await flushChunks(projectId, projectDocumentId, "spec", documentId, pending, totalIndexed);
    totalIndexed += pending.length;
  }

  return totalIndexed;
}

async function indexConstruction(
  projectId: number,
  projectDocumentId: number,
  documentId: number,
): Promise<number> {
  const [row] = await db
    .select({ pages: constructionExtractionsTable.pages })
    .from(constructionExtractionsTable)
    .where(eq(constructionExtractionsTable.id, documentId));

  if (!row?.pages) return 0;
  const pages = row.pages as ConstructionPageResult[];

  let totalIndexed = 0;

  for (const page of pages) {
    const label = `Drawing Page ${page.page_number}${page.title_block.drawing_title ? " – " + page.title_block.drawing_title : ""}${page.title_block.sheet_number ? " (" + page.title_block.sheet_number + ")" : ""}`;
    const pending: Array<{ content: string; sectionLabel: string }> = [];

    if (page.general_notes.length > 0) {
      pending.push(...makeChunks(`${label} – General Notes:\n${page.general_notes.join("\n")}`, label));
    }
    if (page.callouts.length > 0) {
      const calloutText = page.callouts.map((c) => `[${c.type}] ${c.text}`).join("\n");
      pending.push(...makeChunks(`${label} – Callouts:\n${calloutText}`, label));
    }
    if (page.all_text) {
      pending.push(...makeChunks(`${label} – Full Text:\n${truncate(page.all_text)}`, label));
    }

    for (let i = 0; i < pending.length; i += EMBED_BATCH_SIZE) {
      const batch = pending.slice(i, i + EMBED_BATCH_SIZE);
      await flushChunks(projectId, projectDocumentId, "construction", documentId, batch, totalIndexed);
      totalIndexed += batch.length;
    }
  }

  return totalIndexed;
}

async function indexFinancial(
  projectId: number,
  projectDocumentId: number,
  documentId: number,
): Promise<number> {
  const [row] = await db
    .select({ documents: financialExtractionsTable.documents })
    .from(financialExtractionsTable)
    .where(eq(financialExtractionsTable.id, documentId));

  if (!row?.documents) return 0;
  const docs = row.documents as FinancialDocument[];

  let totalIndexed = 0;

  for (const doc of docs) {
    const label = `${doc.type} (pages ${doc.page_start}–${doc.page_end})`;
    const pending: Array<{ content: string; sectionLabel: string }> = [];

    const fieldLines = Object.entries(doc.fields)
      .filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
    if (fieldLines) pending.push(...makeChunks(`${label} – Fields:\n${fieldLines}`, label));

    if (doc.line_items.length > 0) {
      const lineText = doc.line_items
        .map((li) => [
          li.description,
          li.quantity ? `qty: ${li.quantity}` : "",
          li.unit ? `unit: ${li.unit}` : "",
          li.unit_price ? `unit price: ${li.unit_price}` : "",
          li.extension ? `extension: ${li.extension}` : "",
          li.rate ? `rate: ${li.rate}` : "",
          li.part_number ? `part#: ${li.part_number}` : "",
        ].filter(Boolean).join(", "))
        .join("\n");
      pending.push(...makeChunks(`${label} – Line Items:\n${lineText}`, label));
    }

    const totalLines = Object.entries(doc.totals)
      .filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
    if (totalLines) pending.push(...makeChunks(`${label} – Totals:\n${totalLines}`, label));

    for (let i = 0; i < pending.length; i += EMBED_BATCH_SIZE) {
      const batch = pending.slice(i, i + EMBED_BATCH_SIZE);
      await flushChunks(projectId, projectDocumentId, "financial", documentId, batch, totalIndexed);
      totalIndexed += batch.length;
    }
  }

  return totalIndexed;
}

async function indexOcr(
  projectId: number,
  projectDocumentId: number,
  documentId: number,
): Promise<number> {
  const [row] = await db
    .select({ fileName: extractionsTable.fileName, rawText: extractionsTable.rawText, fields: extractionsTable.fields })
    .from(extractionsTable)
    .where(eq(extractionsTable.id, documentId));

  if (!row) return 0;

  const label = row.fileName;
  const pending: Array<{ content: string; sectionLabel: string }> = [];

  if (row.rawText) pending.push(...makeChunks(`${label} – Raw OCR:\n${row.rawText}`, label));

  if (row.fields && typeof row.fields === "object") {
    const fieldLines = Object.entries(row.fields as Record<string, unknown>)
      .filter(([, v]) => v != null)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join("\n");
    if (fieldLines) pending.push(...makeChunks(`${label} – Extracted Fields:\n${fieldLines}`, label));
  }

  let totalIndexed = 0;
  for (let i = 0; i < pending.length; i += EMBED_BATCH_SIZE) {
    const batch = pending.slice(i, i + EMBED_BATCH_SIZE);
    await flushChunks(projectId, projectDocumentId, "ocr", documentId, batch, totalIndexed);
    totalIndexed += batch.length;
  }

  return totalIndexed;
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
    await db
      .delete(documentChunksTable)
      .where(
        and(
          eq(documentChunksTable.projectDocumentId, projectDocumentId),
          eq(documentChunksTable.projectId, projectId),
        )
      );

    let totalIndexed = 0;

    if (documentType === "spec") {
      totalIndexed = await indexSpec(projectId, projectDocumentId, documentId);
    } else if (documentType === "construction") {
      totalIndexed = await indexConstruction(projectId, projectDocumentId, documentId);
    } else if (documentType === "financial") {
      totalIndexed = await indexFinancial(projectId, projectDocumentId, documentId);
    } else if (documentType === "ocr") {
      totalIndexed = await indexOcr(projectId, projectDocumentId, documentId);
    }

    await db
      .update(projectDocumentsTable)
      .set({ indexStatus: "indexed", chunkCount: totalIndexed })
      .where(eq(projectDocumentsTable.id, projectDocumentId));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    await db
      .update(projectDocumentsTable)
      .set({ indexStatus: "failed", errorMessage: msg.slice(0, 500) })
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
    .select({
      id: documentChunksTable.id,
      content: documentChunksTable.content,
      sectionLabel: documentChunksTable.sectionLabel,
      documentType: documentChunksTable.documentType,
      projectDocumentId: documentChunksTable.projectDocumentId,
      embedding: documentChunksTable.embedding,
    })
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

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: texts,
  });
  return response.data.map((d) => d.embedding);
}
