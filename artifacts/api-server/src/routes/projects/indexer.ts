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

const MAX_CHUNK_CHARS = 1500;
const CHUNK_OVERLAP = 150;
const DB_BATCH_SIZE = 30;

const STANDARD_PIPE_SIZES = new Set([4, 6, 8, 10, 12, 15, 18, 21, 24, 27, 30, 36, 42, 48, 54, 60, 72]);

export interface DataQualityWarning {
  type: "missing_sequential_id" | "non_standard_pipe_size" | "truncated_table";
  page: number;
  table: string;
  detail: string;
}

export function validateConstructionData(pages: ConstructionPageResult[]): DataQualityWarning[] {
  const warnings: DataQualityWarning[] = [];

  const allIds: Map<string, { num: number; page: number; table: string }[]> = new Map();

  for (const page of pages) {
    const tables = page.tables || [];
    for (const table of tables) {
      const title = table.title || "";
      const rows = table.rows || [];
      const headers = table.headers || [];

      const isPipeTable = /pipe/i.test(title) || /drainage.*pipe/i.test(title);
      const diamIdx = isPipeTable
        ? headers.findIndex(
            (h) => /diam/i.test(h) || /size/i.test(h) || h.toLowerCase() === "in"
          )
        : -1;

      for (const row of rows) {
        const id = row[0] || "";
        const match = id.match(/^([A-Za-z]+\d*)-(\d+)$/);
        if (match) {
          const prefix = match[1].toUpperCase();
          const num = parseInt(match[2], 10);
          if (!allIds.has(prefix)) allIds.set(prefix, []);
          allIds.get(prefix)!.push({ num, page: page.page_number, table: title });
        }

        if (diamIdx >= 0 && diamIdx < row.length) {
          const val = String(row[diamIdx]).replace(/['"]/g, "").trim();
          const diam = parseInt(val, 10);
          if (!isNaN(diam) && diam > 0 && diam <= 120 && !STANDARD_PIPE_SIZES.has(diam)) {
            warnings.push({
              type: "non_standard_pipe_size",
              page: page.page_number,
              table: title,
              detail: `${id} has non-standard diameter ${diam}" (nearest standard: ${[...STANDARD_PIPE_SIZES].filter(s => Math.abs(s - diam) <= 6).join(", ") || "none"})`,
            });
          }
        }
      }

      if (rows.length >= 15 && isPipeTable) {
        const lastRow = rows[rows.length - 1];
        const lastId = lastRow[0] || "";
        const lastMatch = lastId.match(/^([A-Za-z]+\d*)-(\d+)$/);
        if (lastMatch) {
          const lastPrefix = lastMatch[1].toUpperCase();
          const lastNum = parseInt(lastMatch[2], 10);
          const prefixEntries = allIds.get(lastPrefix) || [];
          const maxNum = Math.max(...prefixEntries.map(e => e.num), lastNum);
          if (maxNum === lastNum && lastNum > 1) {
            const seqNums = prefixEntries.map(e => e.num).sort((a, b) => a - b);
            const expectedCount = seqNums[seqNums.length - 1] - seqNums[0] + 1;
            const actualCount = seqNums.length;
            const isSuspiciouslyRound = rows.length % 5 === 0 || rows.length % 10 === 0;
            const hasMissingEntries = actualCount < expectedCount * 0.85;
            if (isSuspiciouslyRound || hasMissingEntries) {
              warnings.push({
                type: "truncated_table",
                page: page.page_number,
                table: title,
                detail: `Table ends at ${lastId} with ${rows.length} rows (expected ~${expectedCount} based on ID range) — verify no data was cut off`,
              });
            }
          }
        }
      }
    }
  }

  for (const [prefix, entries] of allIds) {
    if (entries.length < 3) continue;
    const nums = entries.map((e) => e.num).sort((a, b) => a - b);
    for (let i = 1; i < nums.length; i++) {
      const gap = nums[i] - nums[i - 1];
      if (gap > 1) {
        const missing = [];
        for (let n = nums[i - 1] + 1; n < nums[i]; n++) {
          missing.push(`${prefix}-${String(n).padStart(2, "0")}`);
        }
        if (missing.length <= 5) {
          warnings.push({
            type: "missing_sequential_id",
            page: entries[0].page,
            table: entries[0].table,
            detail: `Gap in ${prefix} sequence: missing ${missing.join(", ")} (have ${prefix}-${String(nums[i - 1]).padStart(2, "0")} then ${prefix}-${String(nums[i]).padStart(2, "0")})`,
          });
        }
      }
    }
  }

  return warnings;
}

function makeChunks(text: string, label: string): Array<{ content: string; sectionLabel: string }> {
  const t = text.trim();
  if (!t) return [];
  if (t.length <= MAX_CHUNK_CHARS) return [{ content: t, sectionLabel: label }];

  const chunks: Array<{ content: string; sectionLabel: string }> = [];
  let start = 0;
  while (start < t.length) {
    let end = Math.min(start + MAX_CHUNK_CHARS, t.length);
    if (end < t.length) {
      const windowStart = Math.max(start + MAX_CHUNK_CHARS - 200, start);
      const window = t.slice(windowStart, end);
      const sentenceEnd = window.lastIndexOf(". ");
      if (sentenceEnd > 0) {
        end = windowStart + sentenceEnd + 2;
      } else {
        const newlineEnd = window.lastIndexOf("\n");
        if (newlineEnd > 0) {
          end = windowStart + newlineEnd + 1;
        }
      }
    }
    chunks.push({ content: t.slice(start, end), sectionLabel: label });
    if (end >= t.length) break;
    start = end - CHUNK_OVERLAP;
    if (t.length - start <= CHUNK_OVERLAP) break;
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
    const cases: string[] = [];
    const ids: number[] = [];
    for (let i = 0; i < inserted.length; i++) {
      const vec = vectors[i];
      if (!vec || vec.some((v) => !Number.isFinite(v))) continue;
      ids.push(inserted[i].id);
      cases.push(`WHEN ${inserted[i].id} THEN '[${vec.join(",")}]'::vector`);
    }
    if (cases.length > 0) {
      await db.execute(sql.raw(
        `UPDATE document_chunks SET embedding = CASE id ${cases.join(" ")} END WHERE id IN (${ids.join(",")})`
      ));
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

  const titleBlockSummaries: string[] = [];

  for (const page of pages) {
    const isVoided = !!(page as Record<string, unknown>).voided;
    const voidedReason = ((page as Record<string, unknown>).voided_reason as string) || "Page crossed out / removed from project";
    const voidPrefix = isVoided ? "[VOIDED/REMOVED FROM PROJECT] " : "";
    const label = `${voidPrefix}Drawing Page ${page.page_number}${page.title_block.drawing_title ? " – " + page.title_block.drawing_title : ""}${page.title_block.sheet_number ? " (" + page.title_block.sheet_number + ")" : ""}`;
    const pending: Array<{ content: string; sectionLabel: string }> = [];

    if (isVoided) {
      pending.push({
        content: `${label}\n⚠️ THIS PAGE HAS BEEN VOIDED/REMOVED FROM THE PROJECT. Reason: ${voidedReason}. Data from this page should NOT be used for current project scope, quantities, or specifications. It represents work that was removed or superseded.`,
        sectionLabel: label,
      });
    }

    const tb = page.title_block;
    if (tb) {
      const tbFields: string[] = [];
      if (tb.project_name) tbFields.push(`Project: ${tb.project_name}`);
      if (tb.drawing_title) tbFields.push(`Drawing: ${tb.drawing_title}`);
      if (tb.sheet_number) tbFields.push(`Sheet: ${tb.sheet_number}`);
      if (tb.revision) tbFields.push(`Revision: ${tb.revision}`);
      if (tb.date) tbFields.push(`Date: ${tb.date}`);
      if (tb.drawn_by) tbFields.push(`Drawn By: ${tb.drawn_by}`);
      if (tb.scale) tbFields.push(`Scale: ${tb.scale}`);
      if (tbFields.length > 0) {
        titleBlockSummaries.push(`${label}: ${tbFields.join(", ")}`);
      }
    }

    const revHistory = page.revision_history || [];
    if (revHistory.length > 0) {
      const revText = revHistory
        .map((r) =>
          `Rev ${r.rev_number || "?"}: ${r.date || ""} — ${r.description || ""}`)
        .join("\n");
      pending.push(...makeChunks(`${label} – Revision History:\n${revText}`, label));
    }

    if (page.general_notes.length > 0) {
      pending.push(...makeChunks(`${label} – General Notes:\n${page.general_notes.join("\n")}`, label));
    }
    const legends = (page as Record<string, unknown>).legends as Array<{ symbol?: string; description?: string }> | undefined;
    if (legends && legends.length > 0) {
      const legendText = legends
        .map((l) => `${l.symbol || "?"}: ${l.description || ""}`)
        .join("\n");
      pending.push(...makeChunks(`${label} – Legend:\n${legendText}`, label));
    }
    const peStamps = (page as Record<string, unknown>).pe_stamps as Array<{
      name?: string; license_number?: string; state?: string;
      expiration?: string; discipline?: string; firm?: string;
    }> | undefined;
    if (peStamps && peStamps.length > 0) {
      const peText = peStamps
        .map((s) => {
          const parts: string[] = [];
          if (s.name) parts.push(`Professional Engineer: ${s.name}`);
          if (s.license_number) parts.push(`License No. ${s.license_number}`);
          if (s.state) parts.push(`State: ${s.state}`);
          if (s.expiration) parts.push(`Expiration: ${s.expiration}`);
          if (s.discipline) parts.push(`Discipline: ${s.discipline}`);
          if (s.firm) parts.push(`Firm: ${s.firm}`);
          return parts.join(" | ");
        })
        .join("\n");
      pending.push(...makeChunks(`${label} – PE Stamps/Seals:\n${peText}`, label));
    }
    const firmInfo = (page as Record<string, unknown>).firm_info as {
      name?: string; address?: string; phone?: string;
    } | undefined;
    if (firmInfo && (firmInfo.name || firmInfo.address || firmInfo.phone)) {
      const firmParts: string[] = [];
      if (firmInfo.name) firmParts.push(`Engineering Firm: ${firmInfo.name}`);
      if (firmInfo.address) firmParts.push(`Address: ${firmInfo.address}`);
      if (firmInfo.phone) firmParts.push(`Phone: ${firmInfo.phone}`);
      if (firmParts.length > 0) {
        pending.push(...makeChunks(`${label} – Firm Info:\n${firmParts.join("\n")}`, label));
      }
    }
    const tables = page.tables;
    if (tables && tables.length > 0) {
      for (const table of tables) {
        let tableText = table.title ? `Table: ${table.title}\n` : "";
        if (table.headers && table.rows && table.rows.length > 0) {
          tableText += table.headers.join(" | ") + "\n";
          for (const row of table.rows) {
            tableText += row.join(" | ") + "\n";
          }
        } else if (table.raw_text) {
          tableText += table.raw_text;
        }
        if (tableText.trim()) {
          pending.push(...makeChunks(`${label} – Table Data:\n${tableText}`, label));
        }
      }
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

  if (titleBlockSummaries.length > 0) {
    const tbChunkText = `PROJECT DRAWING TITLE BLOCKS AND PROFESSIONAL ENGINEER INFORMATION:\n` +
      titleBlockSummaries.join("\n");
    const tbChunks = makeChunks(tbChunkText, "Drawing Title Blocks");
    await insertBatch(projectId, projectDocumentId, "construction", documentId, tbChunks, totalIndexed);
    totalIndexed += tbChunks.length;
  }

  const peStampBlocks: string[] = [];
  for (const page of pages) {
    const text = page.all_text || "";
    const stampMatch = text.match(/PROFESSIONAL ENGINEER STAMP[^\n]*\n(?:[\s\S]*?)(?=\n\n|\nPROFESSIONAL ENGINEER STAMP|$)/g);
    if (stampMatch) {
      for (const block of stampMatch) {
        peStampBlocks.push(`Page ${page.page_number} (${page.title_block?.sheet_number || "Cover"}):\n${block.trim()}`);
      }
    }
  }
  if (peStampBlocks.length > 0) {
    const peText = `PROFESSIONAL ENGINEERS OF RECORD FOR THIS PROJECT:\n\n` +
      peStampBlocks.join("\n\n");
    const peChunks = makeChunks(peText, "Professional Engineers of Record");
    await insertBatch(projectId, projectDocumentId, "construction", documentId, peChunks, totalIndexed);
    totalIndexed += peChunks.length;
  }

  const allWarnings: string[] = [];

  const validationWarnings = validateConstructionData(pages);
  for (const w of validationWarnings) {
    allWarnings.push(`[${w.type}] Page ${w.page}, ${w.table}: ${w.detail}`);
  }

  for (const page of pages) {
    const pageAny = page as Record<string, unknown>;
    const extractionWarnings = pageAny._data_warnings;
    if (Array.isArray(extractionWarnings)) {
      for (const ew of extractionWarnings) {
        allWarnings.push(`[extraction_conflict] Page ${page.page_number}: ${ew}`);
      }
    }
  }

  if (allWarnings.length > 0) {
    const warningText = `DATA QUALITY WARNINGS (auto-generated during indexing):\n` +
      allWarnings.map((w) => `- ${w}`).join("\n");
    const warningChunks = makeChunks(warningText, "Data Quality Warnings");
    await insertBatch(projectId, projectDocumentId, "construction", documentId, warningChunks, totalIndexed);
    totalIndexed += warningChunks.length;
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
    const fieldLines = Object.entries(row.fields as unknown as Record<string, unknown>)
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
  "type", "used", "many", "much", "where", "there", "would", "could",
  "should", "tell", "give", "show", "list", "find", "know", "need",
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
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w))
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

const CONSTRUCTION_SYNONYMS: Record<string, string[]> = {
  "invert": ["invert", "bottom elevation", "invert elevation", "inv elev", "inv."],
  "rim": ["rim", "rim elevation", "top elevation", "tc/rim", "tc elevation"],
  "diameter": ["diameter", "size", "pipe size", "diam"],
  "manhole": ["manhole", "mh", "junction box"],
  "inlet": ["inlet", "catch basin", "cb"],
  "bioretention": ["bioretention", "bio", "rain garden"],
  "detention": ["detention", "detention basin", "subsurface detention"],
  "seeding": ["seeding", "seed", "planting", "landscaping", "formula mix"],
  "located": ["located", "location", "site address", "street", "municipality", "borough", "township", "county", "state", "title block", "cover sheet", "site plan"],
  "address": ["address", "site address", "street", "avenue", "location", "title block", "site plan"],
  "where": ["location", "site address", "municipality", "county", "title block"],
  "engineer": ["engineer", "professional engineer", "PE", "engineer of record", "PE stamp", "licensed engineer", "sealed by"],
  "engineer of record": ["engineer of record", "professional engineer", "PE stamp", "PE license", "sealed by", "designed by", "drawn by"],
  "pe": ["professional engineer", "PE stamp", "PE license", "engineer of record", "sealed"],
  "who": ["engineer", "professional engineer", "drawn by", "designed by", "prepared by", "PE stamp"],
  "stamped": ["stamped", "sealed", "professional engineer", "PE stamp", "engineer of record"],
  "lf": ["lf", "linear feet", "linear foot", "lineal feet", "lin ft", "l.f."],
  "sf": ["sf", "square feet", "square foot", "sq ft", "s.f."],
  "cy": ["cy", "cubic yards", "cubic yard", "cu yd", "c.y."],
  "sy": ["sy", "square yards", "square yard", "sq yd", "s.y."],
  "ls": ["ls", "lump sum", "l.s."],
  "ea": ["ea", "each"],
  "repoint": ["repoint", "repointing", "pointing", "tuckpoint", "tuckpointing", "mortar joint", "joint repair"],
  "masonry": ["masonry", "stone", "brick", "mortar", "repoint", "tuckpoint", "veneer"],
  "quantity": ["quantity", "qty", "total", "amount", "measurement", "pay item", "bid item", "line item", "schedule of values"],
  "concrete": ["concrete", "cast-in-place", "CIP", "reinforced concrete", "structural concrete"],
  "rebar": ["rebar", "reinforcing", "reinforcement", "reinforcing steel", "bar"],
  "excavation": ["excavation", "earthwork", "grading", "cut", "fill", "backfill"],
  "demolition": ["demolition", "removal", "remove", "dismantle", "abatement"],
  "waterproofing": ["waterproofing", "membrane", "dampproofing", "coating", "sealant"],
  "restoration": ["restoration", "rehabilitation", "repair", "reconstruction"],
  "bridge": ["bridge", "undergrade", "overgrade", "UG", "OG", "span", "structure"],
};

function expandSynonyms(question: string): string {
  const lower = question.toLowerCase();
  const expansions: string[] = [];

  for (const [term, synonyms] of Object.entries(CONSTRUCTION_SYNONYMS)) {
    const pattern = term.length <= 3
      ? new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")
      : null;
    const matched = pattern ? pattern.test(lower) : lower.includes(term);
    if (matched) {
      for (const syn of synonyms) {
        if (!lower.includes(syn)) {
          expansions.push(syn);
        }
      }
    }
  }

  return expansions.length > 0 ? question + " " + expansions.join(" ") : question;
}

function extractIdentifiers(question: string): string[] {
  const matches = question.match(/\b[A-Za-z]{1,4}\d*[-]?\d+[A-Za-z]?\b/g) || [];
  const cleaned = [...new Set(matches.map((m) => m.toUpperCase()))];
  const ids = cleaned.filter((id) => id.length >= 2);

  const phaseMatch = question.match(/phase\s*(\d+)/gi);
  if (phaseMatch) {
    for (const pm of phaseMatch) {
      const num = pm.replace(/\D/g, "");
      if (num) {
        ids.push(`P${num}-`);
      }
    }
  }

  return ids;
}

async function identifierBoostSearch(
  projectId: number,
  identifiers: string[],
  topK: number,
): Promise<SearchRow[]> {
  if (identifiers.length === 0) return [];
  const conditions = identifiers.map(
    (id) => sql`content ILIKE ${"%" + id + "%"}`,
  );
  const results = await db.execute<{
    content: string;
    section_label: string | null;
    document_type: string;
    project_document_id: number;
  }>(sql`
    SELECT content, section_label, document_type, project_document_id
    FROM document_chunks
    WHERE project_id = ${projectId}
      AND (${sql.join(conditions, sql` OR `)})
    LIMIT ${topK * 2}
  `);
  if (results.rows.length === 0) return [];
  const docMap = await getDocMap(projectId);
  return results.rows
    .map((r) => {
      const lower = r.content.toLowerCase();
      const hits = identifiers.filter((id) =>
        lower.includes(id.toLowerCase()),
      ).length;
      return {
        content: r.content,
        sectionLabel: r.section_label,
        documentName: docMap.get(r.project_document_id) ?? "Unknown",
        documentType: r.document_type,
        score: hits / identifiers.length,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/**
 * Hybrid search: runs vector similarity search AND full-text search in
 * parallel, then merges results using Reciprocal Rank Fusion (RRF).
 * This ensures exact keyword matches (spec sections, drawing callouts) are
 * always surfaced even when the semantic embedding is not the closest match.
 */
export async function keywordSearch(
  projectId: number,
  question: string,
  topK = 15,
): Promise<SearchRow[]> {
  const hasEmbedding = await db.execute<{ cnt: string }>(sql`
    SELECT COUNT(*) AS cnt FROM document_chunks
    WHERE project_id = ${projectId} AND embedding IS NOT NULL
    LIMIT 1
  `);
  const embeddedCount = Number(hasEmbedding.rows[0]?.cnt ?? 0);

  const FETCH_K = Math.max(topK * 3, 50);
  const RRF_K = 60;

  const expandedQuestion = expandSynonyms(question);
  const identifiers = extractIdentifiers(question);

  let vectorResults: SearchRow[] = [];
  let ftsResults: SearchRow[] = [];
  let idResults: SearchRow[] = [];

  const searches: Promise<void>[] = [];

  if (embeddedCount > 0) {
    searches.push(
      Promise.all([
        vectorSearch(projectId, expandedQuestion, FETCH_K),
        ftsSearch(projectId, expandedQuestion, FETCH_K),
      ]).then(([v, f]) => { vectorResults = v; ftsResults = f; })
        .catch((e) => {
          console.error("Hybrid search error, falling back to FTS only:", e);
          return ftsSearch(projectId, question, FETCH_K).then((f) => { ftsResults = f; });
        }),
    );
  } else {
    searches.push(ftsSearch(projectId, expandedQuestion, FETCH_K).then((f) => { ftsResults = f; }));
  }

  if (identifiers.length > 0) {
    searches.push(
      identifierBoostSearch(projectId, identifiers, FETCH_K).then((r) => { idResults = r; }),
    );
  }

  await Promise.all(searches);

  if (vectorResults.length === 0 && ftsResults.length === 0 && idResults.length === 0) return [];

  const scoreMap = new Map<string, { row: SearchRow; rrf: number }>();
  const key = (r: SearchRow) => r.content.slice(0, 300);

  const hasIds = identifiers.length > 0;
  const VECTOR_WEIGHT = hasIds ? 1.5 : 2.5;
  const FTS_WEIGHT = 1.0;
  const ID_WEIGHT = 2.5;

  vectorResults.forEach((row, rank) => {
    const k = key(row);
    const rrfScore = VECTOR_WEIGHT / (rank + 1 + RRF_K);
    const existing = scoreMap.get(k);
    if (existing) {
      existing.rrf += rrfScore;
    } else {
      scoreMap.set(k, { row, rrf: rrfScore });
    }
  });

  ftsResults.forEach((row, rank) => {
    const k = key(row);
    const rrfScore = FTS_WEIGHT / (rank + 1 + RRF_K);
    const existing = scoreMap.get(k);
    if (existing) {
      existing.rrf += rrfScore;
    } else {
      scoreMap.set(k, { row, rrf: rrfScore });
    }
  });

  idResults.forEach((row, rank) => {
    const k = key(row);
    const rrfScore = ID_WEIGHT / (rank + 1 + RRF_K);
    const existing = scoreMap.get(k);
    if (existing) {
      existing.rrf += rrfScore;
    } else {
      scoreMap.set(k, { row, rrf: rrfScore });
    }
  });

  const ranked = Array.from(scoreMap.values())
    .sort((a, b) => b.rrf - a.rrf);

  const selected: Array<{ row: SearchRow; rrf: number }> = [];
  const sectionCounts = new Map<string, number>();
  const MAX_PER_SECTION = 5;

  for (const entry of ranked) {
    if (selected.length >= topK) break;
    const section = entry.row.sectionLabel || entry.row.documentName;
    const count = sectionCounts.get(section) || 0;
    if (count >= MAX_PER_SECTION) continue;
    selected.push(entry);
    sectionCounts.set(section, count + 1);
  }

  if (selected.length < topK) {
    for (const entry of ranked) {
      if (selected.length >= topK) break;
      if (!selected.includes(entry)) {
        selected.push(entry);
      }
    }
  }

  return selected.map((entry) => ({ ...entry.row, score: entry.rrf }));
}
