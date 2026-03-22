import { pgTable, serial, text, jsonb, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const specSubsectionSchema = z.object({
  identifier: z.string(),
  title: z.string().nullable(),
  content: z.string(),
});

export const specPartSchema = z.object({
  name: z.string(),
  subsections: z.array(specSubsectionSchema),
});

export const specSectionSchema = z.object({
  section_number: z.string(),
  section_title: z.string(),
  division_number: z.string(),
  division_title: z.string(),
  page_start: z.number(),
  page_end: z.number(),
  parts: z.array(specPartSchema),
  full_text: z.string(),
});

export type SpecSection = z.infer<typeof specSectionSchema>;

export const specExtractionsTable = pgTable("spec_extractions", {
  id: serial("id").primaryKey(),
  fileName: text("file_name").notNull(),
  status: text("status").notNull().default("processing"),
  totalPages: integer("total_pages").notNull().default(0),
  projectName: text("project_name"),
  sections: jsonb("sections").notNull().$type<SpecSection[]>().default([]),
  processingTimeMs: integer("processing_time_ms").notNull().default(0),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertSpecExtractionSchema = createInsertSchema(specExtractionsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertSpecExtraction = z.infer<typeof insertSpecExtractionSchema>;
export type SpecExtraction = typeof specExtractionsTable.$inferSelect;
