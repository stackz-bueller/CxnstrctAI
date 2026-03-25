import { Router, type IRouter } from "express";
import multer from "multer";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import { db } from "@workspace/db";
import { specExtractionsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/pdf") cb(null, true);
    else cb(new Error("Only PDF files are supported"));
  },
});

function formatExtraction(row: typeof specExtractionsTable.$inferSelect) {
  return {
    id: row.id,
    fileName: row.fileName,
    status: row.status,
    totalPages: row.totalPages,
    projectName: row.projectName ?? null,
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
      .from(specExtractionsTable)
      .orderBy(specExtractionsTable.createdAt);
    res.json({ extractions: rows.map(formatExtraction) });
  } catch (err) {
    req.log.error({ err }, "Failed to list spec extractions");
    res.status(500).json({ error: "Failed to list spec extractions" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [row] = await db
      .select()
      .from(specExtractionsTable)
      .where(eq(specExtractionsTable.id, id));
    if (!row) {
      res.status(404).json({ error: "Spec extraction not found" });
      return;
    }
    res.json({ ...formatExtraction(row), sections: row.sections ?? [] });
  } catch (err) {
    req.log.error({ err }, "Failed to get spec extraction");
    res.status(500).json({ error: "Failed to get spec extraction" });
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

  const tmpPath = path.join(os.tmpdir(), `spec_${Date.now()}_${sanitizedName}`);
  fs.writeFileSync(tmpPath, file.buffer);

  const [extraction] = await db
    .insert(specExtractionsTable)
    .values({
      fileName: sanitizedName,
      status: "processing",
      totalPages: 0,
      sections: [],
      processingTimeMs: 0,
    })
    .returning();

  res.json(formatExtraction(extraction));

  (async () => {
    try {
      const aiBaseUrl = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"] ?? "";
      const aiApiKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] ?? "";
      const scriptPath = path.resolve(process.cwd(), "../../scripts/spec_processor.py");

      const result = await runSpecPipeline(scriptPath, tmpPath, aiBaseUrl, aiApiKey);

      await db
        .update(specExtractionsTable)
        .set({
          status: "completed",
          totalPages: result.total_pages,
          projectName: result.project_name || null,
          sections: result.sections as any,
          processingTimeMs: result.processing_time_ms,
          updatedAt: new Date(),
        })
        .where(eq(specExtractionsTable.id, extraction.id));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      req.log.error({ err }, "Spec pipeline failed");
      await db
        .update(specExtractionsTable)
        .set({ status: "failed", errorMessage: msg, updatedAt: new Date() })
        .where(eq(specExtractionsTable.id, extraction.id));
    } finally {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  })();
});

router.post("/:id/reprocess", async (req, res) => {
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [row] = await db
    .select()
    .from(specExtractionsTable)
    .where(eq(specExtractionsTable.id, id));

  if (!row) { res.status(404).json({ error: "Spec extraction not found" }); return; }

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

  await db
    .update(specExtractionsTable)
    .set({ status: "processing", sections: [], processingTimeMs: 0, errorMessage: null, updatedAt: new Date() })
    .where(eq(specExtractionsTable.id, id));

  res.json({ status: "reprocessing_started", extractionId: id, file: row.fileName });

  (async () => {
    try {
      const aiBaseUrl = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"] ?? "";
      const aiApiKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] ?? "";
      const scriptPath = path.resolve(process.cwd(), "../../scripts/spec_processor.py");

      req.log.info({ extractionId: id, pdfPath }, "Reprocessing spec PDF");

      const result = await runSpecPipeline(scriptPath, pdfPath, aiBaseUrl, aiApiKey);

      await db
        .update(specExtractionsTable)
        .set({
          status: "completed",
          totalPages: result.total_pages,
          projectName: result.project_name || null,
          sections: result.sections as any,
          processingTimeMs: result.processing_time_ms,
          updatedAt: new Date(),
        })
        .where(eq(specExtractionsTable.id, id));

      req.log.info({ extractionId: id, sections: result.sections.length }, "Spec reprocessing complete");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      req.log.error({ err }, "Spec reprocessing failed");
      await db
        .update(specExtractionsTable)
        .set({ status: "failed", errorMessage: msg, updatedAt: new Date() })
        .where(eq(specExtractionsTable.id, id));
    }
  })();
});

function runSpecPipeline(
  scriptPath: string,
  pdfPath: string,
  aiBaseUrl: string,
  aiApiKey: string,
): Promise<{ total_pages: number; project_name: string; total_sections: number; sections: unknown[]; processing_time_ms: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", [scriptPath, pdfPath, aiBaseUrl, aiApiKey], {
      timeout: 4 * 60 * 60 * 1000,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on("close", (code, signal) => {
      if (code !== 0 || signal) {
        const reason = signal ? `killed by signal ${signal}` : `exit code ${code}`;
        reject(new Error(`Spec pipeline ${reason}: ${stderr.slice(0, 500)}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.error) reject(new Error(parsed.error));
        else resolve(parsed);
      } catch {
        reject(new Error(`Failed to parse spec pipeline output: ${stdout.slice(0, 200)}`));
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn spec pipeline: ${err.message}`));
    });
  });
}

export default router;
