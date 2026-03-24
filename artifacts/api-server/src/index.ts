import app from "./app";
import { logger } from "./lib/logger";
import { db } from "@workspace/db";
import { documentChunksTable, projectDocumentsTable, constructionExtractionsTable } from "@workspace/db";
import { eq, and, isNull } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { embed } from "./lib/embedder.js";
import { repairIncompleteExtraction } from "./lib/integrity.js";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function resetStuckIndexing() {
  try {
    const result = await db
      .update(projectDocumentsTable)
      .set({ indexStatus: "failed", errorMessage: "Indexing was interrupted by a server restart. Click retry to re-index." })
      .where(eq(projectDocumentsTable.indexStatus, "indexing"))
      .returning({ id: projectDocumentsTable.id });
    if (result.length > 0) {
      logger.warn({ count: result.length }, "Reset stuck indexing documents to failed on startup");
    }
  } catch (err) {
    logger.error({ err }, "Failed to reset stuck indexing documents");
  }
}

async function runIntegrityCheck() {
  try {
    const { checkExtractionIntegrity } = await import("./lib/integrity.js");
    const issues = await checkExtractionIntegrity();
    if (issues.length > 0) {
      logger.warn({ count: issues.length, issues: issues.map((i) => ({
        id: i.extractionId,
        file: i.fileName,
        pages: `${i.processedPages}/${i.totalPages}`,
      })) }, "Found incomplete extractions on startup — marked as incomplete");
    } else {
      logger.info("Extraction integrity check passed — all extractions complete");
    }
  } catch (err) {
    logger.error({ err }, "Extraction integrity check failed");
  }
}

async function backfillEmbeddings() {
  try {
    const rows = await db.execute<{ id: number; content: string }>(sql`
      SELECT id, content FROM document_chunks
      WHERE embedding IS NULL
      ORDER BY id
    `);
    if (rows.rows.length === 0) return;

    logger.info({ count: rows.rows.length }, "Backfilling vector embeddings for existing chunks");

    const BATCH = 16;
    for (let i = 0; i < rows.rows.length; i += BATCH) {
      const batch = rows.rows.slice(i, i + BATCH);
      try {
        const vectors = await embed(batch.map((r) => r.content));
        for (let j = 0; j < batch.length; j++) {
          const vec = vectors[j];
          if (!vec) continue;
          await db.execute(sql`
            UPDATE document_chunks
            SET embedding = ${`[${vec.join(",")}]`}::vector
            WHERE id = ${batch[j].id}
          `);
        }
        logger.info({ done: Math.min(i + BATCH, rows.rows.length), total: rows.rows.length }, "Embedding backfill progress");
      } catch (batchErr) {
        logger.error({ err: batchErr, batchStart: i }, "Backfill batch failed, skipping");
      }
    }
    logger.info("Vector embedding backfill complete");
  } catch (err) {
    logger.error({ err }, "Backfill embeddings failed");
  }
}

app.listen(port, async (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  await resetStuckIndexing();
  await runIntegrityCheck();
  backfillEmbeddings();
});
