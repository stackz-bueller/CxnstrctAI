/**
 * Applies a page supplement JSON (from reextract_page.py) to the
 * construction_extractions table, then triggers re-indexing via the API.
 *
 * Usage:
 *   node scripts/apply_page_supplement.mjs <extraction_id> <page_num> <supplement_json_file>
 */
import fs from "fs";
import pg from "pg";

const { Client } = pg;

const [, , extractionId, pageNum, supplementFile] = process.argv;

if (!extractionId || !pageNum || !supplementFile) {
  console.error("Usage: node apply_page_supplement.mjs <extraction_id> <page_num> <supplement_json_file>");
  process.exit(1);
}

const supplement = JSON.parse(fs.readFileSync(supplementFile, "utf8"));

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

// Load current pages
const { rows } = await client.query(
  "SELECT pages FROM construction_extractions WHERE id = $1",
  [parseInt(extractionId)]
);
if (!rows[0]) {
  console.error("Extraction not found");
  process.exit(1);
}

const pages = rows[0].pages;
const targetPageNum = parseInt(pageNum);
const target = pages.find((p) => p.page_number === targetPageNum);

if (!target) {
  console.error(`Page ${pageNum} not found`);
  process.exit(1);
}

// Build supplemental text from tables
const extraParts = [];
const tables = supplement.tables || [];
if (tables.length > 0) {
  extraParts.push("\n\n=== COMPACTION DENSITY TABLES ===");
  for (const t of tables) {
    if (t.title) extraParts.push(`\nTable: ${t.title}`);
    if (t.headers?.length) extraParts.push("Headers: " + t.headers.join(" | "));
    for (const row of t.rows || []) {
      extraParts.push(row.join(" | "));
    }
    if (t.raw_text) extraParts.push("\n" + t.raw_text);
  }
}

// Append supplement notes that aren't already present
const supplementNotes = supplement.notes || [];
const existingNotesLower = (target.general_notes || []).map((n) => n.toLowerCase());
const newNotes = supplementNotes.filter(
  (n) => !existingNotesLower.some((e) => e.includes(n.slice(0, 50).toLowerCase()))
);
if (newNotes.length > 0) {
  extraParts.push("\n\n=== SUPPLEMENTAL NOTES ===");
  extraParts.push(...newNotes);
}

// Update all_text
target.all_text = (target.all_text || "") + extraParts.join("\n");

// Add tables field
target.tables = tables;

// Add new callouts
const existingCalloutTexts = new Set((target.callouts || []).map((c) => c.text?.toLowerCase()));
for (const ct of supplement.callouts || []) {
  if (!existingCalloutTexts.has(ct.toLowerCase())) {
    (target.callouts = target.callouts || []).push({ text: ct, type: "annotation" });
  }
}

// Add new general_notes
for (const note of supplementNotes) {
  if (!existingNotesLower.some((e) => e.includes(note.slice(0, 40).toLowerCase()))) {
    (target.general_notes = target.general_notes || []).push(note);
  }
}

await client.query(
  "UPDATE construction_extractions SET pages = $1::jsonb WHERE id = $2",
  [JSON.stringify(pages), parseInt(extractionId)]
);

console.log(`Updated page ${pageNum} in extraction ${extractionId}`);
console.log(`Tables merged: ${tables.length}`);
if (tables[0]) {
  console.log(`First table: "${tables[0].title}"`);
  console.log(`Rows: ${tables[0].rows?.length}`);
  tables[0].rows?.forEach((r) => console.log("  ", r.join(" | ")));
}

await client.end();
