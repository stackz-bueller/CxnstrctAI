import { pgTable, serial, text, integer, real, timestamp, jsonb } from "drizzle-orm/pg-core";

export const costEventsTable = pgTable("cost_events", {
  id: serial("id").primaryKey(),
  category: text("category").notNull(),
  operation: text("operation").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  estimatedCostUsd: real("estimated_cost_usd").notNull().default(0),
  extractionId: integer("extraction_id"),
  projectId: integer("project_id"),
  documentType: text("document_type"),
  fileName: text("file_name"),
  pageNumber: integer("page_number"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type CostEvent = typeof costEventsTable.$inferSelect;
export type InsertCostEvent = typeof costEventsTable.$inferInsert;
