import { Router, type IRouter } from "express";
import multer from "multer";
import { db } from "@workspace/db";
import { documentSchemasTable, extractionsTable } from "@workspace/db/schema";
import { ListExtractionsQueryParams, GetExtractionParams, GetExtractionRawTextParams } from "@workspace/api-zod";
import { eq, and, isNotNull } from "drizzle-orm";
import { runExtractionPipeline, computeOverallConfidence } from "./extraction-pipeline.js";

const router: IRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/bmp"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are supported (JPEG, PNG, WEBP, GIF, BMP)"));
    }
  },
});

function formatExtraction(extraction: typeof extractionsTable.$inferSelect, schemaName: string) {
  return {
    id: extraction.id,
    schemaId: extraction.schemaId,
    schemaName,
    fileName: extraction.fileName,
    fileType: extraction.fileType,
    status: extraction.status,
    fields: extraction.fields ?? [],
    overallConfidence: extraction.overallConfidence,
    processingTimeMs: extraction.processingTimeMs,
    errorMessage: extraction.errorMessage ?? null,
    createdAt: extraction.createdAt.toISOString(),
    updatedAt: extraction.updatedAt.toISOString(),
  };
}

router.get("/", async (req, res) => {
  try {
    const query = ListExtractionsQueryParams.safeParse(req.query);
    const schemaId = query.success && query.data.schemaId ? query.data.schemaId : undefined;

    const rows = await db
      .select({
        extraction: extractionsTable,
        schemaName: documentSchemasTable.name,
      })
      .from(extractionsTable)
      .leftJoin(documentSchemasTable, eq(extractionsTable.schemaId, documentSchemasTable.id))
      .where(schemaId ? eq(extractionsTable.schemaId, schemaId) : undefined)
      .orderBy(extractionsTable.createdAt);

    const extractions = rows.map((r) =>
      formatExtraction(r.extraction, r.schemaName ?? "Unknown Schema"),
    );

    res.json({ extractions });
  } catch (err) {
    req.log.error({ err }, "Failed to list extractions");
    res.status(500).json({ error: "Failed to list extractions" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const { id } = GetExtractionParams.parse({ id: parseInt(req.params.id) });
    const [row] = await db
      .select({
        extraction: extractionsTable,
        schemaName: documentSchemasTable.name,
      })
      .from(extractionsTable)
      .leftJoin(documentSchemasTable, eq(extractionsTable.schemaId, documentSchemasTable.id))
      .where(eq(extractionsTable.id, id));

    if (!row) {
      res.status(404).json({ error: "Extraction not found" });
      return;
    }

    res.json(formatExtraction(row.extraction, row.schemaName ?? "Unknown Schema"));
  } catch (err) {
    req.log.error({ err }, "Failed to get extraction");
    res.status(500).json({ error: "Failed to get extraction" });
  }
});

router.get("/:id/raw-text", async (req, res) => {
  try {
    const { id } = GetExtractionRawTextParams.parse({ id: parseInt(req.params.id) });
    const [extraction] = await db
      .select()
      .from(extractionsTable)
      .where(eq(extractionsTable.id, id));

    if (!extraction) {
      res.status(404).json({ error: "Extraction not found" });
      return;
    }

    res.json({ rawText: extraction.rawText ?? "" });
  } catch (err) {
    req.log.error({ err }, "Failed to get raw text");
    res.status(500).json({ error: "Failed to get raw text" });
  }
});

router.post("/upload", upload.single("file"), async (req, res) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "No file uploaded" });
    return;
  }

  const schemaIdRaw = req.body?.schemaId;
  const schemaId = parseInt(schemaIdRaw);
  if (isNaN(schemaId)) {
    res.status(400).json({ error: "schemaId is required" });
    return;
  }

  const [schema] = await db
    .select()
    .from(documentSchemasTable)
    .where(eq(documentSchemasTable.id, schemaId));

  if (!schema) {
    res.status(404).json({ error: "Schema not found" });
    return;
  }

  const imageBase64 = file.buffer.toString("base64");

  const [extraction] = await db
    .insert(extractionsTable)
    .values({
      schemaId,
      fileName: file.originalname,
      fileType: file.mimetype,
      status: "processing",
      imageData: imageBase64,
      fields: [],
      overallConfidence: 0,
      processingTimeMs: 0,
    })
    .returning();

  res.json(formatExtraction(extraction, schema.name));

  (async () => {
    try {
      const { rawText, fields, processingTimeMs } = await runExtractionPipeline(
        imageBase64,
        file.mimetype,
        schema.fields as Parameters<typeof runExtractionPipeline>[2],
        schema.name,
        schema.description,
      );

      const overallConfidence = computeOverallConfidence(fields);

      await db
        .update(extractionsTable)
        .set({
          status: "completed",
          rawText,
          fields,
          overallConfidence,
          processingTimeMs,
          updatedAt: new Date(),
        })
        .where(eq(extractionsTable.id, extraction.id));
    } catch (err) {
      req.log.error({ err }, "Extraction pipeline failed");
      await db
        .update(extractionsTable)
        .set({
          status: "failed",
          errorMessage: err instanceof Error ? err.message : "Unknown error",
          updatedAt: new Date(),
        })
        .where(eq(extractionsTable.id, extraction.id));
    }
  })();
});

export default router;
