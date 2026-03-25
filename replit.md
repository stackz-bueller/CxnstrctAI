# Overview

This project is a pnpm workspace monorepo using TypeScript, focused on advanced document information extraction and AI-powered data management. Its core purpose is to provide a robust, schema-anchored document processing system capable of extracting structured data from various document types, including images, construction PDFs, and technical specifications. The project also features a powerful, project-scoped AI agent (RAG sidecar) that allows users to query indexed documents with high accuracy and anti-hallucination capabilities.

The primary goal is to prevent schema drift and provide reliable, auditable data extraction for critical business processes, particularly in industries dealing with complex documentation like construction. Key capabilities include visual OCR, schema-constrained data extraction, and intelligent querying over diverse document formats, all integrated into a portable API and a user-friendly React frontend.

# User Preferences

I prefer iterative development and want to be asked before making major changes. I value detailed explanations when complex logic is involved. Please ensure all code adheres to a consistent, modern TypeScript style. I do not want any changes made to the `artifacts-monorepo/artifacts/ocr-extractor/` directory or its subdirectories.

# System Architecture

## Monorepo Structure

The project is organized as a pnpm monorepo using TypeScript 5.9, with a clear separation between deployable applications (`artifacts/`) and shared libraries (`lib/`). Each package manages its own dependencies and utilizes `tsconfig.base.json` with `composite: true` for efficient cross-package type-checking.

## Core Technologies

- **Backend**: Node.js 24 with Express 5 for the API server.
- **Database**: PostgreSQL with Drizzle ORM for schema definition and data persistence, including `pgvector` for vector embeddings.
- **Frontend**: React with Vite for the OCR Extractor UI.
- **Validation**: Zod (`zod/v4`) and `drizzle-zod` for API and database schema validation.
- **API Definition**: OpenAPI 3.1 specification, with Orval for client and schema codegen.
- **Build System**: esbuild for ESM bundling.
- **AI Runtimes**: Python 3.11 for PDF processing pipelines (pdf2image, opencv-python-headless, pytesseract) and local embedding model execution (`onnxruntime-node`). System dependencies include Poppler and Tesseract 5.5.0.

## Document Processing Pipelines

### OCR Extractor (Main App)

- **Two-pass AI pipeline**:
    1.  **Pass 1 (OCR)**: Raw text extraction from document images using GPT-5.2 Vision.
    2.  **Pass 2 (Schema-anchored extraction)**: Structured data extraction constrained by a predefined schema, preventing schema drift and hallucination.
- **Capabilities**: Schema creation (typed fields), image upload (JPG, PNG, WebP), per-field confidence scores, full extraction history, raw OCR text access.

### Construction PDF Pipeline

-   **Multi-stage processing for engineering documents**:
    1.  **PDF to Images**: `pdf2image`/Poppler converts PDFs to 300 DPI images.
    2.  **Image Preprocessing**: OpenCV for noise reduction and text sharpening.
    3.  **Targeted OCR**: Tesseract OCR applied to specific regions (title block, revision block) and full page.
    4.  **Legend/Callout Detection**: OpenCV contour analysis.
    5.  **Full-Page Vision**: GPT-4o Vision for structured extraction, including table capture, with a fast-path for blank pages.
    6.  **Multi-Crop Verification**: For dense tables (≥8 rows), automatically runs 4 overlapping crop extractions with cross-validation to prevent truncation and misreading.
    7.  **Merging**: OCR and Vision results are merged, with Vision taking priority and OCR filling gaps.
-   **Extracted fields**: Title block data, revision history, general notes, structured tables (compaction density, material schedules, pipe schedules), callouts, legends, full raw text.
-   **PE Stamp Extraction**: Professional Engineer stamp data (name, license, discipline) is extracted via targeted right-edge crops of drawing pages. Stamps with signatures over printed names require focused crops for reliable OCR. PE data is injected into `all_text` as structured `PROFESSIONAL ENGINEER STAMP` blocks and indexed as dedicated searchable chunks per discipline (civil, electrical, plumbing/mechanical).
-   **Voided Page Detection**: GPT-4o Vision detects pages with large X marks, "VOID", "DELETED", "REMOVED", "SUPERSEDED", or "NOT USED" markings. Voided pages get `voided: true` flag and reason. Cover sheet X marks on sheet listings are noted in general_notes. Voided page chunks are tagged `[VOIDED/REMOVED FROM PROJECT]` in the index with a warning chunk, and the LLM system prompt instructs the AI to exclude voided data from current scope answers.
-   **Script**: `scripts/pdf_processor.py` (Python child process). No page limit — processes entire drawing sets. Initial upload uses streaming mode (saves each page to DB as it's processed). 4-hour timeout to handle large sets.

### Specification Extraction Pipeline

-   **Optimized for CSI-format PDFs**:
    1.  **Direct Text Extraction**: `pdfplumber` for text-based PDFs (no OCR).
    2.  **CSI Structure Parsing**: Regex identifies section headers (`SECTION XXXXXX – Title`) and boundaries.
    3.  **Division Grouping**: Maps sections to CSI MasterFormat divisions.
    4.  **Part/Subsection Parsing**: Extracts content from PART 1/2/3 and subsections.
    5.  **AI Structuring**: GPT-4o (text only) processes initial sections for structured requirement extraction; subsequent sections use regex only.
    6.  **Project Name Detection**: Heuristic regex on initial pages.
-   **Script**: `scripts/spec_processor.py` (Python child process).

## Project AI Agents (RAG Sidecar)

-   **Project-scoped Q&A**: Answers questions based solely on indexed project documents.
-   **Indexing**: Documents are chunked (1500-char max, 150-char overlap), embedded locally using an `all-MiniLM-L6-v2` ONNX model, and stored in PostgreSQL (`vector(384)` with `pgvector` IVFFlat index). Table data gets dedicated chunks. Embeddings are batched (16 texts per ONNX inference pass) and SQL updates are batched (single CASE/IN UPDATE per batch) for performance. Non-finite embedding values (NaN/Inf) are filtered out before DB writes.
-   **Hybrid Search**: Questions are embedded, and a parallel **triple-source hybrid search** is performed:
    -   Vector search (cosine similarity, 2.5x weight for general questions, 1.5x when identifiers detected)
    -   Full-text search (PostgreSQL tsvector, 1.0x weight)
    -   Identifier boost search (construction identifiers, 2.5x weight)
    Results merged via Reciprocal Rank Fusion (RRF) with source diversity enforcement (max 3 chunks per section to prevent single-section domination).
-   **Construction synonym expansion**: Search automatically expands domain-specific terms (e.g., "invert" → also searches "bottom elevation", "rim" → "top elevation", "located" → "site address, municipality, title block", "LF" → "linear feet", "repoint" → "tuckpoint, mortar joint", plus quantity, masonry, bridge, and other construction terms).
-   **AI Reranking**: Top-25 retrieved chunks are scored 0-10 for relevance by GPT-4o before being passed to the answer model. This filters out noise and ensures the most relevant chunks from across different document sections reach the AI. Gracefully falls back to original ranking on failure.
-   **Contextual AI**: Top reranked chunks (up to 15) passed to GPT-4o for final answer generation.
-   **Safety and Anti-hallucination**: Temperature 0.05, 2000-token limit, system prompt enforces exact quoting, source citation, conflict flagging, terminology awareness, and data quality warnings. Explicitly states if no relevant chunks are found.
-   **Confidence Scoring**: AI self-rates confidence 0–10 per answer (stripped from response, stored in DB). Frontend displays green/amber/red confidence badges.
-   **User Feedback & Verified Facts**: Thumbs up/down buttons on each assistant response. Negative feedback auto-catalogs the question for review. Positive feedback on high-confidence (≥7) answers stores the Q&A pair as a **verified fact** (`verified_facts` table). Verified facts are injected into subsequent chat context so the AI can reference previously confirmed answers.
-   **Data Correction System**: Users can browse indexed chunks per document (paginated, searchable), edit OCR errors inline, and save corrections with audit trail (`data_corrections` table). Corrections automatically clear the chunk's embedding so it regenerates on next backfill cycle. Frontend "Data Browser" accessible via search icon on each indexed document in the Docs tab.
-   **Self-Healing Retry Cascade**: On search failure, attempts multiple strategies (hybrid_standard → simplified_query → proper_noun extraction) before returning "not found". If confidence ≤ 3, auto-retries by using GPT to reformulate the question into 3-5 alternative search queries with domain-specific terminology, re-searches, and re-asks the LLM with the expanded context. Unanswered questions automatically logged to DB with strategies attempted, chunks found, and reason.
-   **Unanswered Question Catalog**: `GET /:id/unanswered` and `PATCH /:id/unanswered/:questionId` endpoints for reviewing and resolving gaps.
-   **Auto-validation**: `validateConstructionData()` runs during indexing, storing warnings (e.g., non-standard pipe sizes, ID gaps) as searchable chunks.
-   **Extraction Integrity System** (`artifacts/api-server/src/lib/integrity.ts`):
    -   **Startup check**: On every server boot, scans all construction extractions for `processedPages < totalPages` and marks mislabeled "completed" records as "incomplete".
    -   **Auto-repair on attach**: When attaching a construction document to a project, if the extraction is incomplete, the system auto-repairs (re-extracts missing pages from the stored PDF) *before* indexing. Indexing only runs on fully extracted data.
    -   **Persistent PDF storage**: All uploaded PDFs are persisted to `attached_assets/` with sanitized filenames matching the DB record, so re-extraction is always possible.
    -   **API endpoints**: `GET /api/pdf-extractions/integrity` (health check), `POST /api/pdf-extractions/:id/repair` (trigger repair for a specific extraction).
    -   **Filename consistency**: Both DB `fileName` and disk file use the same sanitized name (`[^a-zA-Z0-9._-]` → `_`), with fallback lookup for legacy records.

## UI/UX

The frontend is branded as **ConstructAI** and focuses on the AI assistant experience. Document processing features (OCR, PDF extraction, specs, schemas, history) are hidden from the navigation and routes. The visible interface includes:
-   **Projects list** (home page `/`): Create, view, and manage construction projects.
-   **Project detail** (`/projects/:id`): AI chat assistant with confidence badges, thumbs up/down feedback, source citations, and document management tabs.
-   Document processing APIs remain available for backend use but are not exposed in the UI navigation.

## API Endpoints

A comprehensive set of RESTful API endpoints for managing schemas, extractions (OCR, PDF, spec), projects, project documents, and the RAG chat functionality.

## CI/CD

-   **GitHub Actions Pipeline** (`.github/workflows/ci.yml`): Runs on every push to `main` and all PRs. All jobs are **blocking** (safety-critical):
    -   **TypeScript Check**: Typechecks API server and frontend — fails the pipeline on any TS error.
    -   **Build**: Builds API server (esbuild) and frontend (Vite). Verifies build artifacts exist. Frontend build requires `PORT` and `BASE_PATH` env vars.
    -   **Schema Validation**: Runs `tsc` on the DB schema and verifies all 7 required tables are exported by name.
    -   **File Integrity**: Confirms all critical source files exist and Python scripts compile.
    -   **CI Summary**: Aggregates results and fails if any job fails.
-   **Local Validation Script** (`scripts/ci/validate.sh`): Run via `pnpm validate`. All 18 checks are enforcing:
    -   TypeScript (blocking), builds (blocking), database schema sync (requires `DATABASE_URL` unless `SKIP_DB_CHECKS=1`), data integrity (null embeddings, incomplete extractions), required files, Python deps, ONNX model.
-   **TypeScript Status**: 0 errors across API server and frontend. Libraries use `skipLibCheck` for upstream type compatibility.

# External Dependencies

-   **AI (General)**: OpenAI via Replit AI Integrations (GPT-5.2 Vision).
-   **AI (PDF Pipeline)**: GPT-4o via Replit AI Integrations.
-   **Local Embeddings**: `all-MiniLM-L6-v2` ONNX model (served via `onnxruntime-node`).
-   **OpenAPI Codegen**: Orval.
-   **Database**: PostgreSQL with `pgvector` extension.
-   **PDF Processing (Python)**: `pdf2image`, `opencv-python-headless`, `pytesseract`, `openai`, `pillow`, `numpy`.
-   **System Utilities**: Poppler (for PDF rendering), Tesseract OCR engine, `libGL`.