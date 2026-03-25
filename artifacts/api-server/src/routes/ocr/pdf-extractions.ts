import { Router, type IRouter } from "express";
import multer from "multer";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import { db } from "@workspace/db";
import { constructionExtractionsTable, projectDocumentsTable, constructionPageResultSchema } from "@workspace/db/schema";
import { GetPdfExtractionParams } from "@workspace/api-zod";
import { eq } from "drizzle-orm";
import { indexProjectDocument } from "../projects/indexer.js";
import { checkExtractionIntegrity, repairIncompleteExtraction } from "../../lib/integrity.js";

const router: IRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files are supported"));
    }
  },
});

function formatExtraction(row: typeof constructionExtractionsTable.$inferSelect) {
  return {
    id: row.id,
    fileName: row.fileName,
    status: row.status,
    totalPages: row.totalPages,
    processedPages: row.processedPages,
    processingTimeMs: row.processingTimeMs,
    errorMessage: row.errorMessage ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

router.get("/", async (req, res) => {
  try {
    const rows = await db
      .select()
      .from(constructionExtractionsTable)
      .orderBy(constructionExtractionsTable.createdAt);

    res.json({ extractions: rows.map(formatExtraction) });
  } catch (err) {
    req.log.error({ err }, "Failed to list PDF extractions");
    res.status(500).json({ error: "Failed to list PDF extractions" });
  }
});

router.get("/integrity", async (req, res) => {
  try {
    const rows = await db.select().from(constructionExtractionsTable);
    const issues: Array<{ extractionId: number; fileName: string; processedPages: number; totalPages: number; status: string }> = [];
    for (const row of rows) {
      if (row.status === "failed") continue;
      const pages = (row.pages as Array<{ page_number: number }>) ?? [];
      const actualProcessed = pages.length;
      const isIncomplete = row.totalPages > 0 && actualProcessed < row.totalPages;
      if (isIncomplete || row.status === "processing" || row.status === "incomplete" || row.status === "partial") {
        issues.push({
          extractionId: row.id,
          fileName: row.fileName,
          processedPages: actualProcessed,
          totalPages: row.totalPages,
          status: row.status,
        });
      }
    }
    res.json({
      healthy: issues.length === 0,
      incompleteCount: issues.length,
      issues,
    });
  } catch (err) {
    req.log.error({ err }, "Integrity check failed");
    res.status(500).json({ error: "Integrity check failed" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const { id } = GetPdfExtractionParams.parse({ id: parseInt(req.params.id) });
    const [row] = await db
      .select()
      .from(constructionExtractionsTable)
      .where(eq(constructionExtractionsTable.id, id));

    if (!row) {
      res.status(404).json({ error: "PDF extraction not found" });
      return;
    }

    res.json({
      ...formatExtraction(row),
      pages: row.pages ?? [],
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get PDF extraction");
    res.status(500).json({ error: "Failed to get PDF extraction" });
  }
});

router.post("/upload", upload.single("file"), async (req, res) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "No PDF file uploaded" });
    return;
  }

  const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
  const assetsDir = path.resolve(process.cwd(), "../../attached_assets");
  if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });
  const persistPath = path.join(assetsDir, sanitizedName);
  fs.writeFileSync(persistPath, file.buffer);

  const tmpDir = os.tmpdir();
  const tmpPath = path.join(tmpDir, `upload_${Date.now()}_${sanitizedName}`);
  fs.writeFileSync(tmpPath, file.buffer);

  const [extraction] = await db
    .insert(constructionExtractionsTable)
    .values({
      fileName: sanitizedName,
      status: "processing",
      totalPages: 0,
      processedPages: 0,
      pages: [],
      processingTimeMs: 0,
    })
    .returning();

  // Return immediately with pending record, process in background
  res.json(formatExtraction(extraction));

  // Run the Python pipeline in background using streaming mode
  (async () => {
    try {
      const aiBaseUrl = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"] ?? "";
      const aiApiKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] ?? "";
      const scriptPath = path.resolve(process.cwd(), "../../scripts/pdf_processor.py");

      const pagesMap = new Map<number, unknown>();
      let totalPages = 0;
      let processingTimeMs = 0;

      await new Promise<void>((resolve, reject) => {
        const proc = spawn("python3", [
          scriptPath, tmpPath, aiBaseUrl, aiApiKey,
          "1", "99999", "--stream",
        ], { timeout: 4 * 60 * 60 * 1000 });

        let lineBuffer = "";

        const savePage = async (pageData: unknown) => {
          const validation = constructionPageResultSchema.safeParse(pageData);
          let pg: { page_number: number };
          if (validation.success) {
            pg = validation.data;
          } else {
            req.log.warn({ errors: validation.error.issues.map((i: any) => `${i.path.join(".")}: ${i.message}`).slice(0, 5), page: (pageData as { page_number?: number })?.page_number }, "Page schema validation warning — saving raw data");
            pg = pageData as { page_number: number };
          }
          pagesMap.set(pg.page_number, pg);
          const allPages = Array.from(pagesMap.values()).sort(
            (a, b) => (a as { page_number: number }).page_number - (b as { page_number: number }).page_number,
          );
          await db.update(constructionExtractionsTable)
            .set({
              processedPages: pagesMap.size,
              pages: allPages as never,
              totalPages,
              processingTimeMs,
              updatedAt: new Date(),
            })
            .where(eq(constructionExtractionsTable.id, extraction.id));
          req.log.info({ extractionId: extraction.id, page: pg.page_number, saved: pagesMap.size, total: totalPages, schemaValid: validation.success }, "Saved page to DB");
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
                savePage(msg.page).catch((e) => req.log.error({ err: e }, "Failed to save page"));
              } else if (msg.type === "done") {
                totalPages = msg.total_pages;
                processingTimeMs = msg.processing_time_ms;
              }
            } catch { /* skip non-JSON lines */ }
          }
        });

        proc.stderr.on("data", (chunk: Buffer) => {
          const text = chunk.toString().trim();
          if (text) req.log.warn({ stderr: text.slice(0, 1000) }, "Python stderr");
        });

        proc.on("close", (code, signal) => {
          if (code !== 0 || signal) {
            reject(new Error(`Python process ${signal ? `killed by signal ${signal}` : `exit code ${code}`}`));
          } else {
            resolve();
          }
        });

        proc.on("error", (err) => reject(err));
      });

      const finalPages = Array.from(pagesMap.values()).sort(
        (a, b) => (a as { page_number: number }).page_number - (b as { page_number: number }).page_number,
      );

      await db
        .update(constructionExtractionsTable)
        .set({
          status: finalPages.length >= totalPages ? "completed" : "partial",
          processedPages: finalPages.length,
          pages: finalPages as never,
          totalPages,
          processingTimeMs,
          updatedAt: new Date(),
        })
        .where(eq(constructionExtractionsTable.id, extraction.id));

      req.log.info({ extractionId: extraction.id, pages: finalPages.length, total: totalPages }, "Extraction complete");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      req.log.error({ err }, "PDF pipeline failed");
      await db
        .update(constructionExtractionsTable)
        .set({
          status: "failed",
          errorMessage: msg,
          updatedAt: new Date(),
        })
        .where(eq(constructionExtractionsTable.id, extraction.id));
    } finally {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ignore cleanup errors
      }
    }
  })();
});

function runPythonPipeline(
  scriptPath: string,
  pdfPath: string,
  aiBaseUrl: string,
  aiApiKey: string,
): Promise<{ total_pages: number; processing_time_ms: number; pages: unknown[] }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", [scriptPath, pdfPath, aiBaseUrl, aiApiKey], {
      timeout: 4 * 60 * 60 * 1000, // 4 hours — full drawing sets can take a long time
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code, signal) => {
      if (code !== 0 || signal) {
        const reason = signal ? `killed by signal ${signal}` : `exit code ${code}`;
        reject(new Error(`Python process ${reason}: ${stderr.slice(0, 500)}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.error) {
          reject(new Error(parsed.error));
        } else {
          resolve(parsed);
        }
      } catch (e) {
        reject(new Error(`Failed to parse pipeline output: ${stdout.slice(0, 200)}`));
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn Python process: ${err.message}`));
    });
  });
}

router.post("/:id/reprocess", async (req, res) => {
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [row] = await db
    .select()
    .from(constructionExtractionsTable)
    .where(eq(constructionExtractionsTable.id, id));

  if (!row) { res.status(404).json({ error: "Extraction not found" }); return; }

  if (row.status === "processing") {
    res.json({ status: "already_processing", extractionId: id });
    return;
  }

  const assetsDir = path.resolve(process.cwd(), "../../attached_assets");
  const pdfPath = path.join(assetsDir, row.fileName);

  if (!fs.existsSync(pdfPath)) {
    res.status(404).json({ error: `PDF not found on disk: ${row.fileName}` });
    return;
  }

  const fullReprocess = req.query.full === "true";

  let existingPages: Array<{ page_number: number }>;
  let startPage: number;

  if (fullReprocess) {
    existingPages = [];
    startPage = 1;
  } else {
    existingPages = (row.pages as Array<{ page_number: number }>) ?? [];
    const maxProcessed = existingPages.length > 0
      ? Math.max(...existingPages.map((p) => p.page_number))
      : 0;
    startPage = maxProcessed + 1;

    if (startPage > row.totalPages && row.totalPages > 0) {
      res.json({ status: "already_complete", pages: existingPages.length, totalPages: row.totalPages });
      return;
    }
  }

  await db
    .update(constructionExtractionsTable)
    .set({
      status: "processing",
      ...(fullReprocess ? { pages: [], processedPages: 0, processingTimeMs: 0, errorMessage: null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(constructionExtractionsTable.id, id));

  res.json({
    status: "reprocessing_started",
    mode: fullReprocess ? "full" : "resume",
    extractionId: id,
    file: row.fileName,
    resumingFrom: startPage,
    alreadyHavePages: existingPages.length,
  });

  (async () => {
    try {
      const aiBaseUrl = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"] ?? "";
      const aiApiKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] ?? "";
      const scriptPath = path.resolve(process.cwd(), "../../scripts/pdf_processor.py");

      req.log.info({ extractionId: id, pdfPath, startPage, fullReprocess }, "Reprocessing construction PDF (streaming)");

      const pagesMap = new Map<number, unknown>(existingPages.map((p) => [p.page_number, p]));
      let totalPages = fullReprocess ? 0 : row.totalPages;
      let processingTimeMs = fullReprocess ? 0 : row.processingTimeMs;
      let pagesSaved = existingPages.length;

      await new Promise<void>((resolve, reject) => {
        const proc = spawn("python3", [
          scriptPath, pdfPath, aiBaseUrl, aiApiKey,
          String(startPage), "99999", "--stream",
        ], { timeout: 4 * 60 * 60 * 1000 });

        let lineBuffer = "";

        const savePage = async (pageData: unknown) => {
          const validation = constructionPageResultSchema.safeParse(pageData);
          let pg: { page_number: number };
          if (validation.success) {
            pg = validation.data;
          } else {
            req.log.warn({ errors: validation.error.issues.map((i: any) => `${i.path.join(".")}: ${i.message}`).slice(0, 5), page: (pageData as { page_number?: number })?.page_number }, "Page schema validation warning — saving raw data");
            pg = pageData as { page_number: number };
          }
          pagesMap.set(pg.page_number, pg);
          pagesSaved = pagesMap.size;
          const allPages = Array.from(pagesMap.values()).sort(
            (a, b) => (a as { page_number: number }).page_number - (b as { page_number: number }).page_number
          );
          await db
            .update(constructionExtractionsTable)
            .set({
              pages: allPages as any,
              processedPages: pagesSaved,
              totalPages,
              updatedAt: new Date(),
            })
            .where(eq(constructionExtractionsTable.id, id));
          req.log.info({ extractionId: id, page: pg.page_number, saved: pagesSaved, total: totalPages, schemaValid: validation.success }, "Saved page to DB");
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
                savePage(msg.page).catch((e) => req.log.error({ e }, "Failed to save page to DB"));
              } else if (msg.type === "done") {
                totalPages = msg.total_pages;
                processingTimeMs += msg.processing_time_ms;
              }
            } catch {
              req.log.warn({ line: trimmed }, "Non-JSON line from python script");
            }
          }
        });

        proc.stderr.on("data", (chunk: Buffer) => {
          req.log.debug({ stderr: chunk.toString().trim() }, "pdf_processor stderr");
        });

        proc.on("close", (code, signal) => {
          if (signal) reject(new Error(`Python killed by signal ${signal}`));
          else if (code !== 0) reject(new Error(`Python exited with code ${code}`));
          else resolve();
        });

        proc.on("error", (err) => reject(new Error(`Failed to spawn Python: ${err.message}`)));
      });

      const finalPages = Array.from(pagesMap.values()).sort(
        (a, b) => (a as { page_number: number }).page_number - (b as { page_number: number }).page_number
      );
      await db
        .update(constructionExtractionsTable)
        .set({
          status: finalPages.length >= totalPages ? "completed" : "partial",
          pages: finalPages as any,
          processedPages: finalPages.length,
          totalPages,
          processingTimeMs,
          updatedAt: new Date(),
        })
        .where(eq(constructionExtractionsTable.id, id));

      req.log.info({ extractionId: id, pages: finalPages.length, total: totalPages }, "Reprocessing done, re-indexing");

      const linkedDocs = await db
        .select()
        .from(projectDocumentsTable)
        .where(eq(projectDocumentsTable.documentId, id));

      for (const doc of linkedDocs) {
        if (doc.documentType !== "construction") continue;
        try {
          await indexProjectDocument(doc.projectId, doc.id, doc.documentType, doc.documentId);
          req.log.info({ projectDocumentId: doc.id }, "Re-indexed project document");
        } catch (idxErr) {
          req.log.error({ idxErr, projectDocumentId: doc.id }, "Re-index failed");
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      req.log.error({ err }, "Reprocessing pipeline failed");
      await db
        .update(constructionExtractionsTable)
        .set({ status: "partial", errorMessage: msg.slice(0, 500), updatedAt: new Date() })
        .where(eq(constructionExtractionsTable.id, id));
    }
  })();
});

router.post("/:id/repair", async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [row] = await db
    .select({ status: constructionExtractionsTable.status, fileName: constructionExtractionsTable.fileName })
    .from(constructionExtractionsTable)
    .where(eq(constructionExtractionsTable.id, id));

  if (!row) { res.status(404).json({ error: "Extraction not found" }); return; }
  if (row.status === "processing") {
    res.json({ extractionId: id, status: "processing", message: "Repair already in progress" });
    return;
  }

  res.json({ extractionId: id, fileName: row.fileName, status: "repair_started", message: "Repair running in background" });

  (async () => {
    try {
      const result = await repairIncompleteExtraction(id);
      req.log.info({ result: result.action, pages: result.processedPages, total: result.totalPages }, "Background repair finished");
    } catch (err) {
      req.log.error({ err }, "Background repair failed");
    }
  })();
});

export default router;
