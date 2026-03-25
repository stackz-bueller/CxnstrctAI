import { Router, type IRouter } from "express";
import multer from "multer";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { financialExtractionsTable } from "@workspace/db/schema";

const router: IRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/pdf") cb(null, true);
    else cb(new Error("Only PDF files are supported"));
  },
});

function fmt(row: typeof financialExtractionsTable.$inferSelect) {
  return {
    id: row.id,
    fileName: row.fileName,
    status: row.status,
    totalPages: row.totalPages,
    detectedType: row.detectedType ?? null,
    processingTimeMs: row.processingTimeMs,
    errorMessage: row.errorMessage ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

router.get("/", async (req, res) => {
  try {
    const rows = await db.select().from(financialExtractionsTable).orderBy(financialExtractionsTable.createdAt);
    res.json({ extractions: rows.map(fmt) });
  } catch (err) {
    req.log.error({ err }, "Failed to list financial extractions");
    res.status(500).json({ error: "Failed to list financial extractions" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [row] = await db.select().from(financialExtractionsTable).where(eq(financialExtractionsTable.id, id));
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    res.json({ ...fmt(row), documents: row.documents ?? [] });
  } catch (err) {
    req.log.error({ err }, "Failed to get financial extraction");
    res.status(500).json({ error: "Failed to get financial extraction" });
  }
});

router.post("/upload", upload.single("file"), async (req, res) => {
  const file = req.file;
  if (!file) { res.status(400).json({ error: "No PDF uploaded" }); return; }

  const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
  const assetsDir = path.resolve(process.cwd(), "../../attached_assets");
  if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, sanitizedName), file.buffer);

  const tmpPath = path.join(os.tmpdir(), `fin_${Date.now()}_${sanitizedName}`);
  fs.writeFileSync(tmpPath, file.buffer);

  const [record] = await db
    .insert(financialExtractionsTable)
    .values({ fileName: sanitizedName, status: "processing", totalPages: 0, documents: [], processingTimeMs: 0 })
    .returning();

  res.json(fmt(record));

  void (async () => {
    const aiBaseUrl = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"] ?? "";
    const aiApiKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] ?? "";
    const scriptPath = path.resolve(process.cwd(), "../../scripts/financial_processor.py");
    try {
      const result = await runScript(scriptPath, [tmpPath, aiBaseUrl, aiApiKey]);
      await db.update(financialExtractionsTable).set({
        status: "completed",
        totalPages: result.total_pages as number,
        detectedType: result.detected_type as string,
        documents: result.documents as never[],
        processingTimeMs: result.processing_time_ms as number,
        updatedAt: new Date(),
      }).where(eq(financialExtractionsTable.id, record.id));
    } catch (err) {
      req.log.error({ err }, "Financial pipeline failed");
      await db.update(financialExtractionsTable).set({
        status: "failed",
        errorMessage: err instanceof Error ? err.message : "Unknown",
        updatedAt: new Date(),
      }).where(eq(financialExtractionsTable.id, record.id));
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
    .from(financialExtractionsTable)
    .where(eq(financialExtractionsTable.id, id));

  if (!row) { res.status(404).json({ error: "Financial extraction not found" }); return; }

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
    .update(financialExtractionsTable)
    .set({ status: "processing", documents: [], processingTimeMs: 0, errorMessage: null, updatedAt: new Date() })
    .where(eq(financialExtractionsTable.id, id));

  res.json({ status: "reprocessing_started", extractionId: id, file: row.fileName });

  void (async () => {
    const aiBaseUrl = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"] ?? "";
    const aiApiKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] ?? "";
    const scriptPath = path.resolve(process.cwd(), "../../scripts/financial_processor.py");
    try {
      req.log.info({ extractionId: id, pdfPath }, "Reprocessing financial PDF");
      const result = await runScript(scriptPath, [pdfPath, aiBaseUrl, aiApiKey]);
      await db.update(financialExtractionsTable).set({
        status: "completed",
        totalPages: result.total_pages as number,
        detectedType: result.detected_type as string,
        documents: result.documents as never[],
        processingTimeMs: result.processing_time_ms as number,
        updatedAt: new Date(),
      }).where(eq(financialExtractionsTable.id, id));
      req.log.info({ extractionId: id }, "Financial reprocessing complete");
    } catch (err) {
      req.log.error({ err }, "Financial reprocessing failed");
      await db.update(financialExtractionsTable).set({
        status: "failed",
        errorMessage: err instanceof Error ? err.message : "Unknown",
        updatedAt: new Date(),
      }).where(eq(financialExtractionsTable.id, id));
    }
  })();
});

function runScript(scriptPath: string, args: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", [scriptPath, ...args], { timeout: 4 * 60 * 60 * 1000 });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
    proc.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    proc.on("close", (code, signal) => {
      if (code !== 0 || signal) { reject(new Error(`Pipeline ${signal ?? `exit ${code}`}: ${stderr.slice(0, 400)}`)); return; }
      try {
        const r = JSON.parse(stdout);
        if (r.error) reject(new Error(r.error)); else resolve(r);
      } catch { reject(new Error(`Parse error: ${stdout.slice(0, 200)}`)); }
    });
    proc.on("error", (e) => reject(new Error(`Spawn: ${e.message}`)));
  });
}

export default router;
