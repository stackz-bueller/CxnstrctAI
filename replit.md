# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (ESM bundle)
- **AI (general)**: OpenAI via Replit AI Integrations (gpt-5.2 with vision)
- **AI (PDF pipeline)**: gpt-4o via the same integration
- **Python runtime**: 3.11 (pdf2image, opencv-python-headless, pytesseract, openai, pillow, numpy)
- **System deps**: Poppler (PDF→images), Tesseract 5.5.0 (OCR), libGL

## Structure

```text
artifacts-monorepo/
├── artifacts/              # Deployable applications
│   ├── api-server/         # Express API server
│   └── ocr-extractor/      # React + Vite frontend (OCR tool)
├── lib/                    # Shared libraries
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   ├── db/                 # Drizzle ORM schema + DB connection
│   └── integrations-openai-ai-server/ # OpenAI server integration
├── scripts/                # Utility scripts
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── tsconfig.json
└── package.json
```

## Features

### OCR Extractor (Main App)

A schema-anchored document information extraction tool that prevents schema drift using a two-pass AI pipeline:

1. **Pass 1 — OCR**: Extract raw text from document images using GPT-5.2 vision
2. **Pass 2 — Schema-anchored extraction**: Extract ONLY the defined fields using a locked schema as a constraint (prevents hallucinated or drifted fields)

**Key capabilities:**
- Create named document schemas with typed fields (string, number, date, boolean, array)
- Upload document images (JPG, PNG, WebP) for extraction
- Per-field confidence scores with color-coded badges
- Full extraction history with re-viewable results
- Raw OCR text accessible for each extraction
- Portable API — can be integrated into any app

**Built-in schemas:** Receipt, Invoice, Construction Report

### Construction PDF Pipeline

A second dedicated pipeline for construction engineering documents (PDFs):

1. **PDF → Images**: Convert each page to 300 DPI images using pdf2image/poppler
2. **OpenCV Preprocessing**: Adaptive threshold to clean noise and sharpen text for Tesseract
3. **Targeted OCR**: Regional Tesseract OCR on title block (bottom-right), revision block (upper-right), and full page
4. **Legend/Callout Detection**: OpenCV contour detection to find bordered boxes and annotation patterns
5. **3×3 Vision Tiling**: Each page split into 9 overlapping tiles, each sent to GPT-4o Vision for structured extraction
6. **Merge**: OCR and vision results merged — vision takes priority, OCR fills gaps

**Extracted fields per page:** Title block (project name, drawing title, sheet number, revision, date, drawn by, scale), revision history table, general notes, callouts, legends/symbols, full raw text.

**Script:** `scripts/pdf_processor.py` — spawned as a child process by the Node.js route. Takes `<pdf_path> <ai_base_url> <ai_api_key>`, outputs JSON to stdout.

### Specification Extraction Pipeline

A third pipeline designed specifically for CSI-format specification PDFs (letter-size text documents):

1. **Direct text extraction**: pdfplumber reads each page's text directly — no OCR, no vision, no image conversion. Much faster and more accurate than the drawing pipeline for text PDFs.
2. **CSI structure parsing**: Regex detects `SECTION XXXXXX – Title` headers across the full document to identify section boundaries.
3. **Division grouping**: Section numbers are mapped to their CSI MasterFormat division (01 General Requirements, 03 Concrete, 22 Plumbing, etc.)
4. **Part/subsection parsing**: Each section is split into PART 1 GENERAL / PART 2 PRODUCTS / PART 3 EXECUTION, and subsections (1.01, 1.02, A, B, etc.) are extracted with their content.
5. **AI structuring**: First 20 sections are sent to GPT-4o (text only) for structured requirement extraction. Remaining sections use regex-only parsing.
6. **Project name detection**: Heuristic regex on the first 3 pages to find the project name.

**Tested results:**
- Wyoming Complex (337p, 5.2MB) → 60 sections, 11 divisions, 130s
- Stone Arches (685p, 42MB) → 62 sections, 9 divisions, 136s
- Fern Rock (281p, 39MB) → 7 sections (small project), 1 division, 76s

**Script:** `scripts/spec_processor.py` — spawned as a child process by the Node.js route. MAX_PAGES=1200, MAX_SECTIONS=20 (GPT-structured), regex-only for the rest.

### Project AI Agents (RAG Sidecar)

A project-scoped AI assistant that answers questions only from indexed project documents.

**How it works:**
1. Create a project (e.g. "Wyoming Complex")
2. Assign completed extractions (specs, drawings, financials, OCR) to the project
3. Each document is automatically chunked and embedded using a local `all-MiniLM-L6-v2` ONNX model (22MB, runs via `onnxruntime-node` with a pure-JS WordPiece tokenizer — no external API or `sharp` dependency)
4. Embeddings stored in PostgreSQL as `vector(384)` using pgvector extension with a cosine IVFFlat index
5. When a question is asked, it's embedded, top-K semantically similar chunks are retrieved (pgvector cosine similarity), and GPT-4o answers using only those chunks as context — no outside knowledge
6. Chat history is stored per project; each project is fully isolated

**Anti-hallucination:** If no relevant chunks exceed a similarity threshold (0.25), the AI explicitly says it cannot find the answer rather than guessing.

**Embedding model files:** `artifacts/api-server/models/model.onnx` + `tokenizer.json`

**Critical notes:**
- Replit AI proxy does NOT support `/embeddings` endpoint — only chat completions. All embedding is done locally.
- `@xenova/transformers` is installed but broken (`sharp` native binary not compiled) — do NOT use it. Use `embedder.ts` instead.
- On startup, a background backfill runs to generate embeddings for any chunks that are missing them.
- Max pages per PDF: 150 (raised from original 5 to capture full documents)

**Key files:**
- `artifacts/api-server/src/lib/embedder.ts` — local ONNX embedding with WordPiece tokenizer
- `artifacts/api-server/src/routes/projects/indexer.ts` — chunker, embedder call, pgvector search
- `artifacts/api-server/src/routes/projects/router.ts` — projects CRUD + document management + RAG chat
- `artifacts/ocr-extractor/src/pages/projects.tsx` — project list UI
- `artifacts/ocr-extractor/src/pages/project-detail.tsx` — document manager + chat UI

**New DB tables:** `projects`, `project_documents`, `document_chunks`, `project_chats`

### API Endpoints

- `GET /api/schemas` — list schemas
- `POST /api/schemas` — create schema
- `GET /api/schemas/:id` — get schema
- `DELETE /api/schemas/:id` — delete schema
- `GET /api/extractions` — list all extractions (optional `?schemaId=` filter)
- `GET /api/extractions/:id` — get extraction result
- `GET /api/extractions/:id/raw-text` — get raw OCR text
- `POST /api/extractions/upload` — multipart upload (file + schemaId)
- `GET /api/pdf-extractions` — list all construction PDF extractions
- `GET /api/pdf-extractions/:id` — get full extraction with per-page results
- `POST /api/pdf-extractions/upload` — upload a construction PDF (starts async pipeline, returns immediately)
- `GET /api/spec-extractions` — list all spec extractions (summary, no sections)
- `GET /api/spec-extractions/:id` — get full extraction with sections array
- `POST /api/spec-extractions/upload` — upload a spec PDF (starts async pipeline, returns immediately)
- `GET /api/projects` — list all projects
- `POST /api/projects` — create project `{ name, description? }`
- `GET /api/projects/:id` — get project with its documents
- `PATCH /api/projects/:id` — update project
- `DELETE /api/projects/:id` — delete project + chunks + chat history
- `GET /api/projects/:id/documents` — list project documents
- `POST /api/projects/:id/documents` — add document `{ documentType, documentId }` → triggers background indexing
- `DELETE /api/projects/:id/documents/:docId` — remove document + its chunks
- `POST /api/projects/:id/documents/:docId/reindex` — re-run indexing
- `GET /api/projects/:id/chat` — get chat history
- `DELETE /api/projects/:id/chat` — clear chat history
- `POST /api/projects/:id/chat` — ask question `{ question }` → RAG response with sources

## TypeScript & Composite Projects

Every package extends `tsconfig.base.json` which sets `composite: true`. The root `tsconfig.json` lists all packages as project references. This means:

- **Always typecheck from the root** — run `pnpm run typecheck` (which runs `tsc --build --emitDeclarationOnly`). This builds the full dependency graph so that cross-package imports resolve correctly.
- **`emitDeclarationOnly`** — we only emit `.d.ts` files during typecheck; actual JS bundling is handled by esbuild/tsx/vite.
- **Project references** — when package A depends on package B, A's `tsconfig.json` must list B in its `references` array.

## Root Scripts

- `pnpm run build` — runs `typecheck` first, then recursively runs `build` in all packages that define it
- `pnpm run typecheck` — runs `tsc --build --emitDeclarationOnly` using project references

## Packages

### `artifacts/api-server` (`@workspace/api-server`)

Express 5 API server. Routes live in `src/routes/` and use `@workspace/api-zod` for request and response validation and `@workspace/db` for persistence.

- Entry: `src/index.ts` — reads `PORT`, starts Express
- App setup: `src/app.ts` — mounts CORS, JSON/urlencoded parsing, routes at `/api`
- Routes: `src/routes/index.ts` mounts sub-routers
  - `src/routes/health.ts` — health check
  - `src/routes/ocr/schemas.ts` — document schema CRUD
  - `src/routes/ocr/extractions.ts` — extraction upload and retrieval
  - `src/routes/ocr/extraction-pipeline.ts` — two-pass OCR+extraction AI logic
  - `src/routes/ocr/pdf-extractions.ts` — construction PDF upload (spawns Python pipeline) + list/get
- Depends on: `@workspace/db`, `@workspace/api-zod`, `@workspace/integrations-openai-ai-server`

### `artifacts/ocr-extractor` (`@workspace/ocr-extractor`)

React + Vite frontend. Pages:
- Extract Document — schema selection + drag-and-drop upload (image files)
- **Construction PDF** — drag-and-drop PDF upload, real-time polling, per-page expandable results (title block, revisions, notes, callouts, legends, full text)
- Document Schemas — schema list and management
- Schema New — field builder for new schemas
- History — past extraction results
- Extraction Details — field values, confidence scores, raw OCR text

### `lib/db` (`@workspace/db`)

- `document_schemas` table — schema definitions with JSONB fields
- `extractions` table — extraction results with JSONB field values
- `construction_extractions` table — per-PDF extraction records with JSONB pages array
- `spec_extractions` table — per-spec extraction records with JSONB sections array (section_number, section_title, division, parts, subsections, full_text)

### `lib/api-spec` (`@workspace/api-spec`)

OpenAPI 3.1 spec for all OCR extraction endpoints. Run codegen: `pnpm --filter @workspace/api-spec run codegen`

### `lib/integrations-openai-ai-server` (`@workspace/integrations-openai-ai-server`)

Pre-configured OpenAI client via Replit AI Integrations. Used for vision-based OCR and schema-anchored field extraction.

## Database Schema

- `document_schemas`: id, name, description, fields (JSONB), created_at, updated_at
- `extractions`: id, schema_id, file_name, file_type, status, raw_text, fields (JSONB), overall_confidence, processing_time_ms, error_message, image_data (base64), created_at, updated_at
