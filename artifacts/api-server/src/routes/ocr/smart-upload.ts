import { Router, type IRouter } from "express";
import multer from "multer";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { constructionExtractionsTable, specExtractionsTable, financialExtractionsTable } from "@workspace/db/schema";

const router: IRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif"];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Unsupported file type. Accepted: PDF, JPG, PNG, WebP"));
  },
});

type DetectedType = "construction_pdf" | "spec_pdf" | "change_order" | "invoice" | "receipt" | "scanned_pdf" | "image";

type DetectResult = {
  type: DetectedType;
  reason: string;
  total_pages: number | null;
  page_width_pts: number | null;
  page_height_pts: number | null;
  avg_words_per_page: number | null;
};

function detectPdf(pdfPath: string): Promise<DetectResult> {
  return new Promise((resolve, reject) => {
    const scriptPath = path.resolve(process.cwd(), "../../scripts/detect_document.py");
    const proc = spawn("python3", [scriptPath, pdfPath], { timeout: 15_000 });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
    proc.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    proc.on("close", (code) => {
      if (code !== 0) { reject(new Error(`Detector exit ${code}: ${stderr.slice(0, 200)}`)); return; }
      try {
        const p = JSON.parse(stdout);
        if (p.error) reject(new Error(p.error)); else resolve(p as DetectResult);
      } catch { reject(new Error(`Parse error: ${stdout.slice(0, 100)}`)); }
    });
    proc.on("error", (e) => reject(new Error(`Spawn: ${e.message}`)));
  });
}

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
      } catch { reject(new Error(`Parse: ${stdout.slice(0, 200)}`)); }
    });
    proc.on("error", (e) => reject(new Error(`Spawn: ${e.message}`)));
  });
}

function getAssetsDir(): string {
  const dir = path.resolve(process.cwd(), "../../attached_assets");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

router.post("/", upload.single("file"), async (req, res) => {
  const file = req.file;
  if (!file) { res.status(400).json({ error: "No file uploaded" }); return; }

  const isImage = file.mimetype.startsWith("image/");

  if (isImage) {
    res.json({
      detectedType: "image" as DetectedType,
      pipeline: "extractions",
      id: null,
      reason: "Image file — go to the Image OCR page, select a schema, and upload there",
      pages: null,
      pageSize: null,
      avgWordsPerPage: null,
    });
    return;
  }

  const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
  const assetsDir = getAssetsDir();
  const persistPath = path.join(assetsDir, sanitizedName);
  fs.writeFileSync(persistPath, file.buffer);

  let detection: DetectResult;
  try {
    detection = await detectPdf(persistPath);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Detection failed" });
    return;
  }

  const pageSize = detection.page_width_pts && detection.page_height_pts
    ? `${(detection.page_width_pts / 72).toFixed(1)}"×${(detection.page_height_pts / 72).toFixed(1)}"`
    : null;

  const isFinancial = detection.type === "change_order" || detection.type === "invoice" || detection.type === "receipt";
  const isSpec = detection.type === "spec_pdf";

  let pipeline: string;
  let recordId: number;

  if (isFinancial) {
    const [record] = await db
      .insert(financialExtractionsTable)
      .values({ fileName: sanitizedName, status: "uploaded", totalPages: detection.total_pages ?? 0, documents: [], processingTimeMs: 0 })
      .returning();
    pipeline = "financial-extractions";
    recordId = record.id;
  } else if (isSpec) {
    const [record] = await db
      .insert(specExtractionsTable)
      .values({ fileName: sanitizedName, status: "uploaded", totalPages: detection.total_pages ?? 0, sections: [], processingTimeMs: 0 })
      .returning();
    pipeline = "spec-extractions";
    recordId = record.id;
  } else {
    const [record] = await db
      .insert(constructionExtractionsTable)
      .values({ fileName: sanitizedName, status: "uploaded", totalPages: detection.total_pages ?? 0, pages: [], processingTimeMs: 0 })
      .returning();
    pipeline = "pdf-extractions";
    recordId = record.id;
  }

  req.log.info({ pipeline, id: recordId, fileName: sanitizedName, detectedType: detection.type }, "File uploaded — awaiting processing trigger");

  res.json({
    detectedType: detection.type,
    pipeline,
    id: recordId,
    reason: detection.reason,
    pages: detection.total_pages,
    pageSize,
    avgWordsPerPage: detection.avg_words_per_page,
  });
});

router.post("/:id/process", async (req, res) => {
  const id = Number(req.params.id);
  const { pipeline } = req.body as { pipeline?: string };

  if (!pipeline || !["pdf-extractions", "spec-extractions", "financial-extractions"].includes(pipeline)) {
    res.status(400).json({ error: "pipeline is required (pdf-extractions | spec-extractions | financial-extractions)" });
    return;
  }

  const aiBaseUrl = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"] ?? "";
  const aiApiKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] ?? "";
  const cwd = process.cwd();
  const assetsDir = getAssetsDir();

  if (pipeline === "financial-extractions") {
    const [record] = await db.select().from(financialExtractionsTable).where(eq(financialExtractionsTable.id, id));
    if (!record) { res.status(404).json({ error: "Extraction not found" }); return; }
    if (record.status === "processing") { res.status(409).json({ error: "Already processing" }); return; }

    const srcPath = path.join(assetsDir, record.fileName);
    if (!fs.existsSync(srcPath)) { res.status(404).json({ error: `Source file not found: ${record.fileName}` }); return; }

    await db.update(financialExtractionsTable)
      .set({ status: "processing", updatedAt: new Date() })
      .where(eq(financialExtractionsTable.id, id));

    res.json({ status: "processing", id, pipeline });

    const tmpPath = path.join(os.tmpdir(), `proc_${Date.now()}_${record.fileName}`);
    fs.copyFileSync(srcPath, tmpPath);

    void (async () => {
      const scriptPath = path.resolve(cwd, "../../scripts/financial_processor.py");
      try {
        const r = await runScript(scriptPath, [tmpPath, aiBaseUrl, aiApiKey]) as {
          total_pages: number; detected_type: string; documents: unknown[]; processing_time_ms: number;
        };
        await db.update(financialExtractionsTable)
          .set({ status: "completed", totalPages: r.total_pages, detectedType: r.detected_type, documents: r.documents as never[], processingTimeMs: r.processing_time_ms, updatedAt: new Date() })
          .where(eq(financialExtractionsTable.id, id));
      } catch (err) {
        req.log.error({ err, id }, "Financial pipeline failed");
        await db.update(financialExtractionsTable)
          .set({ status: "failed", errorMessage: err instanceof Error ? err.message : "Unknown", updatedAt: new Date() })
          .where(eq(financialExtractionsTable.id, id));
      } finally {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      }
    })();

  } else if (pipeline === "spec-extractions") {
    const [record] = await db.select().from(specExtractionsTable).where(eq(specExtractionsTable.id, id));
    if (!record) { res.status(404).json({ error: "Extraction not found" }); return; }
    if (record.status === "processing") { res.status(409).json({ error: "Already processing" }); return; }

    const srcPath = path.join(assetsDir, record.fileName);
    if (!fs.existsSync(srcPath)) { res.status(404).json({ error: `Source file not found: ${record.fileName}` }); return; }

    await db.update(specExtractionsTable)
      .set({ status: "processing", updatedAt: new Date() })
      .where(eq(specExtractionsTable.id, id));

    res.json({ status: "processing", id, pipeline });

    const tmpPath = path.join(os.tmpdir(), `proc_${Date.now()}_${record.fileName}`);
    fs.copyFileSync(srcPath, tmpPath);

    void (async () => {
      const scriptPath = path.resolve(cwd, "../../scripts/spec_processor.py");
      try {
        const r = await runScript(scriptPath, [tmpPath, aiBaseUrl, aiApiKey]) as {
          total_pages: number; project_name: string; sections: unknown[]; processing_time_ms: number;
        };
        await db.update(specExtractionsTable)
          .set({ status: "completed", totalPages: r.total_pages, projectName: r.project_name || null, sections: r.sections as any, processingTimeMs: r.processing_time_ms, updatedAt: new Date() })
          .where(eq(specExtractionsTable.id, id));
      } catch (err) {
        req.log.error({ err, id }, "Spec pipeline failed");
        await db.update(specExtractionsTable)
          .set({ status: "failed", errorMessage: err instanceof Error ? err.message : "Unknown", updatedAt: new Date() })
          .where(eq(specExtractionsTable.id, id));
      } finally {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      }
    })();

  } else {
    const [record] = await db.select().from(constructionExtractionsTable).where(eq(constructionExtractionsTable.id, id));
    if (!record) { res.status(404).json({ error: "Extraction not found" }); return; }
    if (record.status === "processing") { res.status(409).json({ error: "Already processing" }); return; }

    const srcPath = path.join(assetsDir, record.fileName);
    if (!fs.existsSync(srcPath)) { res.status(404).json({ error: `Source file not found: ${record.fileName}` }); return; }

    await db.update(constructionExtractionsTable)
      .set({ status: "processing", updatedAt: new Date() })
      .where(eq(constructionExtractionsTable.id, id));

    res.json({ status: "processing", id, pipeline });

    const tmpPath = path.join(os.tmpdir(), `proc_${Date.now()}_${record.fileName}`);
    fs.copyFileSync(srcPath, tmpPath);

    void (async () => {
      const scriptPath = path.resolve(cwd, "../../scripts/pdf_processor.py");
      try {
        const r = await runScript(scriptPath, [tmpPath, aiBaseUrl, aiApiKey]) as {
          total_pages: number; pages: unknown[]; processing_time_ms: number;
        };
        await db.update(constructionExtractionsTable)
          .set({ status: "completed", totalPages: r.total_pages, pages: r.pages as any, processingTimeMs: r.processing_time_ms, updatedAt: new Date() })
          .where(eq(constructionExtractionsTable.id, id));
      } catch (err) {
        req.log.error({ err, id }, "Construction pipeline failed");
        await db.update(constructionExtractionsTable)
          .set({ status: "failed", errorMessage: err instanceof Error ? err.message : "Unknown", updatedAt: new Date() })
          .where(eq(constructionExtractionsTable.id, id));
      } finally {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      }
    })();
  }
});

export default router;
