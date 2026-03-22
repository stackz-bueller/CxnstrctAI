import app from "./app";
import { logger } from "./lib/logger";
import { db } from "@workspace/db";
import { projectDocumentsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

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

app.listen(port, async (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  await resetStuckIndexing();
});
