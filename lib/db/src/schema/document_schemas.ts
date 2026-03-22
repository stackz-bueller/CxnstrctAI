import { pgTable, serial, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const schemaFieldSchema = z.object({
  name: z.string(),
  label: z.string(),
  type: z.enum(["string", "number", "date", "boolean", "array"]),
  description: z.string(),
  required: z.boolean(),
  example: z.string().optional(),
});

export type SchemaField = z.infer<typeof schemaFieldSchema>;

export const documentSchemasTable = pgTable("document_schemas", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  fields: jsonb("fields").notNull().$type<SchemaField[]>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertDocumentSchemaSchema = createInsertSchema(documentSchemasTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const selectDocumentSchemaSchema = createSelectSchema(documentSchemasTable);

export type InsertDocumentSchema = z.infer<typeof insertDocumentSchemaSchema>;
export type DocumentSchema = typeof documentSchemasTable.$inferSelect;
