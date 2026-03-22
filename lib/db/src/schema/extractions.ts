import { pgTable, serial, integer, text, jsonb, timestamp, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { documentSchemasTable } from "./document_schemas";

export const extractedFieldSchema = z.object({
  name: z.string(),
  label: z.string(),
  value: z.unknown().nullable(),
  confidence: z.number(),
  present: z.boolean(),
});

export type ExtractedField = z.infer<typeof extractedFieldSchema>;

export const extractionsTable = pgTable("extractions", {
  id: serial("id").primaryKey(),
  schemaId: integer("schema_id")
    .notNull()
    .references(() => documentSchemasTable.id, { onDelete: "cascade" }),
  fileName: text("file_name").notNull(),
  fileType: text("file_type").notNull(),
  status: text("status").notNull().default("pending"),
  rawText: text("raw_text"),
  fields: jsonb("fields").notNull().$type<ExtractedField[]>().default([]),
  overallConfidence: real("overall_confidence").notNull().default(0),
  processingTimeMs: integer("processing_time_ms").notNull().default(0),
  errorMessage: text("error_message"),
  imageData: text("image_data"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertExtractionSchema = createInsertSchema(extractionsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertExtraction = z.infer<typeof insertExtractionSchema>;
export type Extraction = typeof extractionsTable.$inferSelect;
