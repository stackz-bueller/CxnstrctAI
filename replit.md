# Overview

This project is a pnpm workspace monorepo using TypeScript, designed for advanced document information extraction and AI-powered data management. It provides a robust, schema-anchored system to extract structured data from diverse document types, including images, construction PDFs, and technical specifications. A project-scoped AI agent (RAG sidecar) allows users to query indexed documents with high accuracy and anti-hallucination capabilities. The main goal is to prevent schema drift and deliver reliable, auditable data extraction for critical business processes, especially in industries handling complex documentation like construction.

# User Preferences

I prefer iterative development and want to be asked before making major changes. I value detailed explanations when complex logic is involved. Please ensure all code adheres to a consistent, modern TypeScript style. I do not want any changes made to the `artifacts-monorepo/artifacts/ocr-extractor/` directory or its subdirectories.

# System Architecture

## Monorepo Structure
The project uses a pnpm monorepo with TypeScript 5.9, separating deployable applications (`artifacts/`) from shared libraries (`lib/`).

## Core Technologies
- **Backend**: Node.js 24 with Express 5.
- **Database**: PostgreSQL with Drizzle ORM and `pgvector`.
- **Frontend**: React with Vite.
- **Validation**: Zod and `drizzle-zod`.
- **API Definition**: OpenAPI 3.1 with Orval for codegen.
- **Build System**: esbuild.
- **AI Runtimes**: Python 3.11 for PDF processing and `onnxruntime-node` for local embeddings.

## Document Processing Pipelines

### OCR Extractor
A two-pass AI pipeline for raw text extraction (GPT-5.2 Vision) and schema-anchored structured data extraction. Features schema creation, image upload, confidence scores, and full extraction history.

### Construction PDF Pipeline
A multi-stage process for engineering documents:
- Converts PDFs to 300 DPI images.
- Uses OpenCV for image preprocessing.
- Applies Tesseract OCR for targeted extraction.
- Employs GPT-4o Vision (full-page and 3x3 tiled) for structured data.
- Includes table verification, exhaustive merge of all extraction results, and a quality gate for review.
- Dedicated PE seal extraction pass: multi-crop (3 regions) targeting right-edge and bottom-edge of drawings to capture Professional Engineer stamps, license numbers, and firm info.
- Detects voided pages, marking them appropriately.
- Scripted via `scripts/pdf_processor.py`.

### Specification Extraction Pipeline
Optimized for CSI-format PDFs:
- Uses `pdfplumber` for text extraction.
- Parses CSI structure, sections, and divisions using regex and AI.
- Extracts content from parts and subsections.
- Scripted via `scripts/spec_processor.py`.

## Project AI Agents (RAG Sidecar)
Provides project-scoped Q&A over indexed documents:
- **Indexing**: Documents are chunked, embedded using `all-MiniLM-L6-v2` ONNX model, and stored in PostgreSQL with `pgvector`.
- **Hybrid Search**: Combines vector, full-text (min 2-char words for abbreviations like PE, LF, SF), and identifier boost searches with Reciprocal Rank Fusion (300-char dedup keys, max 5 chunks per section). Construction synonym expansion. Reranking with score threshold ≥2, up to 20 chunks to LLM. 3000-token answer limit, 8 sources with 500-char excerpts. Revision history, legends, PE stamps, and firm info indexed as dedicated chunks.
- **AI Reranking**: GPT-4o scores retrieved chunks for relevance.
- **Contextual AI**: Uses top reranked chunks with GPT-4o for answer generation.
- **Safety**: Employs strict system prompts, exact quoting, source citation, and conflict flagging to prevent hallucination.
- **SSE Streaming**: Chat responses stream via Server-Sent Events.
- **Confidence Scoring**: AI self-rates answer confidence.
- **User Feedback & Verified Facts**: Users provide feedback, and positive feedback on high-confidence answers creates verified facts for future use.
- **Data Correction System**: Allows inline editing of OCR errors with audit trails, triggering embedding regeneration.
- **Self-Healing Retry Cascade**: Implements multiple search strategies and auto-reformulates questions on low confidence or failure.
- **Unanswered Question Catalog**: Endpoints for reviewing and resolving gaps.
- **Auto-validation**: `validateConstructionData()` stores warnings during indexing.
- **Extraction Integrity System**: Verifies and auto-repairs incomplete construction extractions on server boot and document attachment.

## Authentication & Security
- **Replit OIDC Auth**: Server-side OpenID Connect login via `openid-client`. Sessions stored in `sessions` DB table. Users stored in `users` DB table with `role` column (`user` or `superuser`).
- **Auth Middleware**: `authMiddleware` populates `req.user` (including `role`) from session cookie. `requireAuth` middleware gates all API routes except health and auth endpoints.
- **Router-level enforcement**: All OCR, project, cost, and document routes require authentication at the router mount level (`routes/index.ts`).
- **User Allowlist**: `ALLOWED_USER_IDS` env var (comma-separated) restricts login to specific Replit user IDs. If empty/unset, all Replit users can log in.
- **Superuser Role**: `SUPERUSER_IDS` env var (comma-separated) auto-assigns `superuser` role on login. Superusers see all projects; regular users see only their own.
- **Project Ownership**: Projects have an `ownerId` column. `router.param("id")` middleware enforces ownership on all project sub-routes. Superusers bypass ownership checks.

## Cost Accounting
- **`cost_events` table**: Tracks all AI API spend with model, token counts, estimated cost, category, and project association.
- **`cost-tracker.ts`**: Model pricing table (gpt-5.2, gpt-4o, gpt-4o-mini), `trackCost()` and `extractTokenUsage()` utilities.
- **Tracked operations**: OCR extraction (both passes), construction pipeline, chat queries.
- **Endpoints**: `GET /api/costs` (paginated list), `GET /api/costs/summary` (by-category and daily breakdowns).

## Production Hardening
- **Graceful shutdown**: SIGTERM/SIGINT handlers with connection draining and 10s timeout.
- **Env validation**: Startup checks for `PORT`, `DATABASE_URL`, `REPL_ID`.
- **Rate limiting**: 120 req/min via `express-rate-limit`, health endpoint exempt.
- **Deep health check**: `/api/healthz` tests DB connectivity.
- **Temp file cleanup**: Orphaned files in OS temp dir cleaned on startup.
- **Integrity checks**: Incomplete extractions detected and marked on startup.

## UI/UX
Branded as **ConstructAI**, the frontend focuses on the AI assistant. Document processing features are backend-only. The UI includes:
-   **Login gate**: Replit OIDC authentication with branded login screen.
-   **Projects list**: Create and manage projects.
-   **Project detail**: AI chat with feedback, citations, and document management.
-   **Cost monitoring**: Charts showing spend by category and daily breakdown.
-   **User profile**: Avatar, name display, and logout in sidebar.

## API Endpoints
Comprehensive RESTful APIs for managing schemas, extractions, projects, and RAG chat.

## CI/CD
- **GitHub Actions**: Blocking pipeline for TypeScript checks, builds, schema validation, and file integrity on every push and PR.
- **Local Validation Script**: `scripts/ci/validate.sh` (`pnpm validate`) enforces 18 checks including TypeScript, builds, database sync, and data integrity.

# External Dependencies

-   **AI (General)**: OpenAI via Replit AI Integrations (GPT-5.2 Vision).
-   **AI (PDF Pipeline)**: GPT-4o via Replit AI Integrations.
-   **Local Embeddings**: `all-MiniLM-L6-v2` ONNX model.
-   **OpenAPI Codegen**: Orval.
-   **Database**: PostgreSQL with `pgvector` extension.
-   **PDF Processing (Python)**: `pdf2image`, `opencv-python-headless`, `pytesseract`, `openai`, `pillow`, `numpy`.
-   **System Utilities**: Poppler, Tesseract OCR engine, `libGL`.