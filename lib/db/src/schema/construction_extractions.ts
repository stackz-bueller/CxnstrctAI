import { pgTable, serial, text, jsonb, integer, real, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const constructionTitleBlockSchema = z.object({
  project_name: z.string().nullable(),
  drawing_title: z.string().nullable(),
  sheet_number: z.string().nullable(),
  revision: z.string().nullable(),
  date: z.string().nullable(),
  drawn_by: z.string().nullable(),
  scale: z.string().nullable(),
  confidence: z.number(),
});

export const constructionRevisionSchema = z.object({
  rev_number: z.string().nullable(),
  date: z.string().nullable(),
  description: z.string().nullable(),
});

export const constructionCalloutSchema = z.object({
  text: z.string(),
  type: z.string(),
});

export const constructionLegendSchema = z.object({
  symbol: z.string(),
  description: z.string(),
});

export const constructionTableSchema = z.object({
  title: z.string().optional(),
  headers: z.array(z.string()).optional(),
  rows: z.array(z.array(z.string())).optional(),
  raw_text: z.string().optional(),
});

export const constructionPageResultSchema = z.object({
  page_number: z.number(),
  extraction_method: z.string(),
  title_block: constructionTitleBlockSchema,
  revision_history: z.array(constructionRevisionSchema),
  general_notes: z.array(z.string()),
  tables: z.array(constructionTableSchema).optional().default([]),
  callouts: z.array(constructionCalloutSchema),
  legends: z.array(constructionLegendSchema),
  all_text: z.string(),
  ocr_confidence: z.number(),
});

export type ConstructionPageResult = z.infer<typeof constructionPageResultSchema>;

export const constructionExtractionsTable = pgTable("construction_extractions", {
  id: serial("id").primaryKey(),
  fileName: text("file_name").notNull(),
  status: text("status").notNull().default("processing"),
  totalPages: integer("total_pages").notNull().default(0),
  processedPages: integer("processed_pages").notNull().default(0),
  pages: jsonb("pages").notNull().$type<ConstructionPageResult[]>().default([]),
  processingTimeMs: integer("processing_time_ms").notNull().default(0),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertConstructionExtractionSchema = createInsertSchema(constructionExtractionsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertConstructionExtraction = z.infer<typeof insertConstructionExtractionSchema>;
export type ConstructionExtraction = typeof constructionExtractionsTable.$inferSelect;
