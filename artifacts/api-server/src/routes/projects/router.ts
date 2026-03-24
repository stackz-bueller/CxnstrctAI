import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  projectsTable,
  projectDocumentsTable,
  projectChatsTable,
  documentChunksTable,
  specExtractionsTable,
  constructionExtractionsTable,
  financialExtractionsTable,
  extractionsTable,
} from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { z } from "zod";
import { openai } from "@workspace/integrations-openai-ai-server";
import { indexProjectDocument, keywordSearch, validateConstructionData } from "./indexer";
import type { ConstructionPageResult } from "@workspace/db";

const router: IRouter = Router();

// ─── Projects CRUD ────────────────────────────────────────────────────────────

router.get("/", async (req, res) => {
  try {
    const rows = await db
      .select()
      .from(projectsTable)
      .orderBy(desc(projectsTable.createdAt));
    res.json({ projects: rows });
  } catch (err) {
    req.log.error({ err }, "Failed to list projects");
    res.status(500).json({ error: "Failed to list projects" });
  }
});

router.post("/", async (req, res) => {
  const bodySchema = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
    return;
  }
  try {
    const [project] = await db
      .insert(projectsTable)
      .values({ name: parsed.data.name, description: parsed.data.description ?? null })
      .returning();
    res.status(201).json(project);
  } catch (err) {
    req.log.error({ err }, "Failed to create project");
    res.status(500).json({ error: "Failed to create project" });
  }
});

router.get("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, id));
    if (!project) { res.status(404).json({ error: "Project not found" }); return; }
    const documents = await db
      .select()
      .from(projectDocumentsTable)
      .where(eq(projectDocumentsTable.projectId, id))
      .orderBy(projectDocumentsTable.createdAt);
    res.json({ ...project, documents });
  } catch (err) {
    req.log.error({ err }, "Failed to get project");
    res.status(500).json({ error: "Failed to get project" });
  }
});

router.patch("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const bodySchema = z.object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
    return;
  }
  try {
    const [updated] = await db
      .update(projectsTable)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(projectsTable.id, id))
      .returning();
    if (!updated) { res.status(404).json({ error: "Project not found" }); return; }
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Failed to update project");
    res.status(500).json({ error: "Failed to update project" });
  }
});

router.delete("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    await db.delete(documentChunksTable).where(eq(documentChunksTable.projectId, id));
    await db.delete(projectDocumentsTable).where(eq(projectDocumentsTable.projectId, id));
    await db.delete(projectChatsTable).where(eq(projectChatsTable.projectId, id));
    const [deleted] = await db.delete(projectsTable).where(eq(projectsTable.id, id)).returning();
    if (!deleted) { res.status(404).json({ error: "Project not found" }); return; }
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete project");
    res.status(500).json({ error: "Failed to delete project" });
  }
});

// ─── Project Documents ────────────────────────────────────────────────────────

router.get("/:id/documents", async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const docs = await db
      .select()
      .from(projectDocumentsTable)
      .where(eq(projectDocumentsTable.projectId, id))
      .orderBy(projectDocumentsTable.createdAt);
    res.json({ documents: docs });
  } catch (err) {
    req.log.error({ err }, "Failed to list project documents");
    res.status(500).json({ error: "Failed to list project documents" });
  }
});

router.post("/:id/documents", async (req, res) => {
  const projectId = parseInt(req.params.id);
  if (isNaN(projectId)) { res.status(400).json({ error: "Invalid id" }); return; }

  const bodySchema = z.object({
    documentType: z.enum(["spec", "construction", "financial", "ocr"]),
    documentId: z.number().int().positive(),
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
    return;
  }

  try {
    const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
    if (!project) { res.status(404).json({ error: "Project not found" }); return; }

    let documentName = "";
    const { documentType, documentId } = parsed.data;

    if (documentType === "spec") {
      const [row] = await db.select({ fileName: specExtractionsTable.fileName }).from(specExtractionsTable).where(eq(specExtractionsTable.id, documentId));
      if (!row) { res.status(404).json({ error: "Spec extraction not found" }); return; }
      documentName = row.fileName;
    } else if (documentType === "construction") {
      const [row] = await db.select({ fileName: constructionExtractionsTable.fileName }).from(constructionExtractionsTable).where(eq(constructionExtractionsTable.id, documentId));
      if (!row) { res.status(404).json({ error: "Construction extraction not found" }); return; }
      documentName = row.fileName;
    } else if (documentType === "financial") {
      const [row] = await db.select({ fileName: financialExtractionsTable.fileName }).from(financialExtractionsTable).where(eq(financialExtractionsTable.id, documentId));
      if (!row) { res.status(404).json({ error: "Financial extraction not found" }); return; }
      documentName = row.fileName;
    } else if (documentType === "ocr") {
      const [row] = await db.select({ fileName: extractionsTable.fileName }).from(extractionsTable).where(eq(extractionsTable.id, documentId));
      if (!row) { res.status(404).json({ error: "OCR extraction not found" }); return; }
      documentName = row.fileName;
    }

    const existing = await db
      .select()
      .from(projectDocumentsTable)
      .where(
        and(
          eq(projectDocumentsTable.projectId, projectId),
          eq(projectDocumentsTable.documentType, documentType),
          eq(projectDocumentsTable.documentId, documentId),
        )
      );
    if (existing.length > 0) {
      res.status(409).json({ error: "Document already added to this project" });
      return;
    }

    const [projectDoc] = await db
      .insert(projectDocumentsTable)
      .values({ projectId, documentType, documentId, documentName, indexStatus: "pending" })
      .returning();

    res.status(201).json(projectDoc);

    (async () => {
      try {
        await indexProjectDocument(projectId, projectDoc.id, documentType, documentId);
      } catch (err) {
        req.log.error({ err }, "Background indexing failed for project document");
      }
    })();
  } catch (err) {
    req.log.error({ err }, "Failed to add project document");
    res.status(500).json({ error: "Failed to add project document" });
  }
});

router.delete("/:id/documents/:docId", async (req, res) => {
  const projectId = parseInt(req.params.id);
  const docId = parseInt(req.params.docId);
  if (isNaN(projectId) || isNaN(docId)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    await db
      .delete(documentChunksTable)
      .where(
        and(
          eq(documentChunksTable.projectId, projectId),
          eq(documentChunksTable.projectDocumentId, docId),
        )
      );
    const [deleted] = await db
      .delete(projectDocumentsTable)
      .where(
        and(
          eq(projectDocumentsTable.id, docId),
          eq(projectDocumentsTable.projectId, projectId),
        )
      )
      .returning();
    if (!deleted) { res.status(404).json({ error: "Document not found" }); return; }
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to remove project document");
    res.status(500).json({ error: "Failed to remove project document" });
  }
});

router.get("/:id/documents/:docId/validate", async (req, res) => {
  const projectId = parseInt(req.params.id);
  const docId = parseInt(req.params.docId);
  if (isNaN(projectId) || isNaN(docId)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const [doc] = await db
      .select()
      .from(projectDocumentsTable)
      .where(
        and(
          eq(projectDocumentsTable.id, docId),
          eq(projectDocumentsTable.projectId, projectId),
        )
      );
    if (!doc) { res.status(404).json({ error: "Document not found" }); return; }

    if (doc.documentType !== "construction") {
      res.json({ warnings: [], message: "Validation only applies to construction documents" });
      return;
    }

    const [extraction] = await db
      .select({ pages: constructionExtractionsTable.pages })
      .from(constructionExtractionsTable)
      .where(eq(constructionExtractionsTable.id, doc.documentId));

    if (!extraction?.pages) {
      res.json({ warnings: [], message: "No extraction data found" });
      return;
    }

    const warnings = validateConstructionData(extraction.pages as ConstructionPageResult[]);
    res.json({
      warnings,
      summary: {
        total: warnings.length,
        byType: {
          missing_sequential_id: warnings.filter(w => w.type === "missing_sequential_id").length,
          non_standard_pipe_size: warnings.filter(w => w.type === "non_standard_pipe_size").length,
          truncated_table: warnings.filter(w => w.type === "truncated_table").length,
        },
      },
    });
  } catch (err) {
    req.log.error({ err }, "Validation failed");
    res.status(500).json({ error: "Validation failed" });
  }
});

router.post("/:id/documents/:docId/reindex", async (req, res) => {
  const projectId = parseInt(req.params.id);
  const docId = parseInt(req.params.docId);
  if (isNaN(projectId) || isNaN(docId)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const [doc] = await db
      .select()
      .from(projectDocumentsTable)
      .where(
        and(
          eq(projectDocumentsTable.id, docId),
          eq(projectDocumentsTable.projectId, projectId),
        )
      );
    if (!doc) { res.status(404).json({ error: "Document not found" }); return; }

    res.json({ success: true, message: "Reindexing started" });

    (async () => {
      try {
        await indexProjectDocument(projectId, docId, doc.documentType, doc.documentId);
      } catch (err) {
        req.log.error({ err }, "Reindex failed");
      }
    })();
  } catch (err) {
    req.log.error({ err }, "Failed to start reindex");
    res.status(500).json({ error: "Failed to start reindex" });
  }
});

// ─── Chat History ─────────────────────────────────────────────────────────────

router.get("/:id/chat", async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const messages = await db
      .select()
      .from(projectChatsTable)
      .where(eq(projectChatsTable.projectId, id))
      .orderBy(projectChatsTable.createdAt);
    res.json({ messages });
  } catch (err) {
    req.log.error({ err }, "Failed to get chat history");
    res.status(500).json({ error: "Failed to get chat history" });
  }
});

router.delete("/:id/chat", async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    await db.delete(projectChatsTable).where(eq(projectChatsTable.projectId, id));
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to clear chat history");
    res.status(500).json({ error: "Failed to clear chat history" });
  }
});

// ─── Chat / RAG ──────────────────────────────────────────────────────────────

router.post("/:id/chat", async (req, res) => {
  const projectId = parseInt(req.params.id);
  if (isNaN(projectId)) { res.status(400).json({ error: "Invalid id" }); return; }

  const bodySchema = z.object({ question: z.string().min(1).max(2000) });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
    return;
  }

  const { question } = parsed.data;

  try {
    const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
    if (!project) { res.status(404).json({ error: "Project not found" }); return; }

    const indexedDocs = await db
      .select()
      .from(projectDocumentsTable)
      .where(
        and(
          eq(projectDocumentsTable.projectId, projectId),
          eq(projectDocumentsTable.indexStatus, "indexed"),
        )
      );

    if (indexedDocs.length === 0) {
      const reply = "No indexed documents found for this project yet. Please add documents and wait for them to finish indexing before asking questions.";
      await db.insert(projectChatsTable).values({ projectId, role: "user", content: question, sources: [] });
      const [msg] = await db.insert(projectChatsTable).values({ projectId, role: "assistant", content: reply, sources: [] }).returning();
      res.json({ message: msg, sources: [] });
      return;
    }

    const relevantChunks = await keywordSearch(projectId, question, 25);

    await db.insert(projectChatsTable).values({ projectId, role: "user", content: question, sources: [] });

    if (relevantChunks.length === 0) {
      const reply = "I could not find relevant information in the project documents to answer that question. The documents may not contain this information, or the terms used may differ from what was extracted.";
      const [msg] = await db.insert(projectChatsTable).values({ projectId, role: "assistant", content: reply, sources: [] }).returning();
      res.json({ message: msg, sources: [] });
      return;
    }

    let usedChunks = relevantChunks;

    if (relevantChunks.length > 12) {
      try {
        const rerankPrompt = `Given this question: "${question}"

Rate each document chunk below from 0-10 for relevance. Return ONLY a JSON array of numbers, one score per chunk, in order. Example: [8, 2, 9, 0, ...]

Chunks:
${relevantChunks.map((c, i) => `[${i}] ${c.content.slice(0, 400)}`).join("\n\n")}`;

        const rerankResult = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [{ role: "user", content: rerankPrompt }],
          temperature: 0,
          max_tokens: 200,
        });

        const scoresText = rerankResult.choices[0]?.message?.content ?? "";
        const scoresMatch = scoresText.match(/\[[\d\s,]+\]/);
        if (scoresMatch) {
          const scores: number[] = JSON.parse(scoresMatch[0]);
          if (scores.length === relevantChunks.length) {
            const scored = relevantChunks.map((c, i) => ({ chunk: c, score: scores[i] ?? 0 }));
            scored.sort((a, b) => b.score - a.score);
            usedChunks = scored
              .filter((s) => s.score >= 3)
              .slice(0, 15)
              .map((s) => s.chunk);
            if (usedChunks.length < 5) {
              usedChunks = scored.slice(0, 10).map((s) => s.chunk);
            }
          }
        }
      } catch (rerankErr) {
        console.error("Rerank failed, using original ranking:", rerankErr);
      }
    }

    const contextBlock = usedChunks
      .map((c, i) => `[Source ${i + 1}: ${c.documentName}${c.sectionLabel ? " / " + c.sectionLabel : ""}]\n${c.content}`)
      .join("\n\n---\n\n");

    const systemPrompt = `You are a construction project assistant for the project "${project.name}". Lives and millions of dollars depend on the accuracy of your answers.

ABSOLUTE RULES:
1. Answer ONLY from the provided document excerpts. NEVER use outside knowledge or invent any value.
2. If the documents do not contain the answer, say "This information was not found in the project documents" — do NOT guess.
3. When citing numbers (dimensions, quantities, diameters, PSI values, densities, percentages), quote the EXACT value from the source. Never round, approximate, or paraphrase numerical data.
4. Always cite the source document and section/page for every factual claim.
5. If multiple sources give conflicting values for the same item, report ALL values and flag the conflict explicitly.
6. If the source data contains DATA QUALITY WARNINGS, mention relevant warnings so the user knows about known gaps or conflicts.
7. Be thorough: scan ALL provided excerpts before answering — the answer may be in a less obvious source. Construction documents use varied terminology (e.g., "invert" may appear as "bottom elevation", "rim" as "top elevation", "catch basin" as "inlet"). Report the data you find even if the terminology doesn't match the question exactly, and note the difference.
8. When asked about project-level information (location, owner, engineer, contractor), distinguish between the construction SITE and the office/contact information. Prioritize the actual site data.

FORMAT: Use clear structure. For tables, use markdown tables. For lists, use bullet points. Always end with source references.`;

    const userMessage = `Project documents (context only — do not answer outside this):\n\n${contextBlock}\n\n---\n\nQuestion: ${question}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      temperature: 0.05,
      max_tokens: 2000,
    });

    const answer = completion.choices[0]?.message?.content ?? "No response generated.";

    const sources = usedChunks.slice(0, 5).map((c) => ({
      documentName: c.documentName,
      documentType: c.documentType,
      sectionLabel: c.sectionLabel,
      excerpt: c.content.slice(0, 300) + (c.content.length > 300 ? "…" : ""),
    }));

    const [msg] = await db
      .insert(projectChatsTable)
      .values({ projectId, role: "assistant", content: answer, sources })
      .returning();

    res.json({ message: msg, sources });
  } catch (err) {
    req.log.error({ err }, "Failed to process chat question");
    res.status(500).json({ error: "Failed to process question" });
  }
});

export default router;
