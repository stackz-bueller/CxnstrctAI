import { pgTable, serial, text, jsonb, integer, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const financialLineItemSchema = z.object({
  description: z.string(),
  quantity: z.string().nullable(),
  unit: z.string().nullable(),
  unit_price: z.string().nullable(),
  extension: z.string().nullable(),
  trade: z.string().nullable(),
  hours: z.string().nullable(),
  rate: z.string().nullable(),
  part_number: z.string().nullable(),
});

export const financialDocumentSchema = z.object({
  type: z.enum(["change_order", "invoice", "receipt", "other"]),
  page_start: z.number(),
  page_end: z.number(),
  fields: z.record(z.string(), z.unknown()),
  line_items: z.array(financialLineItemSchema),
  totals: z.record(z.string(), z.unknown()),
  raw_text: z.string(),
});

export type FinancialDocument = z.infer<typeof financialDocumentSchema>;
export type FinancialLineItem = z.infer<typeof financialLineItemSchema>;

export const financialExtractionsTable = pgTable("financial_extractions", {
  id: serial("id").primaryKey(),
  fileName: text("file_name").notNull(),
  status: text("status").notNull().default("processing"),
  totalPages: integer("total_pages").notNull().default(0),
  detectedType: text("detected_type"),
  documents: jsonb("documents").notNull().$type<FinancialDocument[]>().default([]),
  processingTimeMs: integer("processing_time_ms").notNull().default(0),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type FinancialExtraction = typeof financialExtractionsTable.$inferSelect;
