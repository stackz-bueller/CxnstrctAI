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

  const tmpPath = path.join(os.tmpdir(), `fin_${Date.now()}_${file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`);
  fs.writeFileSync(tmpPath, file.buffer);

  const [record] = await db
    .insert(financialExtractionsTable)
    .values({ fileName: file.originalname, status: "processing", totalPages: 0, documents: [], processingTimeMs: 0 })
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
