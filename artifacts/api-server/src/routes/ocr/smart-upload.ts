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
    const proc = spawn("python3", [scriptPath, ...args], { timeout: 20 * 60 * 1000 });
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

  const tmpPath = path.join(
    os.tmpdir(),
    `smart_${Date.now()}_${file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`
  );
  fs.writeFileSync(tmpPath, file.buffer);

  let detection: DetectResult;
  try {
    detection = await detectPdf(tmpPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    res.status(500).json({ error: err instanceof Error ? err.message : "Detection failed" });
    return;
  }

  const pageSize = detection.page_width_pts && detection.page_height_pts
    ? `${(detection.page_width_pts / 72).toFixed(1)}"×${(detection.page_height_pts / 72).toFixed(1)}"`
    : null;
  const aiBaseUrl = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"] ?? "";
  const aiApiKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] ?? "";
  const cwd = process.cwd();

  const isFinancial = detection.type === "change_order" || detection.type === "invoice" || detection.type === "receipt";
  const isSpec = detection.type === "spec_pdf";

  if (isFinancial) {
    const [record] = await db
      .insert(financialExtractionsTable)
      .values({ fileName: file.originalname, status: "processing", totalPages: 0, documents: [], processingTimeMs: 0 })
      .returning();

    res.json({
      detectedType: detection.type,
      pipeline: "financial-extractions",
      id: record.id,
      reason: detection.reason,
      pages: detection.total_pages,
      pageSize,
      avgWordsPerPage: detection.avg_words_per_page,
    });

    void (async () => {
      const scriptPath = path.resolve(cwd, "../../scripts/financial_processor.py");
      try {
        const r = await runScript(scriptPath, [tmpPath, aiBaseUrl, aiApiKey]) as {
          total_pages: number; detected_type: string; documents: unknown[]; processing_time_ms: number;
        };
        await db.update(financialExtractionsTable)
          .set({ status: "completed", totalPages: r.total_pages, detectedType: r.detected_type, documents: r.documents as never[], processingTimeMs: r.processing_time_ms, updatedAt: new Date() })
          .where(eq(financialExtractionsTable.id, record.id));
      } catch (err) {
        req.log.error({ err }, "Smart financial pipeline failed");
        await db.update(financialExtractionsTable)
          .set({ status: "failed", errorMessage: err instanceof Error ? err.message : "Unknown", updatedAt: new Date() })
          .where(eq(financialExtractionsTable.id, record.id));
      } finally {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      }
    })();

  } else if (isSpec) {
    const [record] = await db
      .insert(specExtractionsTable)
      .values({ fileName: file.originalname, status: "processing", totalPages: 0, sections: [], processingTimeMs: 0 })
      .returning();

    res.json({ detectedType: detection.type, pipeline: "spec-extractions", id: record.id, reason: detection.reason, pages: detection.total_pages, pageSize, avgWordsPerPage: detection.avg_words_per_page });

    void (async () => {
      const scriptPath = path.resolve(cwd, "../../scripts/spec_processor.py");
      try {
        const r = await runScript(scriptPath, [tmpPath, aiBaseUrl, aiApiKey]) as {
          total_pages: number; project_name: string; sections: unknown[]; processing_time_ms: number;
        };
        await db.update(specExtractionsTable)
          .set({ status: "completed", totalPages: r.total_pages, projectName: r.project_name || null, sections: r.sections, processingTimeMs: r.processing_time_ms, updatedAt: new Date() })
          .where(eq(specExtractionsTable.id, record.id));
      } catch (err) {
        req.log.error({ err }, "Smart spec pipeline failed");
        await db.update(specExtractionsTable)
          .set({ status: "failed", errorMessage: err instanceof Error ? err.message : "Unknown", updatedAt: new Date() })
          .where(eq(specExtractionsTable.id, record.id));
      } finally {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      }
    })();

  } else {
    const [record] = await db
      .insert(constructionExtractionsTable)
      .values({ fileName: file.originalname, status: "processing", totalPages: 0, pages: [], processingTimeMs: 0 })
      .returning();

    res.json({ detectedType: detection.type, pipeline: "pdf-extractions", id: record.id, reason: detection.reason, pages: detection.total_pages, pageSize, avgWordsPerPage: detection.avg_words_per_page });

    void (async () => {
      const scriptPath = path.resolve(cwd, "../../scripts/pdf_processor.py");
      try {
        const r = await runScript(scriptPath, [tmpPath, aiBaseUrl, aiApiKey]) as {
          total_pages: number; pages: unknown[]; processing_time_ms: number;
        };
        await db.update(constructionExtractionsTable)
          .set({ status: "completed", totalPages: r.total_pages, pages: r.pages, processingTimeMs: r.processing_time_ms, updatedAt: new Date() })
          .where(eq(constructionExtractionsTable.id, record.id));
      } catch (err) {
        req.log.error({ err }, "Smart construction pipeline failed");
        await db.update(constructionExtractionsTable)
          .set({ status: "failed", errorMessage: err instanceof Error ? err.message : "Unknown", updatedAt: new Date() })
          .where(eq(constructionExtractionsTable.id, record.id));
      } finally {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      }
    })();
  }
});

export default router;
