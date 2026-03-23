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

import numpy as np
import cv2
from PIL import Image
import pytesseract
from pytesseract import Output
import pdf2image
from openai import OpenAI

MAX_PAGES = 150          # Process up to 150 pages — covers most full drawing sets
DPI = 100                # 100 DPI — enough for large-format engineering drawings
MAX_OCR_WIDTH = 1600     # Downscale images wider than this before Tesseract
TILE_GRID = (2, 2)       # 2×2 = 4 tiles per page
TILE_OVERLAP = 0.08      # 8% overlap between tiles
VISION_MAX_PX = 1200     # Max width for vision images sent to GPT-4o


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


VISION_PROMPT = """You are a construction drawing analyst. Extract all readable text and structured data from this section of an engineering drawing.

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
  "general_notes": ["list of note text"],
  "callouts": [
    { "text": "", "type": "detail_ref | section_cut | note | grid | annotation" }
  ],
  "legends": [
    { "symbol": "", "description": "" }
  ],
  "all_text": "all visible text in reading order"
}

Rules:
- Extract exactly what is visible — do not infer or guess
- Return null for title_block fields not visible; return empty arrays for missing lists
- Include every note, callout, and label you can read
- confidence: 0.0-1.0 based on how clearly title block info is present"""


def vision_extract(client: OpenAI, img: Image.Image) -> dict:
    """Send an image tile to GPT-4o Vision and return structured JSON."""
    b64 = pil_to_base64(img)
    empty = {
        "title_block": {k: None for k in ["project_name","drawing_title","sheet_number","revision","date","drawn_by","scale","confidence"]},
        "revision_history": [],
        "general_notes": [],
        "callouts": [],
        "legends": [],
        "all_text": ""
    }
    try:
        response = client.chat.completions.create(
            model="gpt-4o",
            max_tokens=2048,
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
            return json.loads(json_match.group())
    except Exception:
        pass
    return empty


def merge_results(ocr_data: dict, vision_data: dict) -> dict:
    """Merge OCR + Vision. Vision takes priority; OCR supplements all_text."""
    merged = dict(vision_data)

    vision_text = vision_data.get("all_text") or ""
    ocr_full_text = ocr_data.get("full_text", "")
    if ocr_full_text and len(ocr_full_text) > len(vision_text):
        merged["all_text"] = vision_text + "\n\n[OCR]\n" + ocr_full_text
    else:
        merged["all_text"] = vision_text

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

    # Downscale for OCR (Tesseract is slow on 5000+ px images)
    page_ocr = downscale_if_large(page, MAX_OCR_WIDTH)

    # --- OCR: targeted regions ---
    # Title block: bottom-right (most common on engineering drawings)
    tb_text, tb_conf = ocr_region(page_ocr, (0.60, 1.0), (0.78, 1.0))
    if not tb_text.strip():
        # Fallback: bottom strip
        tb_text, tb_conf = ocr_region(page_ocr, (0.0, 1.0), (0.85, 1.0))

    # Revision block: right side, upper portion
    rev_text, _ = ocr_region(page_ocr, (0.65, 1.0), (0.0, 0.18))

    # Full page OCR
    full_processed = preprocess_for_ocr(page_ocr)
    full_text, full_conf = ocr_image(full_processed)
    del full_processed

    # Callouts
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

    # --- Vision: 2×2 tiles ---
    # Use a slightly larger version for vision since it goes to GPT-4o
    page_vision = downscale_if_large(page, 2400)
    del page
    tiles = tile_image(page_vision)
    del page_vision
    gc.collect()

    merged_vision = {
        "title_block": None,
        "revision_history": [],
        "general_notes": [],
        "callouts": [],
        "legends": [],
        "all_text": "",
    }

    seen_notes: set[str] = set()
    seen_callout_texts: set[str] = set()
    seen_legend_syms: set[str] = set()

    for _, tile_img in tiles:
        tr = vision_extract(client, tile_img)
        del tile_img
        gc.collect()

        # Title block: prefer highest confidence tile
        tb = tr.get("title_block") or {}
        existing_tb = merged_vision.get("title_block") or {}
        existing_conf = existing_tb.get("confidence", 0.0) if isinstance(existing_tb, dict) else 0.0
        new_conf = tb.get("confidence", 0.0) if isinstance(tb, dict) else 0.0
        if isinstance(tb, dict) and (merged_vision["title_block"] is None or new_conf > existing_conf):
            if any(v for k, v in tb.items() if k != "confidence" and v):
                merged_vision["title_block"] = tb

        for rev in tr.get("revision_history") or []:
            key = str(rev.get("rev_number")) + str(rev.get("date"))
            if key not in seen_notes:
                seen_notes.add(key)
                merged_vision["revision_history"].append(rev)

        for note in tr.get("general_notes") or []:
            nk = note.strip().lower()[:60]
            if nk not in seen_notes and note.strip():
                seen_notes.add(nk)
                merged_vision["general_notes"].append(note)

        for c in tr.get("callouts") or []:
            ct = str(c.get("text", "")).strip().lower()
            if ct and ct not in seen_callout_texts:
                seen_callout_texts.add(ct)
                merged_vision["callouts"].append(c)

        for leg in tr.get("legends") or []:
            sym = str(leg.get("symbol", "")).strip().lower()
            if sym and sym not in seen_legend_syms:
                seen_legend_syms.add(sym)
                merged_vision["legends"].append(leg)

        tile_text = tr.get("all_text") or ""
        if tile_text.strip() and tile_text.strip() not in merged_vision["all_text"]:
            merged_vision["all_text"] += (" " if merged_vision["all_text"] else "") + tile_text.strip()

    if merged_vision["title_block"] is None:
        merged_vision["title_block"] = {k: None for k in ["project_name","drawing_title","sheet_number","revision","date","drawn_by","scale","confidence"]}

    final = merge_results(ocr_data, merged_vision)

    return {
        "page_number": page_num,
        "extraction_method": "ocr+vision",
        "title_block": final.get("title_block"),
        "revision_history": final.get("revision_history") or [],
        "general_notes": final.get("general_notes") or [],
        "callouts": final.get("callouts") or [],
        "legends": final.get("legends") or [],
        "all_text": final.get("all_text") or "",
        "ocr_confidence": ocr_data.get("ocr_confidence", 0.0),
    }


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
    client = OpenAI(base_url=ai_base_url, api_key=ai_api_key)

    try:
        total_pages = get_page_count(pdf_path)
    except Exception as e:
        print(json.dumps({"error": f"Failed to read PDF: {str(e)}"}))
        sys.exit(1)

    end_page = min(end_page_arg if end_page_arg else total_pages, MAX_PAGES, total_pages)
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
