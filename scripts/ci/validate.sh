#!/usr/bin/env bash
set -euo pipefail

PASS=0
FAIL=0
WARN=0

pass() { echo "  ✅ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL + 1)); }
warn() { echo "  ⚠️  $1"; WARN=$((WARN + 1)); }

echo ""
echo "═══════════════════════════════════════════════"
echo "  ConstructAI Pre-Deploy Validation"
echo "═══════════════════════════════════════════════"
echo ""

echo "── TypeScript Compilation ──"
API_TS_ERRORS=$(pnpm --filter @workspace/api-server run typecheck 2>&1 | grep -c "error TS" || true)
FE_TS_ERRORS=$(pnpm --filter @workspace/ocr-extractor run typecheck 2>&1 | grep -c "error TS" || true)
if [ "$API_TS_ERRORS" -eq 0 ]; then
  pass "API server typecheck (0 errors)"
else
  fail "API server typecheck ($API_TS_ERRORS errors)"
fi
if [ "$FE_TS_ERRORS" -eq 0 ]; then
  pass "Frontend typecheck (0 errors)"
else
  fail "Frontend typecheck ($FE_TS_ERRORS errors)"
fi
echo ""

echo "── API Server Build ──"
if pnpm --filter @workspace/api-server run build 2>&1 | tail -5; then
  pass "API server build succeeded"
else
  fail "API server build failed"
fi
echo ""

echo "── Frontend Build ──"
if PORT=3000 BASE_PATH="/" pnpm --filter @workspace/ocr-extractor run build 2>&1 | tail -5; then
  pass "Frontend build succeeded"
else
  fail "Frontend build failed"
fi
echo ""

echo "── Database Schema Sync ──"
if [ -z "${DATABASE_URL:-}" ]; then
  if [ "${SKIP_DB_CHECKS:-}" = "1" ]; then
    warn "DATABASE_URL not set — skipping DB checks (SKIP_DB_CHECKS=1)"
  else
    fail "DATABASE_URL not set — cannot verify database (set SKIP_DB_CHECKS=1 to skip)"
  fi
else
  TABLES=$(psql "$DATABASE_URL" -t -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('projects','project_documents','document_chunks','project_chats','data_corrections','verified_facts','unanswered_questions');" 2>/dev/null | tr -d ' ')
  if [ "$TABLES" = "7" ]; then
    pass "All 7 required tables exist"
  else
    fail "Expected 7 tables, found $TABLES"
  fi

  VECTOR_EXT=$(psql "$DATABASE_URL" -t -c "SELECT count(*) FROM pg_extension WHERE extname='vector';" 2>/dev/null | tr -d ' ')
  if [ "$VECTOR_EXT" = "1" ]; then
    pass "pgvector extension installed"
  else
    fail "pgvector extension missing"
  fi
fi
echo ""

if [ -n "${DATABASE_URL:-}" ] && [ "${SKIP_DB_CHECKS:-}" != "1" ]; then
  echo "── Data Integrity ──"

  NULL_EMBEDDINGS=$(psql "$DATABASE_URL" -t -c "SELECT count(*) FROM document_chunks WHERE embedding IS NULL;" 2>/dev/null | tr -d ' ')
  if [ "$NULL_EMBEDDINGS" = "0" ]; then
    pass "All chunks have embeddings"
  else
    warn "$NULL_EMBEDDINGS chunks with null embeddings (will regenerate on startup)"
  fi

  LINKED_INCOMPLETE=$(psql "$DATABASE_URL" -t -c "
    SELECT count(*) FROM construction_extractions ce
    JOIN project_documents pd ON pd.document_id = ce.id AND pd.document_type = 'construction'
    WHERE ce.status != 'completed' OR ce.processed_pages < ce.total_pages;
  " 2>/dev/null | tr -d ' ')
  if [ "$LINKED_INCOMPLETE" = "0" ]; then
    pass "No incomplete extractions linked to projects"
  else
    fail "$LINKED_INCOMPLETE incomplete extractions linked to projects"
  fi
  echo ""
fi

echo "── Required Files ──"
REQUIRED_FILES=(
  "artifacts/api-server/dist/index.mjs"
  "artifacts/api-server/src/lib/integrity.ts"
  "artifacts/api-server/src/routes/projects/router.ts"
  "artifacts/api-server/src/routes/projects/indexer.ts"
  "lib/db/src/schema/projects.ts"
  "scripts/pdf_processor.py"
  "scripts/spec_processor.py"
  "scripts/financial_processor.py"
)
for f in "${REQUIRED_FILES[@]}"; do
  if [ -f "$f" ]; then
    pass "$f exists"
  else
    fail "$f missing"
  fi
done
echo ""

echo "── Python Dependencies ──"
if python3 -c "import pdf2image, cv2, pytesseract, pdfplumber" 2>/dev/null; then
  pass "Python PDF processing dependencies available"
else
  warn "Python PDF dependencies not fully available (pdf2image, cv2, pytesseract, pdfplumber)"
fi
echo ""

echo "── ONNX Embedding Model ──"
if [ -f "artifacts/api-server/models/model.onnx" ]; then
  pass "ONNX embedding model present"
else
  fail "ONNX embedding model missing (artifacts/api-server/models/model.onnx)"
fi
echo ""

echo "═══════════════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed, $WARN warnings"
echo "═══════════════════════════════════════════════"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo "❌ VALIDATION FAILED — do not deploy"
  exit 1
else
  echo "✅ VALIDATION PASSED — safe to deploy"
  exit 0
fi
