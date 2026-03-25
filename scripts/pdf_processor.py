#!/usr/bin/env python3
"""
Construction PDF Ingestion Pipeline — Production Grade
========================================================
Three-pass extraction for construction engineering documents:
  Pass 1: PDF → images @ 300 DPI → OpenCV preprocessing → Tesseract OCR (targeted regions)
  Pass 2: Full-page GPT-4o Vision (high detail) for overview + title block
  Pass 3: 3×3 tiled grid (9 crops, 15% overlap) → GPT-4o Vision per tile for exhaustive detail
  Pass 4: Merge OCR + full-page Vision + all tile Vision results

Every page is ALWAYS processed by all passes. No shortcuts, no thresholds that skip content.
Construction documents contain life-safety critical information — every dimension, annotation,
note, and specification must be captured regardless of how small or graphical the page is.

Memory/performance strategy:
  - Convert ONE page at a time (never all pages at once)
  - 300 DPI for PDF conversion (captures small annotations on large-format drawings)
  - Downscale images to max 2400px wide before Tesseract (speed + memory)
  - 3×3 tile grid (9 tiles per page) with 15% overlap — no boundary content loss
  - Explicit gc.collect() between pages

Usage:
  python3 pdf_processor.py <pdf_path> <ai_base_url> <ai_api_key> [start_page] [end_page] [--stream]
  Output: JSON to stdout (or streaming JSON lines with --stream)
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

MAX_PAGES = 2000
DPI = 300
MAX_OCR_WIDTH = 2400
TILE_GRID = (3, 3)
TILE_OVERLAP = 0.15
VISION_MAX_PX = 2400
VISION_TILE_MAX_PX = 1800
VISION_MAX_TOKENS = 8192
VISION_TILE_MAX_TOKENS = 6144
TABLE_ROW_THRESHOLD = 8
STANDARD_PIPE_SIZES = {4, 6, 8, 10, 12, 15, 18, 21, 24, 27, 30, 36, 42, 48, 54, 60, 72}
JPEG_QUALITY = 92
QUALITY_GATE_MIN_CHARS = 30

TILE_NAMES_3x3 = [
    "top-left", "top-center", "top-right",
    "middle-left", "middle-center", "middle-right",
    "bottom-left", "bottom-center", "bottom-right",
]

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
    images = pdf2image.convert_from_path(
        pdf_path,
        dpi=DPI,
        first_page=page_num,
        last_page=page_num,
        thread_count=1,
    )
    return images[0]


def downscale_if_large(img: Image.Image, max_width: int) -> Image.Image:
    if img.width > max_width:
        ratio = max_width / img.width
        new_h = int(img.height * ratio)
        return img.resize((max_width, new_h), Image.LANCZOS)
    return img


def preprocess_for_ocr(pil_image: Image.Image) -> np.ndarray:
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
    text = pytesseract.image_to_string(np_image, config='--psm 6')
    try:
        data = pytesseract.image_to_data(np_image, output_type=Output.DICT)
        confidences = [int(c) for c in data['conf'] if str(c).strip() not in ('-1', '')]
        avg_conf = sum(confidences) / len(confidences) / 100.0 if confidences else 0.0
    except Exception:
        avg_conf = 0.0
    return text.strip(), avg_conf


def crop_region(image: Image.Image, x_pct: tuple, y_pct: tuple) -> Image.Image:
    w, h = image.size
    x1 = int(w * x_pct[0])
    x2 = int(w * x_pct[1])
    y1 = int(h * y_pct[0])
    y2 = int(h * y_pct[1])
    return image.crop((x1, y1, x2, y2))


def ocr_region(page: Image.Image, x_pct: tuple, y_pct: tuple) -> tuple[str, float]:
    cropped = crop_region(page, x_pct, y_pct)
    cropped = downscale_if_large(cropped, MAX_OCR_WIDTH)
    processed = preprocess_for_ocr(cropped)
    result = ocr_image(processed)
    del cropped, processed
    return result


def detect_callout_candidates(page_small: Image.Image) -> list[str]:
    callout_pattern = re.compile(
        r'(DETAIL\s+[A-Z0-9]+|SECTION\s+[A-Z0-9\-/]+|SEE\s+NOTE\s+[0-9]+|TYP\.?|'
        r'[A-Z]-[A-Z0-9]|[A-Z]/[A-Z0-9]|\([A-Z0-9]+\)|SCALE\s+\d+:\d+|'
        r'(N|S|E|W|NE|NW|SE|SW)\s*(ELEVATION|ELEV)|SIM\.?)',
        re.IGNORECASE
    )
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


def tile_image_3x3(page: Image.Image) -> list[tuple[str, Image.Image]]:
    w, h = page.size
    rows, cols = TILE_GRID
    overlap_x = int(w * TILE_OVERLAP)
    overlap_y = int(h * TILE_OVERLAP)
    tile_w = w // cols
    tile_h = h // rows

    tiles = []
    for r in range(rows):
        for c in range(cols):
            x1 = max(0, c * tile_w - overlap_x)
            y1 = max(0, r * tile_h - overlap_y)
            x2 = min(w, (c + 1) * tile_w + overlap_x)
            y2 = min(h, (r + 1) * tile_h + overlap_y)
            name = TILE_NAMES_3x3[r * cols + c]
            tiles.append((name, page.crop((x1, y1, x2, y2))))

    return tiles


def pil_to_base64(img: Image.Image, max_width: int = VISION_MAX_PX) -> str:
    img = downscale_if_large(img, max_width)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=JPEG_QUALITY)
    return base64.b64encode(buf.getvalue()).decode("utf-8")


VISION_PROMPT_FULLPAGE = """You are a construction drawing analyst. Extract ALL readable text and structured data from this FULL PAGE of an engineering drawing. Be absolutely exhaustive — every dimension, annotation, note, specification, and label matters. Lives and millions of dollars depend on accuracy.

Return JSON with exactly this structure:
{
  "voided": false,
  "voided_reason": null,
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
    { "text": "", "type": "detail_ref | section_cut | note | grid | annotation | dimension" }
  ],
  "legends": [
    { "symbol": "", "description": "" }
  ],
  "all_text": "ALL visible text in reading order — include complete table contents, every note in full, all dimensions, all specifications, all annotations no matter how small"
}

Rules:
- VOIDED PAGE DETECTION IS CRITICAL: If the page has a large "X" drawn across it, or is crossed out, or has "VOID", "DELETED", "REMOVED", "SUPERSEDED", or "NOT USED" stamped on it, set "voided": true and "voided_reason" to a description. Still extract all readable text even from voided pages.
- On cover sheets or drawing index pages, look for X marks or strikethrough on individual sheet listings — note which sheets are marked as removed in the general_notes array
- Extract EVERY piece of visible text — do not summarize, abbreviate, or skip anything
- DIMENSIONS ARE CRITICAL: Read every dimension line, every "MIN", "MAX", "TYP" annotation, every thickness callout, every clearance, every elevation. Examples: '2-1/2" MIN.', '1-1/2" THICK', '3/4" GAP', '#5 @ 12" O.C.'
- TABLES ARE CRITICAL: Extract ALL tables completely — every row, column header, and cell value
- NUMERICAL ACCURACY IS CRITICAL: Read each number carefully. Pipe diameters are typically 12", 15", 18", 24", 30", 36", 42", 48"
- Include all references to standards (PennDOT, ASTM, AASHTO, ACI, etc.)
- confidence: 0.0-1.0 based on how clearly title block info is present
- Return null for title_block fields not visible; return empty arrays for missing lists"""


VISION_PROMPT_TILE = """You are a construction drawing analyst examining one SECTION of a larger engineering drawing. Extract EVERY piece of text, dimension, annotation, specification, and label visible in this section. Be absolutely exhaustive — no detail is too small to capture. Lives and millions of dollars depend on accuracy.

Return JSON:
{
  "general_notes": ["full text of any notes visible"],
  "tables": [
    {
      "title": "table heading",
      "headers": ["col1", "col2"],
      "rows": [["val1", "val2"]],
      "raw_text": "full table rendered as plain text"
    }
  ],
  "callouts": [
    { "text": "", "type": "detail_ref | section_cut | note | grid | annotation | dimension" }
  ],
  "legends": [
    { "symbol": "", "description": "" }
  ],
  "all_text": "ALL visible text — every dimension, annotation, label, specification, material callout, elevation, and note. Include fractional dimensions like 2-1/2\\", thickness callouts like 1-1/2\\" THICK, minimum/maximum specs, clearances, and structural details."
}

CRITICAL RULES:
- Extract EVERY piece of text no matter how small
- DIMENSIONS: Read every dimension annotation: '2-1/2" MIN.', '1-1/2" THICK WALL', '3/4" CLEAR', '#5 @ 12" O.C.', 'EL. 188.17', etc.
- MATERIALS: Capture all material specs: 'CLASS A (3000 PSI)', 'ASTM A36', 'R-3 RIP RAP', 'NO. 57 STONE', etc.
- TABLES: Extract ALL rows completely. Never truncate.
- NUMERICAL ACCURACY: Read each number carefully. Double-check against the image.
- Include all references to standards with full section numbers
- If text is partially visible at the edge of this section, include what you can read"""


VISION_TIMEOUT = 120
VISION_MAX_RETRIES = 3
VISION_RETRY_DELAY = 5

def vision_extract_fullpage(client: OpenAI, img: Image.Image) -> dict:
    b64 = pil_to_base64(img, max_width=VISION_MAX_PX)
    empty = {
        "voided": False,
        "voided_reason": None,
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
                        {"type": "text", "text": VISION_PROMPT_FULLPAGE},
                        {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}", "detail": "high"}}
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
            print(f"Vision full-page error (attempt {attempt}/{VISION_MAX_RETRIES}): {e}", file=sys.stderr)
            if attempt < VISION_MAX_RETRIES:
                time.sleep(VISION_RETRY_DELAY * attempt)
    return empty


PE_SEAL_CROP_BOXES = [
    (0.70, 0.10, 1.0, 0.60),
    (0.70, 0.55, 1.0, 0.85),
    (0.0, 0.80, 0.40, 1.0),
]

PE_SEAL_PROMPT = """You are a construction document analyst. This image shows the RIGHT EDGE of a construction drawing page.
Look carefully for Professional Engineer (PE) seals/stamps. These are typically circular or rectangular stamps containing:
- A Professional Engineer's name
- A PE license/registration number (format varies: PE012345, PE012345E, etc.)
- The state of registration (e.g., "Commonwealth of Pennsylvania")
- An expiration date
- Sometimes a signature

Also look for Licensed Surveyor (LS/SU) seals with similar information.

Return a JSON object:
{
  "pe_stamps": [
    {
      "name": "Full Name As Written",
      "license_number": "PE012345",
      "state": "Pennsylvania",
      "expiration": "09/30/2025",
      "discipline": "Structural/Civil/Electrical/Surveyor/etc",
      "firm": "Company Name if visible"
    }
  ],
  "firm_info": {
    "name": "Firm name if visible",
    "address": "Address if visible",
    "phone": "Phone if visible"
  }
}

If NO PE seals are found, return: {"pe_stamps": [], "firm_info": null}
Be THOROUGH — PE stamps may be faint, small, or partially obscured. Read every character carefully.
License numbers are critical — do not guess. If unclear, use "?" for uncertain characters."""


def _extract_pe_from_crop(client: OpenAI, page: Image.Image, crop_box: tuple) -> dict:
    w, h = page.size
    left = int(w * crop_box[0])
    top = int(h * crop_box[1])
    right = int(w * crop_box[2])
    bottom = int(h * crop_box[3])
    crop = page.crop((left, top, right, bottom))

    b64 = pil_to_base64(crop, max_width=1600)
    del crop

    empty = {"pe_stamps": [], "firm_info": None}
    for attempt in range(1, VISION_MAX_RETRIES + 1):
        try:
            response = client.chat.completions.create(
                model="gpt-4o",
                max_tokens=2048,
                messages=[{
                    "role": "user",
                    "content": [
                        {"type": "text", "text": PE_SEAL_PROMPT},
                        {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}", "detail": "high"}}
                    ]
                }]
            )
            content = response.choices[0].message.content or ""
            json_match = re.search(r'\{[\s\S]*\}', content)
            if json_match:
                result = json.loads(json_match.group())
                if "pe_stamps" not in result:
                    result["pe_stamps"] = []
                return result
        except Exception as e:
            print(f"Vision PE seal error (attempt {attempt}/{VISION_MAX_RETRIES}): {e}", file=sys.stderr)
            if attempt < VISION_MAX_RETRIES:
                time.sleep(VISION_RETRY_DELAY * attempt)
    return empty


def vision_extract_pe_stamp(client: OpenAI, page: Image.Image) -> dict:
    all_stamps = []
    best_firm = None
    seen_names = set()

    for crop_box in PE_SEAL_CROP_BOXES:
        result = _extract_pe_from_crop(client, page, crop_box)
        for stamp in result.get("pe_stamps", []):
            name = (stamp.get("name") or "").strip().upper()
            if name and name not in seen_names:
                seen_names.add(name)
                all_stamps.append(stamp)
        fi = result.get("firm_info")
        if fi and fi.get("name") and not best_firm:
            best_firm = fi

    return {"pe_stamps": all_stamps, "firm_info": best_firm}


def format_pe_stamps_text(pe_data: dict) -> str:
    stamps = pe_data.get("pe_stamps", [])
    if not stamps:
        return ""
    lines = ["\n--- PROFESSIONAL ENGINEER SEALS/STAMPS ---"]
    for s in stamps:
        name = s.get("name", "Unknown")
        lic = s.get("license_number", "")
        state = s.get("state", "")
        exp = s.get("expiration", "")
        disc = s.get("discipline", "")
        firm = s.get("firm", "")
        parts = [f"PE: {name}"]
        if lic:
            parts.append(f"License No. {lic}")
        if state:
            parts.append(f"State: {state}")
        if exp:
            parts.append(f"Exp: {exp}")
        if disc:
            parts.append(f"Discipline: {disc}")
        if firm:
            parts.append(f"Firm: {firm}")
        lines.append(" | ".join(parts))

    firm_info = pe_data.get("firm_info")
    if firm_info and firm_info.get("name"):
        fi_parts = [f"Engineering Firm: {firm_info['name']}"]
        if firm_info.get("address"):
            fi_parts.append(firm_info["address"])
        if firm_info.get("phone"):
            fi_parts.append(firm_info["phone"])
        lines.append(" | ".join(fi_parts))

    lines.append("--- END PE SEALS ---")
    return "\n".join(lines)


def vision_extract_tile(client: OpenAI, img: Image.Image, tile_name: str) -> dict:
    b64 = pil_to_base64(img, max_width=VISION_TILE_MAX_PX)
    empty = {"general_notes": [], "tables": [], "callouts": [], "legends": [], "all_text": ""}
    for attempt in range(1, VISION_MAX_RETRIES + 1):
        try:
            response = client.chat.completions.create(
                model="gpt-4o",
                max_tokens=VISION_TILE_MAX_TOKENS,
                messages=[{
                    "role": "user",
                    "content": [
                        {"type": "text", "text": VISION_PROMPT_TILE},
                        {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}", "detail": "high"}}
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
            print(f"Vision tile '{tile_name}' error (attempt {attempt}/{VISION_MAX_RETRIES}): {e}", file=sys.stderr)
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
            max_tokens=VISION_TILE_MAX_TOKENS,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}", "detail": "high"}}
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
        for ti, table in enumerate(data.get("tables", [])):
            raw_title = (table.get("title") or "").strip()
            title = normalize_title(raw_title) if raw_title else f"__UNTITLED_{source_name}_{ti}"
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


def deduplicate_lines(text: str) -> str:
    seen = set()
    result = []
    for line in text.split('\n'):
        stripped = line.strip()
        if not stripped:
            result.append(line)
            continue
        normalized = re.sub(r'\s+', ' ', stripped.lower())
        if normalized not in seen:
            seen.add(normalized)
            result.append(line)
    return '\n'.join(result)


def merge_all_text_sources(fullpage_text: str, tile_texts: list[str], ocr_text: str) -> str:
    seen_normalized = set()
    all_lines = []

    def add_lines(text: str):
        for line in text.split('\n'):
            stripped = line.strip()
            if not stripped:
                continue
            normalized = re.sub(r'\s+', ' ', stripped.lower())
            if normalized not in seen_normalized:
                seen_normalized.add(normalized)
                all_lines.append(stripped)

    add_lines(fullpage_text)
    for tile_text in tile_texts:
        add_lines(tile_text)
    if ocr_text:
        ocr_unique = []
        for line in ocr_text.split('\n'):
            stripped = line.strip()
            if not stripped:
                continue
            normalized = re.sub(r'\s+', ' ', stripped.lower())
            if normalized not in seen_normalized:
                seen_normalized.add(normalized)
                ocr_unique.append(stripped)
        if ocr_unique:
            all_lines.append("\n[OCR]")
            all_lines.extend(ocr_unique)

    return '\n'.join(all_lines)


def merge_callouts(fullpage_callouts: list, tile_callouts: list[list]) -> list:
    seen = set()
    result = []
    for callout in fullpage_callouts:
        text = callout.get("text", "").strip().lower()
        if text and text not in seen:
            seen.add(text)
            result.append(callout)
    for tile_list in tile_callouts:
        for callout in tile_list:
            text = callout.get("text", "").strip().lower()
            if text and text not in seen:
                seen.add(text)
                result.append(callout)
    return result


def merge_notes(fullpage_notes: list, tile_notes: list[list]) -> list:
    seen = set()
    result = []
    for note in fullpage_notes:
        normalized = re.sub(r'\s+', ' ', note.strip().lower())
        if normalized and normalized not in seen:
            seen.add(normalized)
            result.append(note)
    for tile_list in tile_notes:
        for note in tile_list:
            normalized = re.sub(r'\s+', ' ', note.strip().lower())
            if normalized and normalized not in seen:
                seen.add(normalized)
                result.append(note)
    return result


def merge_legends(fullpage_legends: list, tile_legends: list[list]) -> list:
    seen = set()
    result = []
    for legend in fullpage_legends:
        desc = legend.get("description", "").strip().lower()
        if desc and desc not in seen:
            seen.add(desc)
            result.append(legend)
    for tile_list in tile_legends:
        for legend in tile_list:
            desc = legend.get("description", "").strip().lower()
            if desc and desc not in seen:
                seen.add(desc)
                result.append(legend)
    return result


def merge_results(ocr_data: dict, fullpage_vision: dict, tile_results: list[dict]) -> dict:
    merged = dict(fullpage_vision)

    if "voided" not in merged:
        merged["voided"] = False
    if "voided_reason" not in merged:
        merged["voided_reason"] = None

    fullpage_text = fullpage_vision.get("all_text") or ""
    tile_texts = [t.get("all_text", "") for t in tile_results]
    ocr_full_text = ocr_data.get("full_text", "")

    merged["all_text"] = merge_all_text_sources(fullpage_text, tile_texts, ocr_full_text)

    all_tables_sources = [("full_page", fullpage_vision)]
    for i, tile_data in enumerate(tile_results):
        tile_name = TILE_NAMES_3x3[i] if i < len(TILE_NAMES_3x3) else f"tile_{i}"
        all_tables_sources.append((tile_name, tile_data))

    if any(len(src.get("tables", [])) > 0 for _, src in all_tables_sources):
        table_merge = merge_table_extractions(fullpage_vision, [(n, d) for n, d in all_tables_sources[1:]])
        merged["tables"] = table_merge["tables"]
        if table_merge.get("warnings"):
            merged["_data_warnings"] = table_merge["warnings"]
    else:
        merged["tables"] = fullpage_vision.get("tables") or []

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

    tile_callouts = [t.get("callouts", []) for t in tile_results]
    merged["callouts"] = merge_callouts(
        list(fullpage_vision.get("callouts") or []),
        tile_callouts
    )
    ocr_callouts = ocr_data.get("callouts", [])
    existing_texts = {c.get("text", "").lower() for c in merged["callouts"]}
    for t in ocr_callouts:
        if t.lower() not in existing_texts:
            merged["callouts"].append({"text": t, "type": "annotation"})

    tile_notes = [t.get("general_notes", []) for t in tile_results]
    merged["general_notes"] = merge_notes(
        list(fullpage_vision.get("general_notes") or []),
        tile_notes
    )

    tile_legends = [t.get("legends", []) for t in tile_results]
    merged["legends"] = merge_legends(
        list(fullpage_vision.get("legends") or []),
        tile_legends
    )

    tb = merged.get("title_block") or {}
    if isinstance(tb, dict) and "confidence" not in tb:
        tb["confidence"] = 0.5
    merged["title_block"] = tb

    return merged


def process_page(page_num: int, pdf_path: str, client: OpenAI) -> dict:
    page = load_single_page(pdf_path, page_num)
    w, h = page.size
    print(f"  Page {page_num}: {w}x{h}px @ {DPI} DPI", file=sys.stderr)

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

    print(f"  Running full-page vision...", file=sys.stderr)
    page_fullpage = downscale_if_large(page, VISION_MAX_PX)
    fullpage_vision = vision_extract_fullpage(client, page_fullpage)
    del page_fullpage
    gc.collect()

    fullpage_text_len = len((fullpage_vision.get("all_text") or "").strip())
    print(f"  Full-page vision: {fullpage_text_len} chars, {count_table_rows(fullpage_vision)} table rows", file=sys.stderr)

    print(f"  Running PE seal extraction (right-edge crop)...", file=sys.stderr)
    pe_seal_data = vision_extract_pe_stamp(client, page)
    pe_stamp_count = len(pe_seal_data.get("pe_stamps", []))
    if pe_stamp_count > 0:
        stamp_names = [s.get("name", "?") for s in pe_seal_data["pe_stamps"]]
        print(f"  PE seals found: {', '.join(stamp_names)}", file=sys.stderr)
    else:
        print(f"  No PE seals detected on this page", file=sys.stderr)

    print(f"  Running 3x3 tiled vision (9 tiles, 15% overlap)...", file=sys.stderr)
    tiles = tile_image_3x3(page)
    tile_results = []
    for tile_name, tile_img in tiles:
        print(f"    Tile {tile_name} ({tile_img.size[0]}x{tile_img.size[1]})...", file=sys.stderr)
        tile_data = vision_extract_tile(client, tile_img, tile_name)
        tile_text_len = len((tile_data.get("all_text") or "").strip())
        tile_tables = count_table_rows(tile_data)
        print(f"    Tile {tile_name}: {tile_text_len} chars, {tile_tables} table rows", file=sys.stderr)
        tile_results.append(tile_data)
        del tile_img
    del tiles
    gc.collect()

    total_tile_chars = sum(len((t.get("all_text") or "").strip()) for t in tile_results)
    print(f"  Tile totals: {total_tile_chars} chars across 9 tiles", file=sys.stderr)

    has_significant_tables = any(
        count_table_rows(t) >= TABLE_ROW_THRESHOLD
        for t in [fullpage_vision] + tile_results
    )
    if has_significant_tables:
        print(f"  Dense tables detected — running 4-region table verification...", file=sys.stderr)
        page_hires = load_single_page(pdf_path, page_num)
        crop_results = []
        for region_name, crop_box in MULTI_CROP_REGIONS:
            try:
                print(f"    Table crop {region_name}...", file=sys.stderr)
                crop_data = extract_table_from_crop(client, page_hires, region_name, crop_box)
                crop_rows = count_table_rows(crop_data)
                if crop_rows > 0:
                    print(f"    {region_name}: {crop_rows} rows", file=sys.stderr)
                    crop_results.append((region_name, crop_data))
            except Exception as e:
                print(f"    {region_name} failed: {e}", file=sys.stderr)
        del page_hires
        gc.collect()

        for crop_name, crop_data in crop_results:
            tile_results.append(crop_data)

    del page
    gc.collect()

    final = merge_results(ocr_data, fullpage_vision, tile_results)

    pe_text = format_pe_stamps_text(pe_seal_data)
    if pe_text:
        final["all_text"] = final.get("all_text", "") + "\n" + pe_text
    final["pe_stamps"] = pe_seal_data.get("pe_stamps", [])
    final["firm_info"] = pe_seal_data.get("firm_info")

    if final.get("title_block") is None:
        final["title_block"] = {k: None for k in ["project_name","drawing_title","sheet_number","revision","date","drawn_by","scale","confidence"]}

    final_text_len = len((final.get("all_text") or "").strip())
    is_voided = bool(final.get("voided", False))
    if final_text_len < QUALITY_GATE_MIN_CHARS and not is_voided:
        print(f"  ⚠ QUALITY GATE: Only {final_text_len} chars extracted from non-voided page {page_num}. May need manual review.", file=sys.stderr)

    pipe_warnings = validate_pipe_diameters(final.get("tables") or [])
    gap_warnings = check_sequential_gaps(final.get("tables") or [])
    all_data_warnings = list(final.get("_data_warnings", [])) + pipe_warnings + gap_warnings
    if pipe_warnings:
        print(f"  ⚠ NON-STANDARD PIPE SIZES: {', '.join(pipe_warnings)}", file=sys.stderr)
    if gap_warnings:
        print(f"  ⚠ SEQUENCE GAPS: {'; '.join(gap_warnings)}", file=sys.stderr)

    extraction_method = "ocr+vision_fullpage+pe_seal+vision_3x3"
    if has_significant_tables:
        extraction_method += "+table_verification"

    result = {
        "page_number": page_num,
        "extraction_method": extraction_method,
        "title_block": final.get("title_block"),
        "revision_history": final.get("revision_history") or [],
        "general_notes": final.get("general_notes") or [],
        "tables": final.get("tables") or [],
        "callouts": final.get("callouts") or [],
        "legends": final.get("legends") or [],
        "pe_stamps": final.get("pe_stamps") or [],
        "firm_info": final.get("firm_info"),
        "all_text": final.get("all_text") or "",
        "ocr_confidence": ocr_data.get("ocr_confidence", 0.0),
        "voided": is_voided,
        "voided_reason": final.get("voided_reason"),
    }

    if all_data_warnings:
        result["_data_warnings"] = all_data_warnings

    print(f"  ✓ Page {page_num} complete: {final_text_len} chars, {len(final.get('callouts', []))} callouts, {count_table_rows(final)} table rows", file=sys.stderr)
    return result


def main():
    if len(sys.argv) < 4:
        print(json.dumps({"error": "Usage: pdf_processor.py <pdf_path> <ai_base_url> <ai_api_key> [start_page] [end_page] [--stream]"}))
        sys.exit(1)

    pdf_path = sys.argv[1]
    ai_base_url = sys.argv[2]
    ai_api_key = sys.argv[3]

    start_page_arg = int(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4] != "--stream" else 1
    end_page_arg = int(sys.argv[5]) if len(sys.argv) > 5 and sys.argv[5] != "--stream" else None
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

    print(f"Processing {len(pages_to_process)} pages at {DPI} DPI with {TILE_GRID[0]}x{TILE_GRID[1]} tiling ({TILE_OVERLAP*100:.0f}% overlap)...", file=sys.stderr)

    for i in pages_to_process:
        print(f"\n--- Page {i}/{end_page} ---", file=sys.stderr)
        try:
            page_result = process_page(i, pdf_path, client)
            gc.collect()
        except Exception as e:
            print(f"  ✗ Page {i} FAILED: {e}", file=sys.stderr)
            page_result = {
                "page_number": i,
                "extraction_method": "ocr+vision_fullpage+vision_3x3",
                "title_block": {k: None for k in ["project_name","drawing_title","sheet_number","revision","date","drawn_by","scale","confidence"]},
                "revision_history": [],
                "general_notes": [],
                "tables": [],
                "callouts": [],
                "legends": [],
                "all_text": "",
                "ocr_confidence": 0.0,
                "voided": False,
                "voided_reason": None,
                "error": str(e),
            }

        if streaming:
            print(json.dumps({"type": "page", "total_pages": total_pages, "page": page_result}), flush=True)
        else:
            results.append(page_result)

    processing_time_ms = int((time.time() - start_time) * 1000)
    elapsed_min = processing_time_ms / 60000
    print(f"\n=== Completed {len(pages_to_process)} pages in {elapsed_min:.1f} minutes ===", file=sys.stderr)

    if streaming:
        print(json.dumps({"type": "done", "total_pages": total_pages, "processing_time_ms": processing_time_ms}), flush=True)
    else:
        print(json.dumps({
            "total_pages": total_pages,
            "processing_time_ms": processing_time_ms,
            "pages": results,
        }))


if __name__ == "__main__":
    main()
