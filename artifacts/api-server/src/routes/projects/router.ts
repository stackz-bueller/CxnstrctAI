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
  unansweredQuestionsTable,
  dataCorrectionsTable,
  verifiedFactsTable,
} from "@workspace/db";
import { eq, and, desc, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { openai } from "@workspace/integrations-openai-ai-server";
import { indexProjectDocument, keywordSearch, validateConstructionData } from "./indexer";
import type { ConstructionPageResult } from "@workspace/db";
import { repairIncompleteExtraction } from "../../lib/integrity.js";

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

    const constructionDocIds = documents
      .filter((d) => d.documentType === "construction")
      .map((d) => d.documentId);

    let extractionProgress: Record<number, { status: string; processedPages: number; totalPages: number }> = {};
    if (constructionDocIds.length > 0) {
      const extractions = await db
        .select({
          id: constructionExtractionsTable.id,
          status: constructionExtractionsTable.status,
          processedPages: constructionExtractionsTable.processedPages,
          totalPages: constructionExtractionsTable.totalPages,
        })
        .from(constructionExtractionsTable)
        .where(sql`${constructionExtractionsTable.id} IN (${sql.join(constructionDocIds.map((id) => sql`${id}`), sql`, `)})`);
      for (const ext of extractions) {
        extractionProgress[ext.id] = { status: ext.status, processedPages: ext.processedPages, totalPages: ext.totalPages };
      }
    }

    const enrichedDocs = documents.map((doc) => {
      if (doc.documentType === "construction" && extractionProgress[doc.documentId]) {
        return { ...doc, extractionProgress: extractionProgress[doc.documentId] };
      }
      return doc;
    });

    res.json({ ...project, documents: enrichedDocs });
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
      const [row] = await db.select({
        fileName: constructionExtractionsTable.fileName,
        status: constructionExtractionsTable.status,
        totalPages: constructionExtractionsTable.totalPages,
        processedPages: constructionExtractionsTable.processedPages,
      }).from(constructionExtractionsTable).where(eq(constructionExtractionsTable.id, documentId));
      if (!row) { res.status(404).json({ error: "Construction extraction not found" }); return; }
      documentName = row.fileName;

      if (row.totalPages > 0 && row.processedPages < row.totalPages) {
        req.log.warn({
          documentId,
          processedPages: row.processedPages,
          totalPages: row.totalPages,
        }, "Incomplete extraction detected on attach — will auto-repair then index");
      }
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
        if (documentType === "construction") {
          const [check] = await db.select({
            totalPages: constructionExtractionsTable.totalPages,
            processedPages: constructionExtractionsTable.processedPages,
          }).from(constructionExtractionsTable).where(eq(constructionExtractionsTable.id, documentId));

          if (check && check.totalPages > 0 && check.processedPages < check.totalPages) {
            req.log.info({ documentId }, "Auto-repairing incomplete extraction before indexing");
            const repairResult = await repairIncompleteExtraction(documentId);
            req.log.info({ repairResult: repairResult.action, pages: repairResult.processedPages, total: repairResult.totalPages }, "Auto-repair finished");
          }
        }

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

    const searchStrategies: string[] = [];

    function dedupeChunks(existing: typeof relevantChunks, incoming: typeof relevantChunks) {
      const seen = new Set(existing.map(c => c.content.slice(0, 120)));
      for (const c of incoming) {
        if (!seen.has(c.content.slice(0, 120))) {
          existing.push(c);
          seen.add(c.content.slice(0, 120));
        }
      }
    }

    const [, relevantChunksResult, verifiedFacts] = await Promise.all([
      db.insert(projectChatsTable).values({ projectId, role: "user", content: question, sources: [] }),
      keywordSearch(projectId, question, 30),
      db.select().from(verifiedFactsTable)
        .where(eq(verifiedFactsTable.projectId, projectId))
        .orderBy(desc(verifiedFactsTable.createdAt))
        .limit(20),
    ]);

    let relevantChunks = relevantChunksResult;
    searchStrategies.push("hybrid_standard");

    if (relevantChunks.length < 5) {
      const words = question.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      if (words.length > 3) {
        const simplifiedQ = words.slice(0, 4).join(" ");
        const broaderChunks = await keywordSearch(projectId, simplifiedQ, 25);
        searchStrategies.push("simplified_query");
        dedupeChunks(relevantChunks, broaderChunks);
      }
    }

    if (relevantChunks.length < 3) {
      const keyTerms = question.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g);
      if (keyTerms && keyTerms.length > 0) {
        for (const term of keyTerms.slice(0, 2)) {
          const termChunks = await keywordSearch(projectId, term, 10);
          searchStrategies.push(`proper_noun:${term}`);
          dedupeChunks(relevantChunks, termChunks);
        }
      }
    }

    if (relevantChunks.length === 0) {
      req.log.info({ question }, "Zero chunks found — attempting AI reformulation before giving up");
      searchStrategies.push("zero_chunk_retry");
      try {
        const reformulateResult = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: `You are a construction document search expert. A search returned ZERO results. Generate 3-5 alternative search queries using different terminology. Think about:
- Different terminology (repoint vs tuckpoint, LF vs linear feet, UG vs undergrade vs bridge)
- CSI section numbers where this info might live
- Simpler keyword combinations
Return ONLY a JSON array of search strings.`,
            },
            { role: "user", content: `Original question: "${question}"\nProject: ${project.name}` },
          ],
          temperature: 0.3,
          max_tokens: 300,
        });
        const reformText = reformulateResult.choices[0]?.message?.content ?? "";
        const arrMatch = reformText.match(/\[[\s\S]*?\]/);
        let altQueries: string[] = [];
        if (arrMatch) {
          try { altQueries = JSON.parse(arrMatch[0]); } catch { /* ignore */ }
        }
        for (const altQ of altQueries.slice(0, 5)) {
          const chunks = await keywordSearch(projectId, altQ, 15);
          searchStrategies.push(`zr:${altQ.slice(0, 40)}`);
          dedupeChunks(relevantChunks, chunks);
        }
      } catch (retryErr) {
        req.log.error({ err: retryErr }, "Zero-chunk retry reformulation failed");
      }
    }

    if (relevantChunks.length === 0) {
      const reply = "I could not find relevant information in the project documents to answer that question. This question has been logged for review — the documents may not contain this information, or the terms used may differ from what was extracted.";
      await db.insert(unansweredQuestionsTable).values({
        projectId,
        question,
        searchStrategiesAttempted: searchStrategies,
        chunksFound: 0,
        reason: "no_chunks_after_retry",
      });
      const [msg] = await db.insert(projectChatsTable).values({
        projectId, role: "assistant", content: reply, sources: [],
        confidence: 0, searchStrategy: searchStrategies.join(","),
      }).returning();
      res.json({ message: msg, sources: [], confidence: 0 });
      return;
    }

    async function rerankChunks(chunks: typeof relevantChunks, q: string) {
      if (chunks.length <= 12) return chunks;
      try {
        const rerankPrompt = `Given this question: "${q}"

Rate each document chunk below from 0-10 for relevance. Return ONLY a JSON array of numbers, one score per chunk, in order. Example: [8, 2, 9, 0, ...]

Chunks:
${chunks.map((c, i) => `[${i}] ${c.content.slice(0, 400)}`).join("\n\n")}`;

        const rerankResult = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: rerankPrompt }],
          temperature: 0,
          max_tokens: 200,
        });

        const scoresText = rerankResult.choices[0]?.message?.content ?? "";
        const scoresMatch = scoresText.match(/\[[\d\s,]+\]/);
        if (scoresMatch) {
          const scores: number[] = JSON.parse(scoresMatch[0]);
          if (scores.length === chunks.length) {
            const scored = chunks.map((c, i) => ({ chunk: c, score: scores[i] ?? 0 }));
            scored.sort((a, b) => b.score - a.score);
            let result = scored
              .filter((s) => s.score >= 3)
              .slice(0, 15)
              .map((s) => s.chunk);
            if (result.length < 5) {
              result = scored.slice(0, 10).map((s) => s.chunk);
            }
            return result;
          }
        }
      } catch (rerankErr) {
        console.error("Rerank failed, using original ranking:", rerankErr);
      }
      return chunks.slice(0, 15);
    }

    function buildSystemPrompt(projectName: string) {
      return `You are a construction project assistant for the project "${projectName}". Lives and millions of dollars depend on the accuracy of your answers.

ABSOLUTE RULES:
1. Answer ONLY from the provided document excerpts. NEVER use outside knowledge or invent any value.
2. If the documents do not contain the answer, say "This information was not found in the project documents" — do NOT guess.
3. When citing numbers (dimensions, quantities, diameters, PSI values, densities, percentages), quote the EXACT value from the source. Never round, approximate, or paraphrase numerical data.
4. Always cite the source document and section/page for every factual claim.
5. If multiple sources give conflicting values for the same item, report ALL values and flag the conflict explicitly.
6. If the source data contains DATA QUALITY WARNINGS, mention relevant warnings so the user knows about known gaps or conflicts.
7. Be thorough: scan ALL provided excerpts before answering — the answer may be in a less obvious source. Construction documents use varied terminology (e.g., "invert" may appear as "bottom elevation", "rim" as "top elevation", "catch basin" as "inlet"). Report the data you find even if the terminology doesn't match the question exactly, and note the difference.
8. When asked about project-level information (location, owner, engineer, contractor), distinguish between the construction SITE and the office/contact information. Prioritize the actual site data.
9. VOIDED/REMOVED PAGES: If a source is marked [VOIDED/REMOVED FROM PROJECT], that page's data has been removed from the project scope. Do NOT include voided page data when answering questions about current quantities, specs, or scope. If the user specifically asks about removed work, you may reference voided pages but MUST clearly state the data is from a voided/removed page.

CONFIDENCE RATING:
At the very end of your response, on a new line, write exactly: CONFIDENCE: X/10
Where X is your self-assessed confidence from 0-10:
- 9-10: Answer directly supported by clear, specific data in the excerpts
- 7-8: Answer supported but some inference or terminology mapping needed
- 4-6: Partial answer; key details missing or ambiguous in sources
- 1-3: Very uncertain; minimal relevant data found
- 0: Information not found

FORMAT: Use clear structure. For tables, use markdown tables. For lists, use bullet points. Always end with source references, then the confidence rating.`;
    }

    function buildContextBlock(chunks: typeof relevantChunks) {
      return chunks
        .map((c, i) => `[Source ${i + 1}: ${c.documentName}${c.sectionLabel ? " / " + c.sectionLabel : ""}]\n${c.content}`)
        .join("\n\n---\n\n");
    }

    function parseConfidence(text: string): { answer: string; confidence: number | null } {
      let answer = text;
      let confidence: number | null = null;
      const confMatch = answer.match(/CONFIDENCE:\s*(\d+(?:\.\d+)?)\s*\/\s*10/i);
      if (confMatch) {
        confidence = parseFloat(confMatch[1]);
        answer = answer.replace(/\n?\s*CONFIDENCE:\s*\d+(?:\.\d+)?\s*\/\s*10\s*$/i, "").trim();
      }
      return { answer, confidence };
    }

    async function askLLM(systemPrompt: string, context: string, q: string) {
      const userMessage = `Project documents (context only — do not answer outside this):\n\n${context}\n\n---\n\nQuestion: ${q}`;
      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        temperature: 0.05,
        max_tokens: 2000,
      });
      return parseConfidence(completion.choices[0]?.message?.content ?? "No response generated.");
    }

    async function streamLLM(systemPrompt: string, context: string, q: string, res: import("express").Response) {
      const userMessage = `Project documents (context only — do not answer outside this):\n\n${context}\n\n---\n\nQuestion: ${q}`;
      const stream = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        temperature: 0.05,
        max_tokens: 2000,
        stream: true,
      });
      let fullText = "";
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content ?? "";
        if (delta) {
          fullText += delta;
          res.write(`data: ${JSON.stringify({ type: "token", content: delta })}\n\n`);
        }
      }
      return parseConfidence(fullText);
    }

    let verifiedFactsBlock = "";
    if (verifiedFacts.length > 0) {
      verifiedFactsBlock = "\n\n--- VERIFIED FACTS (previously confirmed correct by project team) ---\n" +
        verifiedFacts.map((f) => `Q: ${f.question}\nA: ${f.answer.slice(0, 500)}`).join("\n\n") +
        "\n--- END VERIFIED FACTS ---\n\nUse verified facts to inform your answer when relevant, but still cite original document sources.";
    }

    let usedChunks = await rerankChunks(relevantChunks, question);
    const sysPrompt = buildSystemPrompt(project.name);

    const wantStream = req.headers.accept === "text/event-stream" || req.query.stream === "1";
    let answer: string;
    let confidence: number | null;

    if (wantStream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      const sources = usedChunks.slice(0, 5).map((c) => ({
        documentName: c.documentName,
        documentType: c.documentType,
        sectionLabel: c.sectionLabel,
        excerpt: c.content.slice(0, 300) + (c.content.length > 300 ? "…" : ""),
      }));
      res.write(`data: ${JSON.stringify({ type: "sources", sources })}\n\n`);

      try {
        const result = await streamLLM(sysPrompt, buildContextBlock(usedChunks) + verifiedFactsBlock, question, res);
        answer = result.answer;
        confidence = result.confidence;

        const [msg] = await db
          .insert(projectChatsTable)
          .values({
            projectId, role: "assistant", content: answer, sources,
            confidence, searchStrategy: searchStrategies.join(","),
          })
          .returning();

        res.write(`data: ${JSON.stringify({ type: "done", message: msg, confidence })}\n\n`);
      } catch (streamErr) {
        req.log.error({ err: streamErr }, "Streaming LLM failed");
        res.write(`data: ${JSON.stringify({ type: "error", error: "Failed to generate response" })}\n\n`);
      }
      res.end();
      return;
    }

    ({ answer, confidence } = await askLLM(sysPrompt, buildContextBlock(usedChunks) + verifiedFactsBlock, question));

    const isNotFound = answer.includes("was not found in the project documents") || answer.includes("not found in the provided") || (confidence !== null && confidence <= 2);

    if (isNotFound || (confidence !== null && confidence <= 3)) {
      req.log.info({ confidence, question }, "Low confidence — initiating auto-retry with AI reformulation");
      searchStrategies.push("auto_retry");

      try {
        const reformulateResult = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: `You are a construction document search expert. The user asked a question but the search didn't find the answer. Generate 3-5 alternative search queries that might find the answer in construction specs, drawings, or bid documents. Think about:
- Different terminology (repoint vs tuckpoint, LF vs linear feet)
- The data might be in a bid schedule, measurement and payment section, schedule of values, or quantity takeoff
- Section numbers or CSI codes where this info lives
- The identifier might appear differently (UG 4.87 vs Bridge 4.87 vs undergrade 4.87)
Return ONLY a JSON array of search strings. Example: ["masonry repointing quantities bridge 4.87", "measurement payment repoint linear feet"]`,
            },
            { role: "user", content: `Original question: "${question}"\nProject: ${project.name}\nChunks found but unhelpful: ${usedChunks.length}` },
          ],
          temperature: 0.3,
          max_tokens: 300,
        });

        const reformText = reformulateResult.choices[0]?.message?.content ?? "";
        const arrMatch = reformText.match(/\[[\s\S]*?\]/);
        let altQueries: string[] = [];
        if (arrMatch) {
          try { altQueries = JSON.parse(arrMatch[0]); } catch { /* ignore parse errors */ }
        }

        if (altQueries.length > 0) {
          const retryChunks: typeof relevantChunks = [];
          for (const altQ of altQueries.slice(0, 5)) {
            const chunks = await keywordSearch(projectId, altQ, 15);
            searchStrategies.push(`retry:${altQ.slice(0, 40)}`);
            dedupeChunks(retryChunks, chunks);
          }

          const allRetryChunks = [...retryChunks];
          dedupeChunks(allRetryChunks, usedChunks);

          if (allRetryChunks.length > usedChunks.length) {
            req.log.info({ newChunks: allRetryChunks.length - usedChunks.length }, "Auto-retry found additional chunks");
            const rerankedRetry = await rerankChunks(allRetryChunks, question);
            const retryResult = await askLLM(sysPrompt, buildContextBlock(rerankedRetry), question);

            if (
              (retryResult.confidence !== null && confidence !== null && retryResult.confidence > confidence) ||
              (retryResult.confidence !== null && retryResult.confidence > 3)
            ) {
              answer = retryResult.answer;
              confidence = retryResult.confidence;
              usedChunks = rerankedRetry;
              searchStrategies.push("retry_accepted");
              req.log.info({ newConfidence: confidence }, "Auto-retry improved answer");
            } else {
              searchStrategies.push("retry_no_improvement");
            }
          }
        }
      } catch (retryErr) {
        req.log.error({ err: retryErr }, "Auto-retry failed");
        searchStrategies.push("retry_failed");
      }
    }

    const finalNotFound = answer.includes("was not found in the project documents") || answer.includes("not found in the provided") || (confidence !== null && confidence <= 2);
    if (finalNotFound || (confidence !== null && confidence <= 3)) {
      await db.insert(unansweredQuestionsTable).values({
        projectId,
        question,
        searchStrategiesAttempted: searchStrategies,
        chunksFound: usedChunks.length,
        reason: finalNotFound ? "not_found_after_retry" : "low_confidence_after_retry",
      });
    }

    const sources = usedChunks.slice(0, 5).map((c) => ({
      documentName: c.documentName,
      documentType: c.documentType,
      sectionLabel: c.sectionLabel,
      excerpt: c.content.slice(0, 300) + (c.content.length > 300 ? "…" : ""),
    }));

    const [msg] = await db
      .insert(projectChatsTable)
      .values({
        projectId, role: "assistant", content: answer, sources,
        confidence, searchStrategy: searchStrategies.join(","),
      })
      .returning();

    res.json({ message: msg, sources, confidence });
  } catch (err) {
    req.log.error({ err }, "Failed to process chat question");
    res.status(500).json({ error: "Failed to process question" });
  }
});

router.post("/:id/chat/:chatId/feedback", async (req, res) => {
  try {
    const projectId = parseInt(req.params.id, 10);
    const chatId = parseInt(req.params.chatId, 10);
    const { feedback, note } = req.body as { feedback: "positive" | "negative"; note?: string };

    if (!["positive", "negative"].includes(feedback)) {
      res.status(400).json({ error: "Feedback must be 'positive' or 'negative'" });
      return;
    }

    const [existing] = await db.select().from(projectChatsTable).where(
      and(eq(projectChatsTable.id, chatId), eq(projectChatsTable.projectId, projectId))
    );
    if (!existing) {
      res.status(404).json({ error: "Chat message not found" });
      return;
    }

    await db.update(projectChatsTable)
      .set({ feedback, feedbackNote: note || null })
      .where(and(eq(projectChatsTable.id, chatId), eq(projectChatsTable.projectId, projectId)));

    if (feedback === "negative") {
      const [precedingUserMsg] = await db.select().from(projectChatsTable)
        .where(and(
          eq(projectChatsTable.projectId, projectId),
          eq(projectChatsTable.role, "user"),
          lt(projectChatsTable.id, chatId),
        ))
        .orderBy(desc(projectChatsTable.id))
        .limit(1);

      if (precedingUserMsg) {
        await db.insert(unansweredQuestionsTable).values({
          projectId,
          question: precedingUserMsg.content,
          searchStrategiesAttempted: ["user_reported_negative"],
          chunksFound: 0,
          reason: "negative_feedback",
        });
      }
    }

    if (feedback === "positive" && existing.confidence && existing.confidence >= 7) {
      const [precedingUserMsg] = await db.select().from(projectChatsTable)
        .where(and(
          eq(projectChatsTable.projectId, projectId),
          eq(projectChatsTable.role, "user"),
          lt(projectChatsTable.id, chatId),
        ))
        .orderBy(desc(projectChatsTable.id))
        .limit(1);

      if (precedingUserMsg) {
        const existing_fact = await db.select().from(verifiedFactsTable).where(
          and(eq(verifiedFactsTable.projectId, projectId), eq(verifiedFactsTable.chatId, chatId))
        );
        if (existing_fact.length === 0) {
          await db.insert(verifiedFactsTable).values({
            projectId,
            question: precedingUserMsg.content,
            answer: existing.content,
            chatId,
            confidence: existing.confidence,
          });
          req.log.info({ projectId, chatId }, "Verified fact stored from positive feedback");
        }
      }
    }

    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to save feedback");
    res.status(500).json({ error: "Failed to save feedback" });
  }
});

router.get("/:id/unanswered", async (req, res) => {
  try {
    const projectId = parseInt(req.params.id, 10);
    const items = await db.select().from(unansweredQuestionsTable)
      .where(eq(unansweredQuestionsTable.projectId, projectId))
      .orderBy(desc(unansweredQuestionsTable.createdAt));

    res.json({ items });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch unanswered questions");
    res.status(500).json({ error: "Failed to fetch unanswered questions" });
  }
});

router.get("/:id/documents/:docId/chunks", async (req, res) => {
  try {
    const projectId = parseInt(req.params.id, 10);
    const docId = parseInt(req.params.docId, 10);
    const page = parseInt((req.query.page as string) ?? "1", 10);
    const limit = Math.min(parseInt((req.query.limit as string) ?? "20", 10), 100);
    const search = ((req.query.search as string) ?? "").trim();
    const offset = (page - 1) * limit;

    const [doc] = await db.select().from(projectDocumentsTable).where(
      and(eq(projectDocumentsTable.id, docId), eq(projectDocumentsTable.projectId, projectId))
    );
    if (!doc) { res.status(404).json({ error: "Document not found" }); return; }

    const baseConditions = [
      eq(documentChunksTable.projectDocumentId, docId),
      eq(documentChunksTable.projectId, projectId),
    ];
    if (search) {
      baseConditions.push(sql`${documentChunksTable.content} ILIKE ${'%' + search + '%'}` as any);
    }

    const whereClause = and(...baseConditions);

    const [{ count: totalChunks }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(documentChunksTable)
      .where(whereClause);

    const chunks = await db.select({
      id: documentChunksTable.id,
      chunkIndex: documentChunksTable.chunkIndex,
      content: documentChunksTable.content,
      sectionLabel: documentChunksTable.sectionLabel,
    })
      .from(documentChunksTable)
      .where(whereClause)
      .orderBy(documentChunksTable.chunkIndex)
      .limit(limit)
      .offset(offset);

    res.json({
      documentName: doc.documentName,
      documentType: doc.documentType,
      chunks,
      pagination: { page, limit, total: totalChunks, totalPages: Math.ceil(totalChunks / limit) },
    });
  } catch (err) {
    req.log.error({ err }, "Failed to list chunks");
    res.status(500).json({ error: "Failed to list chunks" });
  }
});

router.patch("/:id/chunks/:chunkId", async (req, res) => {
  try {
    const projectId = parseInt(req.params.id, 10);
    const chunkId = parseInt(req.params.chunkId, 10);

    const bodySchema = z.object({
      correctedContent: z.string().min(1),
      reason: z.string().optional(),
    });
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Invalid body", details: parsed.error.issues }); return; }

    const [chunk] = await db.select().from(documentChunksTable).where(
      and(eq(documentChunksTable.id, chunkId), eq(documentChunksTable.projectId, projectId))
    );
    if (!chunk) { res.status(404).json({ error: "Chunk not found" }); return; }

    const originalContent = chunk.content;
    const { correctedContent, reason } = parsed.data;

    if (originalContent === correctedContent) { res.status(400).json({ error: "No changes detected" }); return; }

    await db.insert(dataCorrectionsTable).values({
      projectId,
      chunkId,
      originalContent,
      correctedContent,
      reason: reason || null,
    });

    await db.update(documentChunksTable)
      .set({ content: correctedContent, embedding: null })
      .where(eq(documentChunksTable.id, chunkId));

    req.log.info({ chunkId, projectId }, "Data correction applied — embedding will regenerate on next backfill");

    res.json({ success: true, chunkId, message: "Correction applied. Embedding will regenerate automatically." });
  } catch (err) {
    req.log.error({ err }, "Failed to apply correction");
    res.status(500).json({ error: "Failed to apply correction" });
  }
});

router.get("/:id/corrections", async (req, res) => {
  try {
    const projectId = parseInt(req.params.id, 10);
    const corrections = await db.select().from(dataCorrectionsTable)
      .where(eq(dataCorrectionsTable.projectId, projectId))
      .orderBy(desc(dataCorrectionsTable.createdAt));
    res.json({ corrections });
  } catch (err) {
    req.log.error({ err }, "Failed to list corrections");
    res.status(500).json({ error: "Failed to list corrections" });
  }
});

router.get("/:id/verified-facts", async (req, res) => {
  try {
    const projectId = parseInt(req.params.id, 10);
    const facts = await db.select().from(verifiedFactsTable)
      .where(eq(verifiedFactsTable.projectId, projectId))
      .orderBy(desc(verifiedFactsTable.createdAt));
    res.json({ facts });
  } catch (err) {
    req.log.error({ err }, "Failed to list verified facts");
    res.status(500).json({ error: "Failed to list verified facts" });
  }
});

router.patch("/:id/unanswered/:questionId", async (req, res) => {
  try {
    const questionId = parseInt(req.params.questionId, 10);
    const { status, resolution } = req.body as { status: string; resolution?: string };

    if (!["open", "resolved", "acknowledged"].includes(status)) {
      res.status(400).json({ error: "Status must be 'open', 'resolved', or 'acknowledged'" });
      return;
    }

    await db.update(unansweredQuestionsTable)
      .set({
        status,
        resolution: resolution || null,
        resolvedAt: status === "resolved" ? new Date() : null,
      })
      .where(eq(unansweredQuestionsTable.id, questionId));

    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to update unanswered question");
    res.status(500).json({ error: "Failed to update" });
  }
});

export default router;
