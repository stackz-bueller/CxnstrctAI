import { Router, type IRouter } from "express";
import multer from "multer";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import { db } from "@workspace/db";
import { constructionExtractionsTable } from "@workspace/db/schema";
import { GetPdfExtractionParams } from "@workspace/api-zod";
import { eq } from "drizzle-orm";

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

  // Create a temp file for the PDF (Python script needs a file path)
  const tmpDir = os.tmpdir();
  const tmpPath = path.join(tmpDir, `upload_${Date.now()}_${file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`);
  fs.writeFileSync(tmpPath, file.buffer);

  // Create the extraction record immediately
  const [extraction] = await db
    .insert(constructionExtractionsTable)
    .values({
      fileName: file.originalname,
      status: "processing",
      totalPages: 0,
      processedPages: 0,
      pages: [],
      processingTimeMs: 0,
    })
    .returning();

  // Return immediately with pending record, process in background
  res.json(formatExtraction(extraction));

  // Run the Python pipeline in background
  (async () => {
    try {
      const aiBaseUrl = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"] ?? "";
      const aiApiKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] ?? "";
      const scriptPath = path.resolve(process.cwd(), "../../scripts/pdf_processor.py");

      const result = await runPythonPipeline(scriptPath, tmpPath, aiBaseUrl, aiApiKey);

      await db
        .update(constructionExtractionsTable)
        .set({
          status: "completed",
          totalPages: result.total_pages,
          processedPages: result.pages.length,
          pages: result.pages,
          processingTimeMs: result.processing_time_ms,
          updatedAt: new Date(),
        })
        .where(eq(constructionExtractionsTable.id, extraction.id));
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
      // Clean up temp file
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
      timeout: 10 * 60 * 1000, // 10 min max
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

export default router;
