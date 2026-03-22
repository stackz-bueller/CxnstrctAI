import { pgTable, serial, text, jsonb, integer, real, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const projectsTable = pgTable("projects", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertProjectSchema = createInsertSchema(projectsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertProject = z.infer<typeof insertProjectSchema>;
export type Project = typeof projectsTable.$inferSelect;

export const projectDocumentsTable = pgTable("project_documents", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull(),
  documentType: text("document_type").notNull(), // "spec" | "construction" | "financial" | "ocr"
  documentId: integer("document_id").notNull(),
  documentName: text("document_name").notNull(),
  indexStatus: text("index_status").notNull().default("pending"), // "pending" | "indexing" | "indexed" | "failed"
  chunkCount: integer("chunk_count").notNull().default(0),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertProjectDocumentSchema = createInsertSchema(projectDocumentsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertProjectDocument = z.infer<typeof insertProjectDocumentSchema>;
export type ProjectDocument = typeof projectDocumentsTable.$inferSelect;

export const documentChunksTable = pgTable("document_chunks", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull(),
  projectDocumentId: integer("project_document_id").notNull(),
  documentType: text("document_type").notNull(),
  documentId: integer("document_id").notNull(),
  chunkIndex: integer("chunk_index").notNull(),
  content: text("content").notNull(),
  sectionLabel: text("section_label"),
  embedding: jsonb("embedding").$type<number[]>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type DocumentChunk = typeof documentChunksTable.$inferSelect;

export const projectChatsTable = pgTable("project_chats", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull(),
  role: text("role").notNull(), // "user" | "assistant"
  content: text("content").notNull(),
  sources: jsonb("sources").$type<ChatSource[]>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const chatSourceSchema = z.object({
  documentName: z.string(),
  documentType: z.string(),
  sectionLabel: z.string().nullable(),
  excerpt: z.string(),
});

export type ChatSource = z.infer<typeof chatSourceSchema>;
export type ProjectChat = typeof projectChatsTable.$inferSelect;
