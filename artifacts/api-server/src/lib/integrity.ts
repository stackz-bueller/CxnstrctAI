import { db } from "@workspace/db";
import { constructionExtractionsTable, projectDocumentsTable, documentChunksTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { logger } from "./logger.js";
import { indexProjectDocument } from "../routes/projects/indexer.js";

const ASSETS_DIR = path.resolve(process.cwd(), "../../attached_assets");

export interface IntegrityResult {
  extractionId: number;
  fileName: string;
  totalPages: number;
  processedPages: number;
  status: string;
  action: "repaired" | "needs_file" | "already_complete" | "repair_failed";
  error?: string;
}

export async function checkExtractionIntegrity(): Promise<IntegrityResult[]> {
  const rows = await db
    .select()
    .from(constructionExtractionsTable);

  const results: IntegrityResult[] = [];

  for (const row of rows) {
    if (row.status === "failed") continue;

    const pages = (row.pages as Array<{ page_number: number }>) ?? [];
    const actualProcessed = pages.length;
    const isIncomplete = row.totalPages > 0 && actualProcessed < row.totalPages;
    const hasZeroPages = row.totalPages > 0 && actualProcessed === 0;
    const mislabeled = row.status === "completed" && isIncomplete;
    const updatedAge = row.updatedAt ? Date.now() - new Date(row.updatedAt).getTime() : Infinity;
    const STALE_THRESHOLD_MS = 5 * 60 * 1000;
    const staleProcessing = row.status === "processing" && updatedAge > STALE_THRESHOLD_MS;
    const partialRepair = row.status === "partial" && isIncomplete;
    const alreadyIncomplete = row.status === "incomplete" && isIncomplete;

    if (mislabeled || hasZeroPages || staleProcessing || partialRepair || alreadyIncomplete) {
      await db
        .update(constructionExtractionsTable)
        .set({
          status: "incomplete",
          processedPages: actualProcessed,
          updatedAt: new Date(),
        })
        .where(eq(constructionExtractionsTable.id, row.id));

      logger.warn({
        extractionId: row.id,
        fileName: row.fileName,
        totalPages: row.totalPages,
        actualProcessed,
      }, "Marked extraction as incomplete — was falsely labeled completed");

      results.push({
        extractionId: row.id,
        fileName: row.fileName,
        totalPages: row.totalPages,
        processedPages: actualProcessed,
        status: "incomplete",
        action: "needs_file",
      });
    }
  }

  return results;
}

export async function repairIncompleteExtraction(extractionId: number): Promise<IntegrityResult> {
  const [row] = await db
    .select()
    .from(constructionExtractionsTable)
    .where(eq(constructionExtractionsTable.id, extractionId));

  if (!row) {
    return {
      extractionId,
      fileName: "unknown",
      totalPages: 0,
      processedPages: 0,
      status: "not_found",
      action: "repair_failed",
      error: "Extraction not found",
    };
  }

  const pages = (row.pages as Array<{ page_number: number }>) ?? [];
  if (pages.length >= row.totalPages && row.totalPages > 0) {
    await db
      .update(constructionExtractionsTable)
      .set({ status: "completed", processedPages: pages.length, updatedAt: new Date() })
      .where(eq(constructionExtractionsTable.id, extractionId));

    return {
      extractionId,
      fileName: row.fileName,
      totalPages: row.totalPages,
      processedPages: pages.length,
      status: "completed",
      action: "already_complete",
    };
  }

  let pdfPath = path.join(ASSETS_DIR, row.fileName);
  if (!fs.existsSync(pdfPath)) {
    const sanitized = row.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    pdfPath = path.join(ASSETS_DIR, sanitized);
  }
  if (!fs.existsSync(pdfPath)) {
    return {
      extractionId,
      fileName: row.fileName,
      totalPages: row.totalPages,
      processedPages: pages.length,
      status: "incomplete",
      action: "needs_file",
      error: `PDF file not found in attached_assets`,
    };
  }

  const maxProcessed = pages.length > 0
    ? Math.max(...pages.map((p) => p.page_number))
    : 0;
  const startPage = maxProcessed + 1;

  logger.info({
    extractionId,
    fileName: row.fileName,
    startPage,
    existingPages: pages.length,
    totalPages: row.totalPages,
  }, "Starting auto-repair of incomplete extraction");

  await db
    .update(constructionExtractionsTable)
    .set({ status: "processing", updatedAt: new Date() })
    .where(eq(constructionExtractionsTable.id, extractionId));

  try {
    const aiBaseUrl = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"] ?? "";
    const aiApiKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] ?? "";
    const scriptPath = path.resolve(process.cwd(), "../../scripts/pdf_processor.py");

    const pagesMap = new Map<number, unknown>(pages.map((p) => [p.page_number, p]));
    let totalPages = row.totalPages;
    let processingTimeMs = row.processingTimeMs;

    await new Promise<void>((resolve, reject) => {
      const proc = spawn("python3", [
        scriptPath, pdfPath, aiBaseUrl, aiApiKey,
        String(startPage), "99999", "--stream",
      ], { timeout: 4 * 60 * 60 * 1000 });

      let lineBuffer = "";

      const savePage = async (pageData: unknown) => {
        const pg = pageData as { page_number: number };
        pagesMap.set(pg.page_number, pg);
        const allPages = Array.from(pagesMap.values()).sort(
          (a, b) => (a as { page_number: number }).page_number - (b as { page_number: number }).page_number
        );
        await db
          .update(constructionExtractionsTable)
          .set({
            pages: allPages,
            processedPages: pagesMap.size,
            totalPages,
            updatedAt: new Date(),
          })
          .where(eq(constructionExtractionsTable.id, extractionId));
      };

      proc.stdout.on("data", (chunk: Buffer) => {
        lineBuffer += chunk.toString();
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const msg = JSON.parse(trimmed);
            if (msg.type === "page") {
              totalPages = msg.total_pages;
              savePage(msg.page).catch((e) => logger.error({ e }, "Failed to save repaired page"));
            } else if (msg.type === "done") {
              totalPages = msg.total_pages;
              processingTimeMs += msg.processing_time_ms;
            }
          } catch { /* skip */ }
        }
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) logger.debug({ stderr: text.slice(0, 300) }, "Repair stderr");
      });

      proc.on("close", (code, signal) => {
        if (signal) reject(new Error(`Repair killed by signal ${signal}`));
        else if (code !== 0) reject(new Error(`Repair exited with code ${code}`));
        else resolve();
      });

      proc.on("error", (err) => reject(err));
    });

    const finalPages = Array.from(pagesMap.values()).sort(
      (a, b) => (a as { page_number: number }).page_number - (b as { page_number: number }).page_number
    );

    const finalStatus = finalPages.length >= totalPages ? "completed" : "partial";
    await db
      .update(constructionExtractionsTable)
      .set({
        status: finalStatus,
        pages: finalPages,
        processedPages: finalPages.length,
        totalPages,
        processingTimeMs,
        updatedAt: new Date(),
      })
      .where(eq(constructionExtractionsTable.id, extractionId));

    logger.info({
      extractionId,
      pagesNow: finalPages.length,
      totalPages,
      status: finalStatus,
    }, "Auto-repair complete");

    const linkedDocs = await db
      .select()
      .from(projectDocumentsTable)
      .where(eq(projectDocumentsTable.documentId, extractionId));

    for (const doc of linkedDocs) {
      if (doc.documentType !== "construction") continue;
      try {
        await indexProjectDocument(doc.projectId, doc.id, doc.documentType, doc.documentId);
        logger.info({ projectDocumentId: doc.id }, "Re-indexed after repair");
      } catch (idxErr) {
        logger.error({ idxErr, projectDocumentId: doc.id }, "Re-index after repair failed");
      }
    }

    return {
      extractionId,
      fileName: row.fileName,
      totalPages,
      processedPages: finalPages.length,
      status: finalStatus,
      action: "repaired",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    logger.error({ err, extractionId }, "Auto-repair failed");

    await db
      .update(constructionExtractionsTable)
      .set({ status: "partial", errorMessage: msg.slice(0, 500), updatedAt: new Date() })
      .where(eq(constructionExtractionsTable.id, extractionId));

    return {
      extractionId,
      fileName: row.fileName,
      totalPages: row.totalPages,
      processedPages: pages.length,
      status: "partial",
      action: "repair_failed",
      error: msg,
    };
  }
}

export async function repairAllIncomplete(): Promise<IntegrityResult[]> {
  const incomplete = await checkExtractionIntegrity();
  const results: IntegrityResult[] = [];

  for (const item of incomplete) {
    if (item.action === "needs_file") {
      const pdfPath = path.join(ASSETS_DIR, item.fileName);
      if (fs.existsSync(pdfPath)) {
        const result = await repairIncompleteExtraction(item.extractionId);
        results.push(result);
      } else {
        results.push(item);
      }
    }
  }

  return results;
}
