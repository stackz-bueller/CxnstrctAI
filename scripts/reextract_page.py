#!/usr/bin/env python3
"""
Targeted re-extraction for a single PDF page with table-aware prompt.
Supports full-page and targeted-crop extraction modes.

Usage:
  Full page (default):
    python3 scripts/reextract_page.py <pdf_path> <page_num> <ai_base_url> <ai_api_key>

  Targeted crop (specify crop region as percentages 0.0-1.0):
    python3 scripts/reextract_page.py <pdf_path> <page_num> <ai_base_url> <ai_api_key> \
      --crop <left> <top> <right> <bottom>

  Apply corrections directly to the database:
    python3 scripts/reextract_page.py <pdf_path> <page_num> <ai_base_url> <ai_api_key> \
      --apply --extraction-id <id> [--crop ...]

  Remove hallucinated tables from a page (no vision call needed):
    python3 scripts/reextract_page.py <pdf_path> <page_num> <ai_base_url> <ai_api_key> \
      --purge-tables --apply --extraction-id <id>

Examples:
  # Extract center-right region of page 42 (where pipe tables typically live)
  python3 scripts/reextract_page.py plans.pdf 42 $URL $KEY --crop 0.5 0.0 0.85 0.45

  # Extract and apply directly to extraction id=2
  python3 scripts/reextract_page.py plans.pdf 42 $URL $KEY --crop 0.5 0.0 0.85 0.45 \
    --apply --extraction-id 2

  # Remove all tables from page 16 (site plan with hallucinated tables)
  python3 scripts/reextract_page.py plans.pdf 16 $URL $KEY --purge-tables --apply --extraction-id 2

Common crop presets (--crop-preset):
  center-right   : 0.5  0.0  0.85 0.45  — pipe/data tables on right side
  bottom-right   : 0.5  0.5  1.0  1.0   — title block area
  left-half      : 0.0  0.0  0.5  1.0   — left side content
  right-half     : 0.5  0.0  1.0  1.0   — right side content
  top-half       : 0.0  0.0  1.0  0.5   — top half
  bottom-half    : 0.0  0.5  1.0  1.0   — bottom half
"""

import sys
import json
import base64
import io
import re
import os
import argparse
from datetime import datetime, timezone

import pdf2image
from PIL import Image
import httpx
from openai import OpenAI

STANDARD_PIPE_SIZES = [4, 6, 8, 10, 12, 15, 18, 21, 24, 27, 30, 36, 42, 48, 54, 60, 72]

CROP_PRESETS = {
    "center-right": (0.5, 0.0, 0.85, 0.45),
    "bottom-right": (0.5, 0.5, 1.0, 1.0),
    "left-half": (0.0, 0.0, 0.5, 1.0),
    "right-half": (0.5, 0.0, 1.0, 1.0),
    "top-half": (0.0, 0.0, 1.0, 0.5),
    "bottom-half": (0.0, 0.5, 1.0, 1.0),
}

TABLE_PROMPT = """You are a construction drawing analyst specializing in extracting tabular data from engineering drawings.

Analyze this drawing page carefully. Your primary goal is to find and extract ALL tables, including:
- Pipe geometry tables (pipe ID, from, to, diameter, length, inverts, slope, material)
- Drainage structure tables (inlet boxes, manholes, outlet control structures)
- Pavement section tables (layer thicknesses, materials, compaction requirements)
- Compaction density tables (% compaction, density requirements by material/layer)
- Operation and maintenance tables
- Material specification tables
- Notes tables
- Any other structured tabular data

For EACH table found, extract it completely with all rows and columns as text.

Also extract all other text visible on the page.

Return JSON:
{
  "tables": [
    {
      "title": "table heading if present",
      "headers": ["col1", "col2", ...],
      "rows": [["val1", "val2", ...], ...],
      "raw_text": "full table as plain text preserving structure"
    }
  ],
  "all_text": "ALL visible text on the page in reading order, including table contents",
  "notes": ["any numbered or lettered notes found"],
  "callouts": ["labels, annotations, callouts found"]
}

NUMERICAL ACCURACY IS CRITICAL:
- Pipe diameters are standard sizes: 4, 6, 8, 10, 12, 15, 18, 21, 24, 27, 30, 36, 42, 48, 54, 60, 72 inches
- NEVER report non-standard diameters like 13", 17", or 19" — re-examine the image if you see one
- Pipe IDs follow phase conventions: P1-xx for Phase 1, P2-xx for Phase 2, P3-xx for Phase 3
- Read each cell value carefully by looking at the actual characters in the image
- Double-check every number before including it
- If a value is unclear, mark it as "?" rather than guessing
- Elevation values typically have 2 decimal places (e.g., 73.50, not 73.5)
- Slopes are typically expressed as percentages with 1 decimal place"""


def pil_to_base64(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    return base64.b64encode(buf.getvalue()).decode()


def validate_pipe_data(tables: list) -> list:
    warnings = []
    for table in tables:
        title = (table.get("title") or "").lower()
        if "pipe" not in title and "drainage" not in title:
            continue
        headers = [h.lower() for h in (table.get("headers") or [])]
        diam_idx = None
        for i, h in enumerate(headers):
            if "diam" in h or "size" in h:
                diam_idx = i
                break
        if diam_idx is None:
            for i, h in enumerate(headers):
                if h in ("in", "inches", "dia", "d"):
                    diam_idx = i
                    break
        if diam_idx is None:
            continue
        for row in table.get("rows", []):
            if diam_idx >= len(row):
                continue
            val = row[diam_idx]
            if isinstance(val, str):
                val = val.replace('"', '').replace("'", '').strip()
            try:
                diam = int(float(val))
            except (ValueError, AttributeError, TypeError):
                continue
            if diam > 120:
                continue
            if diam not in STANDARD_PIPE_SIZES:
                pipe_id = row[0] if row else "?"
                warnings.append(
                    f"Non-standard pipe diameter: {pipe_id} = {diam}\" "
                    f"(expected one of: {[s for s in STANDARD_PIPE_SIZES if abs(s - diam) <= 6]})"
                )
    return warnings


def apply_to_database(extraction_id: int, page_num: int, result: dict,
                      crop_box: tuple | None, purge_tables: bool):
    try:
        import psycopg2
    except ImportError:
        print("ERROR: psycopg2 not installed, cannot apply to database", file=sys.stderr)
        sys.exit(1)

    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("ERROR: DATABASE_URL not set", file=sys.stderr)
        sys.exit(1)

    conn = psycopg2.connect(db_url)
    cur = conn.cursor()

    cur.execute("SELECT pages FROM construction_extractions WHERE id = %s", [extraction_id])
    row = cur.fetchone()
    if not row:
        print(f"ERROR: extraction id={extraction_id} not found", file=sys.stderr)
        sys.exit(1)

    pages = row[0]
    page_idx = None
    for i, p in enumerate(pages):
        if p["page_number"] == page_num:
            page_idx = i
            break

    if page_idx is None:
        print(f"ERROR: page {page_num} not found in extraction", file=sys.stderr)
        sys.exit(1)

    before_snapshot = {
        "tables_count": len(pages[page_idx].get("tables", [])),
        "all_text_length": len(pages[page_idx].get("all_text", "")),
        "table_titles": [t.get("title", "") for t in pages[page_idx].get("tables", [])],
    }

    if purge_tables:
        pages[page_idx]["tables"] = []
        detention_words = [
            "detention basin", "underground chamber", "number of chambers",
            "chamber size", "basin schedule", "basin type", "basin material",
        ]
        all_text = pages[page_idx].get("all_text", "")
        lines = all_text.split('\n')
        clean_lines = [
            l for l in lines
            if not any(w in l.lower() for w in detention_words)
        ]
        pages[page_idx]["all_text"] = '\n'.join(clean_lines).strip()
        action = "purge_tables"
    elif crop_box:
        pages[page_idx]["tables"] = result.get("tables", [])
        pages[page_idx]["all_text"] = (
            f"Re-extracted via targeted crop ({crop_box}). "
            "See tables for structured data.\n"
            + (result.get("all_text") or "")
        )
        notes = result.get("notes", [])
        if notes:
            pages[page_idx]["general_notes"] = notes
        callouts = result.get("callouts", [])
        if callouts:
            pages[page_idx]["callouts"] = [
                {"text": c, "type": "annotation"} if isinstance(c, str) else c
                for c in callouts
            ]
        action = f"crop_replace:{crop_box}"
    else:
        pages[page_idx]["tables"] = result.get("tables", [])
        pages[page_idx]["all_text"] = result.get("all_text", "")
        notes = result.get("notes", [])
        if notes:
            pages[page_idx]["general_notes"] = notes
        callouts = result.get("callouts", [])
        if callouts:
            pages[page_idx]["callouts"] = [
                {"text": c, "type": "annotation"} if isinstance(c, str) else c
                for c in callouts
            ]
        action = "full_page_replace"

    after_snapshot = {
        "tables_count": len(pages[page_idx].get("tables", [])),
        "all_text_length": len(pages[page_idx].get("all_text", "")),
        "table_titles": [t.get("title", "") for t in pages[page_idx].get("tables", [])],
    }

    cur.execute(
        "UPDATE construction_extractions SET pages = %s WHERE id = %s",
        [json.dumps(pages), extraction_id]
    )
    conn.commit()

    audit = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "extraction_id": extraction_id,
        "page_number": page_num,
        "action": action,
        "crop_box": crop_box,
        "before": before_snapshot,
        "after": after_snapshot,
    }
    audit_dir = os.path.join(os.path.dirname(__file__), "..", ".local", "extraction_audits")
    os.makedirs(audit_dir, exist_ok=True)
    audit_file = os.path.join(
        audit_dir,
        f"ext{extraction_id}_page{page_num}_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}.json"
    )
    with open(audit_file, "w") as f:
        json.dump(audit, f, indent=2)
    print(f"Audit log: {audit_file}", file=sys.stderr)

    print(f"Applied to extraction {extraction_id}, page {page_num}", file=sys.stderr)
    print(f"  Before: {before_snapshot['tables_count']} tables, {before_snapshot['all_text_length']} chars text", file=sys.stderr)
    print(f"  After:  {after_snapshot['tables_count']} tables, {after_snapshot['all_text_length']} chars text", file=sys.stderr)

    cur.close()
    conn.close()


def main():
    parser = argparse.ArgumentParser(
        description="Targeted re-extraction for a single PDF page",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("pdf_path", nargs="?", help="Path to the PDF file")
    parser.add_argument("page_num", type=int, help="Page number to extract (1-indexed)")
    parser.add_argument("ai_base_url", nargs="?", help="OpenAI-compatible API base URL")
    parser.add_argument("ai_api_key", nargs="?", help="API key")
    parser.add_argument(
        "--crop", nargs=4, type=float, metavar=("LEFT", "TOP", "RIGHT", "BOTTOM"),
        help="Crop region as fractions 0.0-1.0 (e.g., 0.5 0.0 0.85 0.45)"
    )
    parser.add_argument(
        "--crop-preset", choices=list(CROP_PRESETS.keys()),
        help="Use a named crop preset instead of manual --crop values"
    )
    parser.add_argument("--dpi", type=int, default=200, help="PDF render DPI (default: 200)")
    parser.add_argument("--max-px", type=int, default=2400, help="Max image width in pixels (default: 2400)")
    parser.add_argument("--max-tokens", type=int, default=4096, help="Max response tokens (default: 4096)")
    parser.add_argument("--apply", action="store_true", help="Apply results directly to the database")
    parser.add_argument("--extraction-id", type=int, help="Extraction ID for --apply mode")
    parser.add_argument("--purge-tables", action="store_true",
                        help="Remove all tables from the page (no vision call)")
    parser.add_argument("--quiet", action="store_true", help="Suppress JSON output to stdout")

    args = parser.parse_args()

    if args.apply and not args.extraction_id:
        print("ERROR: --apply requires --extraction-id", file=sys.stderr)
        sys.exit(1)

    if not args.purge_tables:
        if not args.pdf_path:
            print("ERROR: pdf_path is required (unless using --purge-tables --apply)", file=sys.stderr)
            sys.exit(1)
        if not args.ai_base_url or not args.ai_api_key:
            print("ERROR: ai_base_url and ai_api_key are required for extraction", file=sys.stderr)
            sys.exit(1)

    crop_box = None
    if args.crop_preset:
        crop_box = CROP_PRESETS[args.crop_preset]
        print(f"Using crop preset '{args.crop_preset}': {crop_box}", file=sys.stderr)
    elif args.crop:
        crop_box = tuple(args.crop)
        for v in crop_box:
            if not 0.0 <= v <= 1.0:
                print(f"ERROR: crop values must be 0.0-1.0, got {v}", file=sys.stderr)
                sys.exit(1)
        if crop_box[0] >= crop_box[2] or crop_box[1] >= crop_box[3]:
            print("ERROR: crop left must be < right, top must be < bottom", file=sys.stderr)
            sys.exit(1)

    if args.purge_tables:
        if args.apply:
            apply_to_database(args.extraction_id, args.page_num, {}, crop_box, purge_tables=True)
        else:
            print(json.dumps({"tables": [], "all_text": "", "notes": [], "callouts": [],
                              "_action": "purge_tables"}))
        return

    print(f"Loading page {args.page_num} from {args.pdf_path} at {args.dpi} DPI...", file=sys.stderr)
    images = pdf2image.convert_from_path(
        args.pdf_path,
        dpi=args.dpi,
        first_page=args.page_num,
        last_page=args.page_num,
        thread_count=1,
    )
    img = images[0]
    print(f"Full page: {img.width}x{img.height}", file=sys.stderr)

    if crop_box:
        left = int(img.width * crop_box[0])
        top = int(img.height * crop_box[1])
        right = int(img.width * crop_box[2])
        bottom = int(img.height * crop_box[3])
        img = img.crop((left, top, right, bottom))
        print(f"Cropped to: {img.width}x{img.height} (box: {crop_box})", file=sys.stderr)

    if img.width > args.max_px:
        ratio = args.max_px / img.width
        img = img.resize((args.max_px, int(img.height * ratio)), Image.LANCZOS)
        print(f"Resized to: {img.width}x{img.height}", file=sys.stderr)

    b64 = pil_to_base64(img)
    img_kb = len(base64.b64decode(b64)) / 1024
    print(f"Sending to GPT-4o ({img_kb:.0f} KB, max_tokens={args.max_tokens})...", file=sys.stderr)

    client = OpenAI(
        base_url=args.ai_base_url,
        api_key=args.ai_api_key,
        http_client=httpx.Client(timeout=httpx.Timeout(180.0, connect=15.0)),
    )
    response = client.chat.completions.create(
        model="gpt-4o",
        max_tokens=args.max_tokens,
        messages=[{
            "role": "user",
            "content": [
                {"type": "text", "text": TABLE_PROMPT},
                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}}
            ]
        }]
    )

    content = response.choices[0].message.content or ""
    print(f"Response: {len(content)} chars", file=sys.stderr)

    content_clean = content.strip()
    if content_clean.startswith("```"):
        content_clean = re.sub(r'^```json?\s*', '', content_clean)
        content_clean = re.sub(r'```\s*$', '', content_clean)

    result = None
    first_brace = content_clean.find('{')
    if first_brace >= 0:
        raw_json = content_clean[first_brace:]
        try:
            result = json.loads(raw_json)
        except json.JSONDecodeError:
            raw_json = raw_json.rstrip().rstrip(',')
            for suffix in ['"}]}', ']]]}', ']}]}', '"]}', ']}', '}']:
                try:
                    result = json.loads(raw_json + suffix)
                    print(f"JSON repaired with suffix: {suffix}", file=sys.stderr)
                    break
                except json.JSONDecodeError:
                    continue
            if result is None:
                depth = 0
                last_valid = -1
                in_string = False
                escape = False
                for ci, ch in enumerate(raw_json):
                    if escape:
                        escape = False
                        continue
                    if ch == '\\' and in_string:
                        escape = True
                        continue
                    if ch == '"' and not escape:
                        in_string = not in_string
                        continue
                    if in_string:
                        continue
                    if ch == '{':
                        depth += 1
                    elif ch == '}':
                        depth -= 1
                        if depth == 0:
                            last_valid = ci
                            break
                if last_valid > 0:
                    try:
                        result = json.loads(raw_json[:last_valid + 1])
                    except json.JSONDecodeError:
                        pass
    if result is None:
        print(f"WARNING: Could not parse JSON response", file=sys.stderr)
        result = {"tables": [], "all_text": content, "notes": [], "callouts": []}

    warnings = validate_pipe_data(result.get("tables", []))
    if warnings:
        print(f"\n{'='*60}", file=sys.stderr)
        print("VALIDATION WARNINGS:", file=sys.stderr)
        for w in warnings:
            print(f"  ⚠ {w}", file=sys.stderr)
        print(f"{'='*60}\n", file=sys.stderr)
        result["_validation_warnings"] = warnings

    table_count = len(result.get("tables", []))
    total_rows = sum(len(t.get("rows", [])) for t in result.get("tables", []))
    print(f"Extracted: {table_count} tables, {total_rows} total rows", file=sys.stderr)

    if not args.quiet:
        print(json.dumps(result, indent=2))

    if args.apply:
        apply_to_database(args.extraction_id, args.page_num, result, crop_box, purge_tables=False)


if __name__ == "__main__":
    main()
