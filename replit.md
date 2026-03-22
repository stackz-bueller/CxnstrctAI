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
- **AI**: OpenAI via Replit AI Integrations (gpt-5.2 with vision)

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

### API Endpoints

- `GET /api/schemas` — list schemas
- `POST /api/schemas` — create schema
- `GET /api/schemas/:id` — get schema
- `DELETE /api/schemas/:id` — delete schema
- `GET /api/extractions` — list all extractions (optional `?schemaId=` filter)
- `GET /api/extractions/:id` — get extraction result
- `GET /api/extractions/:id/raw-text` — get raw OCR text
- `POST /api/extractions/upload` — multipart upload (file + schemaId)

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
- Depends on: `@workspace/db`, `@workspace/api-zod`, `@workspace/integrations-openai-ai-server`

### `artifacts/ocr-extractor` (`@workspace/ocr-extractor`)

React + Vite frontend. Pages:
- Extract Document — schema selection + drag-and-drop upload
- Document Schemas — schema list and management
- Schema New — field builder for new schemas
- History — past extraction results
- Extraction Details — field values, confidence scores, raw OCR text

### `lib/db` (`@workspace/db`)

- `document_schemas` table — schema definitions with JSONB fields
- `extractions` table — extraction results with JSONB field values

### `lib/api-spec` (`@workspace/api-spec`)

OpenAPI 3.1 spec for all OCR extraction endpoints. Run codegen: `pnpm --filter @workspace/api-spec run codegen`

### `lib/integrations-openai-ai-server` (`@workspace/integrations-openai-ai-server`)

Pre-configured OpenAI client via Replit AI Integrations. Used for vision-based OCR and schema-anchored field extraction.

## Database Schema

- `document_schemas`: id, name, description, fields (JSONB), created_at, updated_at
- `extractions`: id, schema_id, file_name, file_type, status, raw_text, fields (JSONB), overall_confidence, processing_time_ms, error_message, image_data (base64), created_at, updated_at
