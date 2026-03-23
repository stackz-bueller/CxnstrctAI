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
import { eq, and, sql } from "drizzle-orm";
import { embed } from "../../lib/embedder.js";

const MAX_CHUNK_CHARS = 900;
const DB_BATCH_SIZE = 30;

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

async function insertBatch(
  projectId: number,
  projectDocumentId: number,
  documentType: string,
  documentId: number,
  batch: Array<{ content: string; sectionLabel: string }>,
  startIndex: number,
): Promise<void> {
  if (batch.length === 0) return;

  const inserted = await db.insert(documentChunksTable).values(
    batch.map((chunk, j) => ({
      projectId,
      projectDocumentId,
      documentType,
      documentId,
      chunkIndex: startIndex + j,
      content: chunk.content,
      sectionLabel: chunk.sectionLabel,
      embedding: null,
    }))
  ).returning({ id: documentChunksTable.id });

  try {
    const texts = batch.map((c) => c.content);
    const vectors = await embed(texts);
    for (let i = 0; i < inserted.length; i++) {
      const vec = vectors[i];
      if (!vec) continue;
      await db.execute(sql`
        UPDATE document_chunks
        SET embedding = ${`[${vec.join(",")}]`}::vector
        WHERE id = ${inserted[i].id}
      `);
    }
  } catch (embErr) {
    console.error("Embedding generation failed for batch, storing without vectors:", embErr);
  }
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

    while (pending.length >= DB_BATCH_SIZE) {
      const batch = pending.splice(0, DB_BATCH_SIZE);
      await insertBatch(projectId, projectDocumentId, "spec", documentId, batch, totalIndexed);
      totalIndexed += batch.length;
    }
  }

  if (pending.length > 0) {
    await insertBatch(projectId, projectDocumentId, "spec", documentId, pending, totalIndexed);
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
      pending.push(...makeChunks(`${label} – Full Text:\n${page.all_text}`, label));
    }

    if (pending.length > 0) {
      await insertBatch(projectId, projectDocumentId, "construction", documentId, pending, totalIndexed);
      totalIndexed += pending.length;
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

    if (pending.length > 0) {
      await insertBatch(projectId, projectDocumentId, "financial", documentId, pending, totalIndexed);
      totalIndexed += pending.length;
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

  if (pending.length > 0) {
    await insertBatch(projectId, projectDocumentId, "ocr", documentId, pending, 0);
  }

  return pending.length;
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
    if (documentType === "spec") totalIndexed = await indexSpec(projectId, projectDocumentId, documentId);
    else if (documentType === "construction") totalIndexed = await indexConstruction(projectId, projectDocumentId, documentId);
    else if (documentType === "financial") totalIndexed = await indexFinancial(projectId, projectDocumentId, documentId);
    else if (documentType === "ocr") totalIndexed = await indexOcr(projectId, projectDocumentId, documentId);

    await db
      .update(projectDocumentsTable)
      .set({ indexStatus: "indexed", chunkCount: totalIndexed, errorMessage: null })
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

type SearchRow = {
  content: string;
  sectionLabel: string | null;
  documentName: string;
  documentType: string;
  score: number;
};

const STOP_WORDS = new Set([
  "the", "is", "are", "was", "were", "for", "and", "that", "this", "with",
  "from", "what", "how", "can", "does", "did", "has", "have", "will", "not",
  "but", "its", "any", "all", "out", "get", "use", "our", "you", "his",
  "her", "they", "them", "who", "him", "she", "her", "which", "when",
  "then", "than", "into", "more", "also", "been", "each", "about", "per",
]);

async function getDocMap(projectId: number): Promise<Map<number, string>> {
  const docs = await db
    .select({ id: projectDocumentsTable.id, documentName: projectDocumentsTable.documentName })
    .from(projectDocumentsTable)
    .where(eq(projectDocumentsTable.projectId, projectId));
  return new Map(docs.map((d) => [d.id, d.documentName]));
}

async function vectorSearch(projectId: number, question: string, topK: number): Promise<SearchRow[]> {
  const [queryVec] = await embed([question]);
  if (!queryVec) return [];

  const vecStr = `[${queryVec.join(",")}]`;

  const rows = await db.execute<{
    content: string;
    section_label: string | null;
    document_type: string;
    project_document_id: number;
    score: number;
  }>(sql`
    SELECT
      content,
      section_label,
      document_type,
      project_document_id,
      1 - (embedding <=> ${vecStr}::vector) AS score
    FROM document_chunks
    WHERE project_id = ${projectId}
      AND embedding IS NOT NULL
    ORDER BY embedding <=> ${vecStr}::vector
    LIMIT ${topK}
  `);

  if (rows.rows.length === 0) return [];

  const docMap = await getDocMap(projectId);
  return rows.rows.map((r) => ({
    content: r.content,
    sectionLabel: r.section_label,
    documentName: docMap.get(r.project_document_id) ?? "Unknown",
    documentType: r.document_type,
    score: Number(r.score),
  }));
}

async function ftsSearch(projectId: number, question: string, topK: number): Promise<SearchRow[]> {
  const words = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
    .slice(0, 20);

  if (words.length === 0) return [];
  const tsquery = words.map((w) => `${w}:*`).join(" | ");

  const results = await db.execute<{
    content: string;
    section_label: string | null;
    document_type: string;
    project_document_id: number;
    rank: number;
  }>(sql`
    SELECT
      content,
      section_label,
      document_type,
      project_document_id,
      ts_rank(to_tsvector('english', content), to_tsquery('english', ${tsquery})) AS rank
    FROM document_chunks
    WHERE
      project_id = ${projectId}
      AND to_tsvector('english', content) @@ to_tsquery('english', ${tsquery})
    ORDER BY rank DESC
    LIMIT ${topK}
  `);

  if (results.rows.length === 0) {
    const topWords = words.slice(0, 6);
    const fallback = await db.execute<{
      content: string;
      section_label: string | null;
      document_type: string;
      project_document_id: number;
    }>(sql`
      SELECT content, section_label, document_type, project_document_id
      FROM document_chunks
      WHERE project_id = ${projectId}
        AND (${sql.join(
          topWords.map((w) => sql`content ILIKE ${"%" + w + "%"}`),
          sql` OR `,
        )})
      LIMIT ${topK * 3}
    `);
    const ranked = fallback.rows
      .map((r) => {
        const lower = r.content.toLowerCase();
        const hits = topWords.filter((w) => lower.includes(w)).length;
        return { ...r, rank: hits / topWords.length };
      })
      .sort((a, b) => b.rank - a.rank)
      .slice(0, topK);
    results.rows.push(...ranked);
  }

  if (results.rows.length === 0) return [];
  const docMap = await getDocMap(projectId);
  return results.rows.map((r) => ({
    content: r.content,
    sectionLabel: r.section_label,
    documentName: docMap.get(r.project_document_id) ?? "Unknown",
    documentType: r.document_type,
    score: Number(r.rank),
  }));
}

/**
 * Semantic search: uses pgvector cosine similarity as primary strategy,
 * falls back to full-text search if embeddings are not yet generated.
 */
export async function keywordSearch(
  projectId: number,
  question: string,
  topK = 10,
): Promise<SearchRow[]> {
  const hasEmbedding = await db.execute<{ cnt: string }>(sql`
    SELECT COUNT(*) AS cnt FROM document_chunks
    WHERE project_id = ${projectId} AND embedding IS NOT NULL
    LIMIT 1
  `);
  const embeddedCount = Number(hasEmbedding.rows[0]?.cnt ?? 0);

  if (embeddedCount > 0) {
    try {
      const results = await vectorSearch(projectId, question, topK);
      if (results.length > 0) return results;
    } catch (e) {
      console.error("Vector search failed, falling back to FTS:", e);
    }
  }

  return ftsSearch(projectId, question, topK);
}
