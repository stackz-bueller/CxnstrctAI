#!/usr/bin/env python3
"""
Construction PDF Ingestion Pipeline
====================================
Two-pass extraction for construction engineering documents:
  Pass 1: PDF → images → OpenCV preprocessing → Tesseract OCR (targeted regions)
  Pass 2: Downsampled page images → GPT-4o Vision (2×2 tiled, memory-efficient)
  Pass 3: Merge OCR + Vision, vision takes priority

Memory/performance strategy:
  - Convert ONE page at a time (never all pages at once)
  - 100 DPI for PDF conversion (sufficient for large-format drawings)
  - Downscale images to max 2400px wide before Tesseract (speed + memory)
  - Resize vision tiles to max 1200px before GPT-4o
  - 2×2 tile grid (4 tiles per page)
  - Explicit gc.collect() between pages

Usage:
  python3 pdf_processor.py <pdf_path> <ai_base_url> <ai_api_key>
  Output: JSON to stdout
"""

import sys
import json
import base64
import time
import io
import re
import gc
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np
import cv2
from PIL import Image
import pytesseract
from pytesseract import Output
import pdf2image
import httpx
from openai import OpenAI

MAX_PAGES = 2000         # No practical limit — process entire drawing sets
DPI = 100                # 100 DPI — enough for large-format engineering drawings
MAX_OCR_WIDTH = 1600     # Downscale images wider than this before Tesseract
TILE_GRID = (2, 2)       # 2×2 = 4 tiles per page
TILE_OVERLAP = 0.12      # 12% overlap between tiles — prevents boundary content loss
VISION_MAX_PX = 2000     # Max width for vision images sent to GPT-4o (full page)
VISION_MAX_TOKENS = 4096 # Response token limit for GPT-4o (full page, single call)
MIN_OCR_CHARS_FOR_VISION = 100  # Skip vision if OCR text shorter than this (nearly blank page)
TABLE_ROW_THRESHOLD = 8  # If full-page extraction gets >= this many table rows, do multi-crop verification
STANDARD_PIPE_SIZES = {4, 6, 8, 10, 12, 15, 18, 21, 24, 27, 30, 36, 42, 48, 54, 60, 72}

MULTI_CROP_REGIONS = [
    ("top-left",     (0.0,  0.0,  0.55, 0.55)),
    ("top-right",    (0.45, 0.0,  1.0,  0.55)),
    ("bottom-left",  (0.0,  0.45, 0.55, 1.0)),
    ("bottom-right", (0.45, 0.45, 1.0,  1.0)),
]


def get_page_count(pdf_path: str) -> int:
    info = pdf2image.pdfinfo_from_path(pdf_path)
    return int(info.get("Pages", 0))


def load_single_page(pdf_path: str, page_num: int) -> Image.Image:
    """Convert a single PDF page to a PIL Image at DPI. Load only one page."""
    images = pdf2image.convert_from_path(
        pdf_path,
        dpi=DPI,
        first_page=page_num,
        last_page=page_num,
        thread_count=1,
    )
    return images[0]


def downscale_if_large(img: Image.Image, max_width: int) -> Image.Image:
    """Downscale image width to max_width if needed, preserve aspect ratio."""
    if img.width > max_width:
        ratio = max_width / img.width
        new_h = int(img.height * ratio)
        return img.resize((max_width, new_h), Image.LANCZOS)
    return img


def preprocess_for_ocr(pil_image: Image.Image) -> np.ndarray:
    """Grayscale + adaptive threshold for Tesseract."""
    img_array = np.array(pil_image)
    if img_array.ndim == 3:
        bgr = cv2.cvtColor(img_array, cv2.COLOR_RGB2BGR)
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    else:
        gray = img_array
    processed = cv2.adaptiveThreshold(
        gray, 255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY, 11, 2
    )
    return processed


def ocr_image(np_image: np.ndarray) -> tuple[str, float]:
    """Run Tesseract OCR. Returns (text, avg_confidence)."""
    text = pytesseract.image_to_string(np_image, config='--psm 6')
    try:
        data = pytesseract.image_to_data(np_image, output_type=Output.DICT)
        confidences = [int(c) for c in data['conf'] if str(c).strip() not in ('-1', '')]
        avg_conf = sum(confidences) / len(confidences) / 100.0 if confidences else 0.0
    except Exception:
        avg_conf = 0.0
    return text.strip(), avg_conf


def crop_region(image: Image.Image, x_pct: tuple, y_pct: tuple) -> Image.Image:
    """Crop a region defined by percentage bounds (x: left..right, y: top..bottom)."""
    w, h = image.size
    x1 = int(w * x_pct[0])
    x2 = int(w * x_pct[1])
    y1 = int(h * y_pct[0])
    y2 = int(h * y_pct[1])
    return image.crop((x1, y1, x2, y2))


def ocr_region(page: Image.Image, x_pct: tuple, y_pct: tuple) -> tuple[str, float]:
    """Crop + downscale + preprocess + OCR a region."""
    cropped = crop_region(page, x_pct, y_pct)
    cropped = downscale_if_large(cropped, MAX_OCR_WIDTH)
    processed = preprocess_for_ocr(cropped)
    result = ocr_image(processed)
    del cropped, processed
    return result


def detect_callout_candidates(page_small: Image.Image) -> list[str]:
    """Detect text matching callout patterns in small regions via contour+OCR."""
    callout_pattern = re.compile(
        r'(DETAIL\s+[A-Z0-9]+|SECTION\s+[A-Z0-9\-/]+|SEE\s+NOTE\s+[0-9]+|TYP\.?|'
        r'[A-Z]-[A-Z0-9]|[A-Z]/[A-Z0-9]|\([A-Z0-9]+\)|SCALE\s+\d+:\d+|'
        r'(N|S|E|W|NE|NW|SE|SW)\s*(ELEVATION|ELEV)|SIM\.?)',
        re.IGNORECASE
    )
    # Work on a small version to avoid slowness
    small = downscale_if_large(page_small, 1600)
    processed = preprocess_for_ocr(small)
    inverted = cv2.bitwise_not(processed)
    contours, _ = cv2.findContours(inverted, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    del processed, inverted, small

    results = []
    for cnt in contours[:25]:
        x, y, cw, ch = cv2.boundingRect(cnt)
        if (15 < cw < 200) and (8 < ch < 60):
            roi = page_small.crop((x, y, x + cw, y + ch))
            np_roi = preprocess_for_ocr(roi)
            del roi
            text, _ = ocr_image(np_roi)
            del np_roi
            if text and callout_pattern.search(text):
                results.append(text.strip())

    return list(set(results))[:15]


def tile_image(page: Image.Image) -> list[tuple[str, Image.Image]]:
    """Split into 2×2 grid with overlap."""
    w, h = page.size
    rows, cols = TILE_GRID
    overlap_x = int(w * TILE_OVERLAP)
    overlap_y = int(h * TILE_OVERLAP)
    tile_w = w // cols
    tile_h = h // rows

    names = ["top-left", "top-right", "bottom-left", "bottom-right"]
    tiles = []
    for r in range(rows):
        for c in range(cols):
            x1 = max(0, c * tile_w - overlap_x)
            y1 = max(0, r * tile_h - overlap_y)
            x2 = min(w, (c + 1) * tile_w + overlap_x)
            y2 = min(h, (r + 1) * tile_h + overlap_y)
            tiles.append((names[r * cols + c], page.crop((x1, y1, x2, y2))))

    return tiles


def pil_to_base64(img: Image.Image, max_width: int = VISION_MAX_PX) -> str:
    """Resize and encode as base64 JPEG."""
    img = downscale_if_large(img, max_width)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=82)
    return base64.b64encode(buf.getvalue()).decode("utf-8")


VISION_PROMPT = """You are a construction drawing analyst. Extract ALL readable text and structured data from this section of an engineering drawing. Be exhaustive — do not skip or summarize anything.

Return JSON with exactly this structure:
{
  "title_block": {
    "project_name": null,
    "drawing_title": null,
    "sheet_number": null,
    "revision": null,
    "date": null,
    "drawn_by": null,
    "scale": null,
    "confidence": 0.0
  },
  "revision_history": [
    { "rev_number": null, "date": null, "description": null }
  ],
  "general_notes": ["list of note text — include the FULL text of each note, never truncate"],
  "tables": [
    {
      "title": "table heading",
      "headers": ["col1", "col2"],
      "rows": [["val1", "val2"]],
      "raw_text": "full table rendered as plain text"
    }
  ],
  "callouts": [
    { "text": "", "type": "detail_ref | section_cut | note | grid | annotation" }
  ],
  "legends": [
    { "symbol": "", "description": "" }
  ],
  "all_text": "ALL visible text in reading order — include complete table contents, every note in full, all dimensions, all specifications"
}

Rules:
- Extract EVERY piece of visible text — do not summarize, abbreviate, or skip anything
- Return null for title_block fields not visible; return empty arrays for missing lists
- Include every note, callout, label, dimension, specification, and table you can read
- TABLES ARE CRITICAL: Extract ALL tables completely — compaction density tables, material schedules, dimension tables, pipe schedules, quantity tables. Include every row, column header, and cell value
- NUMERICAL ACCURACY IS CRITICAL: Read each number carefully. Pipe diameters are typically 12", 15", 18", 24", 30", 36", 42", 48" — not arbitrary values like 13 or 17. Double-check every number against the actual text in the image
- Pipe IDs follow phase conventions (P1-xx for Phase 1, P2-xx for Phase 2, etc.) — preserve the exact ID as written
- Include all percentages, densities, strengths (PSI), dimensions, and numerical specifications
- Include all references to standards (PennDOT, ASTM, AASHTO, ACI, etc.) with their full section numbers
- confidence: 0.0-1.0 based on how clearly title block info is present"""


VISION_TIMEOUT = 120
VISION_MAX_RETRIES = 3
VISION_RETRY_DELAY = 5

def vision_extract(client: OpenAI, img: Image.Image) -> dict:
    """Send an image tile to GPT-4o Vision and return structured JSON with timeout + retry."""
    b64 = pil_to_base64(img)
    empty = {
        "title_block": {k: None for k in ["project_name","drawing_title","sheet_number","revision","date","drawn_by","scale","confidence"]},
        "revision_history": [],
        "general_notes": [],
        "tables": [],
        "callouts": [],
        "legends": [],
        "all_text": ""
    }
    for attempt in range(1, VISION_MAX_RETRIES + 1):
        try:
            response = client.chat.completions.create(
                model="gpt-4o",
                max_tokens=VISION_MAX_TOKENS,
                messages=[{
                    "role": "user",
                    "content": [
                        {"type": "text", "text": VISION_PROMPT},
                        {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}}
                    ]
                }]
            )
            content = response.choices[0].message.content or ""
            json_match = re.search(r'\{[\s\S]*\}', content)
            if json_match:
                result = json.loads(json_match.group())
                if "tables" not in result:
                    result["tables"] = []
                return result
        except Exception as e:
            print(f"Vision extract error (attempt {attempt}/{VISION_MAX_RETRIES}): {e}", file=sys.stderr)
            if attempt < VISION_MAX_RETRIES:
                time.sleep(VISION_RETRY_DELAY * attempt)
    return empty


def count_table_rows(vision_data: dict) -> int:
    total = 0
    for t in vision_data.get("tables", []):
        total += len(t.get("rows", []))
    return total


def has_table_content(vision_data: dict) -> bool:
    return count_table_rows(vision_data) >= TABLE_ROW_THRESHOLD


def validate_pipe_diameters(tables: list) -> list:
    warnings = []
    for t in tables:
        title = (t.get("title") or "").lower()
        if "pipe" not in title:
            continue
        headers = [h.lower() for h in (t.get("headers") or [])]
        diam_idx = -1
        for i, h in enumerate(headers):
            if "diam" in h or "size" in h:
                diam_idx = i
                break
        if diam_idx < 0:
            continue
        for row in t.get("rows", []):
            if diam_idx >= len(row):
                continue
            try:
                val = str(row[diam_idx]).replace('"', '').replace("'", '').strip()
                diam = int(float(val))
            except (ValueError, TypeError):
                continue
            if 0 < diam <= 120 and diam not in STANDARD_PIPE_SIZES:
                pipe_id = row[0] if row else "?"
                warnings.append(f"{pipe_id}={diam}\"")
    return warnings


def check_sequential_gaps(tables: list) -> list:
    all_ids: dict[str, list[int]] = {}
    for t in tables:
        for row in t.get("rows", []):
            pid = row[0] if row else ""
            m = re.match(r'^([A-Za-z]+\d*)-(\d+)$', pid)
            if m:
                prefix = m.group(1).upper()
                num = int(m.group(2))
                all_ids.setdefault(prefix, []).append(num)

    gaps = []
    for prefix, nums in all_ids.items():
        nums.sort()
        for i in range(1, len(nums)):
            diff = nums[i] - nums[i-1]
            if diff > 1 and diff <= 5:
                missing = [f"{prefix}-{str(n).zfill(2)}" for n in range(nums[i-1]+1, nums[i])]
                gaps.append(f"Gap: {', '.join(missing)}")
    return gaps


def extract_table_from_crop(client: OpenAI, page: Image.Image, region_name: str,
                            crop_box: tuple, max_px: int = 2400) -> dict:
    left = int(page.width * crop_box[0])
    top = int(page.height * crop_box[1])
    right = int(page.width * crop_box[2])
    bottom = int(page.height * crop_box[3])
    cropped = page.crop((left, top, right, bottom))

    if cropped.width > max_px:
        ratio = max_px / cropped.width
        cropped = cropped.resize((max_px, int(cropped.height * ratio)), Image.LANCZOS)

    prompt = """Extract ALL tables from this image section completely. Return JSON:
{"tables":[{"title":"...","headers":[...],"rows":[[...]]}],"all_text":"all visible text"}

CRITICAL RULES:
- Extract EVERY row of EVERY table. Do NOT stop early or truncate.
- Pipe diameters are standard sizes only: 4, 6, 8, 10, 12, 15, 18, 21, 24, 27, 30, 36, 42, 48, 54, 60, 72 inches
- If a number looks like 17, it is most likely 12 or 18. If it looks like 13, it is most likely 12 or 15. Re-examine carefully.
- Preserve exact IDs as written (P1-01, P2-03, MH-4, EXIN-5, OGS-1, etc.)
- Include ALL columns for each row — do not skip any cells
- If a value is unclear, use "?" rather than guessing"""

    b64 = pil_to_base64(cropped, max_width=max_px)
    del cropped

    empty = {"tables": [], "all_text": ""}
    try:
        response = client.chat.completions.create(
            model="gpt-4o",
            max_tokens=VISION_MAX_TOKENS,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}}
                ]
            }]
        )
        content = response.choices[0].message.content or ""
        content = content.strip()
        if content.startswith("```"):
            content = re.sub(r'^```json?\s*', '', content)
            content = re.sub(r'```\s*$', '', content)

        first_brace = content.find('{')
        if first_brace >= 0:
            raw = content[first_brace:]
            try:
                return json.loads(raw)
            except json.JSONDecodeError:
                raw = raw.rstrip().rstrip(',')
                for suffix in ['"}]}', ']]]}', ']}]}', '"]}', ']}', '}']:
                    try:
                        return json.loads(raw + suffix)
                    except json.JSONDecodeError:
                        continue
    except Exception as e:
        print(f"  Crop {region_name} error: {e}", file=sys.stderr)
    return empty


def merge_table_extractions(full_page: dict, crop_results: list[tuple[str, dict]]) -> dict:
    all_rows_by_table: dict[str, dict] = {}
    anon_counter = [0]

    def normalize_title(t: str) -> str:
        return re.sub(r'\s+', ' ', t.strip().upper())

    def row_key(row: list) -> str:
        first = (row[0] if row else "").strip().upper()
        if first:
            return first
        cell_hash = "|".join(str(c).strip() for c in row).upper()
        if cell_hash.replace("|", "").strip():
            return f"__ANON_{cell_hash}"
        anon_counter[0] += 1
        return f"__EMPTY_{anon_counter[0]}"

    for source_name, data in [("full_page", full_page)] + crop_results:
        for table in data.get("tables", []):
            title = normalize_title(table.get("title", "UNTITLED"))
            if title not in all_rows_by_table:
                all_rows_by_table[title] = {
                    "title": table.get("title", ""),
                    "headers": table.get("headers", []),
                    "rows": {},
                    "sources": set(),
                }
            entry = all_rows_by_table[title]
            if table.get("headers") and len(table["headers"]) > len(entry["headers"]):
                entry["headers"] = table["headers"]
            for row in table.get("rows", []):
                rk = row_key(row)
                if rk not in entry["rows"]:
                    entry["rows"][rk] = {"data": row, "sources": {source_name}, "conflicts": []}
                else:
                    existing = entry["rows"][rk]
                    existing["sources"].add(source_name)
                    if row != existing["data"]:
                        diffs = []
                        max_cols = max(len(row), len(existing["data"]))
                        for ci in range(max_cols):
                            old_val = str(existing["data"][ci]).strip() if ci < len(existing["data"]) else ""
                            new_val = str(row[ci]).strip() if ci < len(row) else ""
                            if old_val != new_val:
                                diffs.append(f"col{ci}: '{old_val}' vs '{new_val}'")
                        if diffs:
                            existing["conflicts"].append({"source": source_name, "diffs": diffs, "row": row})
                        if len(row) > len(existing["data"]):
                            existing["conflicts"][-1]["row"] = existing["data"]
                            existing["data"] = row
            entry["sources"].add(source_name)

    merged_tables = []
    all_warnings = []
    for title, entry in all_rows_by_table.items():
        sorted_rows = sorted(entry["rows"].values(), key=lambda r: r["data"][0] if r["data"] else "")
        final_rows = []
        for rinfo in sorted_rows:
            if rinfo["conflicts"]:
                rid = rinfo["data"][0] if rinfo["data"] else "?"
                for conflict in rinfo["conflicts"]:
                    all_warnings.append(
                        f"CONFLICT on {rid} in '{entry['title']}': {'; '.join(conflict['diffs'])}"
                    )
            final_rows.append(rinfo["data"])

        merged_tables.append({
            "title": entry["title"],
            "headers": entry["headers"],
            "rows": final_rows,
            "raw_text": "",
            "_sources": list(entry["sources"]),
            "_row_count": len(final_rows),
        })

    return {"tables": merged_tables, "warnings": all_warnings}


def merge_results(ocr_data: dict, vision_data: dict) -> dict:
    """Merge OCR + Vision. Vision takes priority; OCR supplements all_text."""
    merged = dict(vision_data)

    vision_text = vision_data.get("all_text") or ""
    ocr_full_text = ocr_data.get("full_text", "")
    if ocr_full_text and len(ocr_full_text) > len(vision_text):
        merged["all_text"] = vision_text + "\n\n[OCR]\n" + ocr_full_text
    else:
        merged["all_text"] = vision_text

    # Append table content to all_text so it's always searchable
    tables = merged.get("tables") or []
    if tables:
        table_lines = []
        for t in tables:
            if t.get("title"):
                table_lines.append(f"\nTable: {t['title']}")
            if t.get("raw_text"):
                table_lines.append(t["raw_text"])
            elif t.get("headers") and t.get("rows"):
                table_lines.append(" | ".join(t["headers"]))
                for row in t["rows"]:
                    table_lines.append(" | ".join(str(v) for v in row))
        if table_lines:
            merged["all_text"] = merged["all_text"] + "\n\n" + "\n".join(table_lines)

    # Merge OCR callouts vision may have missed
    ocr_callouts = ocr_data.get("callouts", [])
    vision_callouts = list(vision_data.get("callouts") or [])
    existing_texts = {c.get("text", "").lower() for c in vision_callouts}
    for t in ocr_callouts:
        if t.lower() not in existing_texts:
            vision_callouts.append({"text": t, "type": "annotation"})
    merged["callouts"] = vision_callouts

    # Ensure title block has confidence key
    tb = merged.get("title_block") or {}
    if isinstance(tb, dict) and "confidence" not in tb:
        tb["confidence"] = 0.5
    merged["title_block"] = tb

    return merged


def process_page(page_num: int, pdf_path: str, client: OpenAI) -> dict:
    """Full pipeline on one page. Loads page image and frees it when done."""

    page = load_single_page(pdf_path, page_num)

    page_ocr = downscale_if_large(page, MAX_OCR_WIDTH)

    tb_text, tb_conf = ocr_region(page_ocr, (0.60, 1.0), (0.78, 1.0))
    if not tb_text.strip():
        tb_text, tb_conf = ocr_region(page_ocr, (0.0, 1.0), (0.85, 1.0))

    rev_text, _ = ocr_region(page_ocr, (0.65, 1.0), (0.0, 0.18))

    full_processed = preprocess_for_ocr(page_ocr)
    full_text, full_conf = ocr_image(full_processed)
    del full_processed

    callout_texts = detect_callout_candidates(page_ocr)
    del page_ocr
    gc.collect()

    ocr_data = {
        "title_block_text": tb_text,
        "revision_text": rev_text,
        "full_text": full_text,
        "ocr_confidence": (tb_conf + full_conf) / 2.0,
        "callouts": callout_texts,
    }

    merged_vision = {
        "title_block": None,
        "revision_history": [],
        "general_notes": [],
        "tables": [],
        "callouts": [],
        "legends": [],
        "all_text": "",
    }

    ocr_text_len = len(full_text.strip())
    if ocr_text_len < MIN_OCR_CHARS_FOR_VISION:
        print(f"  Skipping vision (OCR text only {ocr_text_len} chars)", file=sys.stderr)
        del page
        gc.collect()
    else:
        print(f"  Running vision (full-page)...", file=sys.stderr)
        page_vision = downscale_if_large(page, VISION_MAX_PX)

        merged_vision = vision_extract(client, page_vision)
        del page_vision
        gc.collect()

        full_page_rows = count_table_rows(merged_vision)
        has_table_keywords = bool(re.search(
            r'(?i)(pipe\s*schedule|manhole|inlet|quantity|material\s*schedule|compaction)',
            full_text
        ))
        should_multicrop = (full_page_rows >= TABLE_ROW_THRESHOLD or
                           (has_table_keywords and len(merged_vision.get("tables", [])) > 0))

        if should_multicrop:
            print(f"  Dense table page detected ({full_page_rows} rows). Running multi-crop verification...", file=sys.stderr)

            page_hires = load_single_page(pdf_path, page_num)

            crop_results = []
            for region_name, crop_box in MULTI_CROP_REGIONS:
                try:
                    print(f"    Extracting crop: {region_name}...", file=sys.stderr)
                    crop_data = extract_table_from_crop(client, page_hires, region_name, crop_box)
                    crop_rows = count_table_rows(crop_data)
                    print(f"    {region_name}: {crop_rows} rows from {len(crop_data.get('tables', []))} tables", file=sys.stderr)
                    if crop_rows > 0:
                        crop_results.append((region_name, crop_data))
                except Exception as e:
                    print(f"    {region_name} failed: {e}", file=sys.stderr)

            del page_hires
            gc.collect()

            if crop_results:
                merged = merge_table_extractions(merged_vision, crop_results)
                total_merged_rows = sum(len(t.get("rows", [])) for t in merged["tables"])
                print(f"  Merged tables: {total_merged_rows} rows (was {full_page_rows} from full-page)", file=sys.stderr)

                if merged.get("warnings"):
                    print(f"  ⚠ CROSS-VALIDATION WARNINGS:", file=sys.stderr)
                    for w in merged["warnings"]:
                        print(f"    {w}", file=sys.stderr)

                pipe_warnings = validate_pipe_diameters(merged["tables"])
                if pipe_warnings:
                    print(f"  ⚠ NON-STANDARD PIPE SIZES: {', '.join(pipe_warnings)}", file=sys.stderr)

                gap_warnings = check_sequential_gaps(merged["tables"])
                if gap_warnings:
                    print(f"  ⚠ SEQUENCE GAPS: {'; '.join(gap_warnings)}", file=sys.stderr)

                non_table_data = {k: v for k, v in merged_vision.items() if k != "tables"}
                merged_vision = {**non_table_data, "tables": merged["tables"]}

                all_data_warnings = (merged.get("warnings", []) + pipe_warnings + gap_warnings)
                if all_data_warnings:
                    merged_vision["_data_warnings"] = all_data_warnings
        else:
            pipe_warnings = validate_pipe_diameters(merged_vision.get("tables", []))
            if pipe_warnings:
                print(f"  ⚠ NON-STANDARD PIPE SIZES: {', '.join(pipe_warnings)}", file=sys.stderr)
                merged_vision["_data_warnings"] = pipe_warnings

        del page
        gc.collect()

    if merged_vision["title_block"] is None:
        merged_vision["title_block"] = {k: None for k in ["project_name","drawing_title","sheet_number","revision","date","drawn_by","scale","confidence"]}

    final = merge_results(ocr_data, merged_vision)

    result = {
        "page_number": page_num,
        "extraction_method": "ocr+vision+multicrop" if has_table_content(merged_vision) else "ocr+vision",
        "title_block": final.get("title_block"),
        "revision_history": final.get("revision_history") or [],
        "general_notes": final.get("general_notes") or [],
        "tables": final.get("tables") or [],
        "callouts": final.get("callouts") or [],
        "legends": final.get("legends") or [],
        "all_text": final.get("all_text") or "",
        "ocr_confidence": ocr_data.get("ocr_confidence", 0.0),
    }

    if merged_vision.get("_data_warnings"):
        result["_data_warnings"] = merged_vision["_data_warnings"]

    return result


def main():
    if len(sys.argv) < 4:
        print(json.dumps({"error": "Usage: pdf_processor.py <pdf_path> <ai_base_url> <ai_api_key> [start_page] [end_page] [--stream]"}))
        sys.exit(1)

    pdf_path = sys.argv[1]
    ai_base_url = sys.argv[2]
    ai_api_key = sys.argv[3]

    # Optional: start_page, end_page, --stream flag
    start_page_arg = int(sys.argv[4]) if len(sys.argv) > 4 else 1
    end_page_arg = int(sys.argv[5]) if len(sys.argv) > 5 else None
    streaming = "--stream" in sys.argv

    start_time = time.time()
    client = OpenAI(
        base_url=ai_base_url,
        api_key=ai_api_key,
        timeout=httpx.Timeout(VISION_TIMEOUT, connect=30.0),
    )

    try:
        total_pages = get_page_count(pdf_path)
    except Exception as e:
        print(json.dumps({"error": f"Failed to read PDF: {str(e)}"}))
        sys.exit(1)

    end_page = min(end_page_arg if end_page_arg else total_pages, total_pages)
    pages_to_process = range(start_page_arg, end_page + 1)
    results = []

    for i in pages_to_process:
        try:
            page_result = process_page(i, pdf_path, client)
            gc.collect()
        except Exception as e:
            page_result = {
                "page_number": i,
                "extraction_method": "ocr+vision",
                "title_block": {k: None for k in ["project_name","drawing_title","sheet_number","revision","date","drawn_by","scale","confidence"]},
                "revision_history": [],
                "general_notes": [],
                "callouts": [],
                "legends": [],
                "all_text": "",
                "ocr_confidence": 0.0,
                "error": str(e),
            }

        if streaming:
            # Emit each page immediately so the caller can save progress
            print(json.dumps({"type": "page", "total_pages": total_pages, "page": page_result}), flush=True)
        else:
            results.append(page_result)

    processing_time_ms = int((time.time() - start_time) * 1000)

    if streaming:
        # Final summary line
        print(json.dumps({"type": "done", "total_pages": total_pages, "processing_time_ms": processing_time_ms}), flush=True)
    else:
        print(json.dumps({
            "total_pages": total_pages,
            "processing_time_ms": processing_time_ms,
            "pages": results,
        }))


if __name__ == "__main__":
    main()
