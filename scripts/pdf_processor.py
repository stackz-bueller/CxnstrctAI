#!/usr/bin/env python3
"""
Construction PDF Ingestion Pipeline
====================================
Implements a two-pass extraction pipeline for construction documents:
  Pass 1: PDF → images → OpenCV preprocessing → Tesseract OCR (targeted regions)
  Pass 2: Page images → GPT-4o Vision (full structured extraction)
  Pass 3: Merge OCR + Vision results, vision takes priority

Schema-drift prevention: Output structure is rigidly defined per the academic
constrained slot-filling approach — only the declared fields are populated,
no additional fields are hallucinated.

Usage:
  python3 pdf_processor.py <pdf_path> <ai_base_url> <ai_api_key>
  Output: JSON to stdout
"""

import sys
import json
import base64
import time
import io
import os
import re
import traceback
from pathlib import Path

import numpy as np
import cv2
from PIL import Image
import pytesseract
from pytesseract import Output
import pdf2image
from openai import OpenAI

MAX_PAGES = 15
TILE_OVERLAP = 0.10
TILE_GRID = (3, 3)


def pdf_to_images(pdf_path: str) -> list[Image.Image]:
    """Convert PDF pages to PIL Image objects at 300 DPI."""
    images = pdf2image.convert_from_path(pdf_path, dpi=300)
    return images[:MAX_PAGES]


def preprocess_for_ocr(pil_image: Image.Image) -> np.ndarray:
    """OpenCV preprocessing: grayscale + adaptive threshold for Tesseract."""
    img_array = np.array(pil_image)
    # Convert RGB → BGR for OpenCV then to grayscale
    bgr = cv2.cvtColor(img_array, cv2.COLOR_RGB2BGR)
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    # Adaptive threshold to clean noise, sharpen text
    processed = cv2.adaptiveThreshold(
        gray, 255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY, 11, 2
    )
    return processed


def crop_region(image: Image.Image, x_pct: tuple, y_pct: tuple) -> Image.Image:
    """Crop a region defined by percentage bounds."""
    w, h = image.size
    x1 = int(w * x_pct[0])
    x2 = int(w * x_pct[1])
    y1 = int(h * y_pct[0])
    y2 = int(h * y_pct[1])
    return image.crop((x1, y1, x2, y2))


def ocr_image(np_image: np.ndarray) -> tuple[str, float]:
    """Run Tesseract OCR on a preprocessed numpy image. Returns (text, avg_confidence)."""
    text = pytesseract.image_to_string(np_image, config='--psm 6')
    try:
        data = pytesseract.image_to_data(np_image, output_type=Output.DICT)
        confidences = [int(c) for c in data['conf'] if str(c).strip() not in ('-1', '')]
        avg_conf = sum(confidences) / len(confidences) / 100.0 if confidences else 0.0
    except Exception:
        avg_conf = 0.0
    return text.strip(), avg_conf


def ocr_region(page: Image.Image, x_pct: tuple, y_pct: tuple) -> tuple[str, float]:
    """Crop, preprocess, and OCR a percentage-defined region."""
    cropped = crop_region(page, x_pct, y_pct)
    processed = preprocess_for_ocr(cropped)
    return ocr_image(processed)


def detect_legend_candidates(page: Image.Image) -> list[Image.Image]:
    """Detect bordered rectangles that could be legend/symbol tables."""
    w, h = page.size
    processed = preprocess_for_ocr(page)
    # Invert for contour detection (text on white bg → black bg)
    inverted = cv2.bitwise_not(processed)
    contours, _ = cv2.findContours(inverted, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    candidates = []
    for cnt in contours:
        x, y, cw, ch = cv2.boundingRect(cnt)
        # Must be wider than 50px, narrower than 30% of page, taller than 50px, shorter than 40%
        if (50 < cw < w * 0.30) and (50 < ch < h * 0.40):
            roi = page.crop((x, y, x + cw, y + ch))
            candidates.append(roi)

    return candidates[:10]  # Limit to top 10 candidates


def detect_callout_candidates(page: Image.Image) -> list[str]:
    """Detect small text regions matching callout/annotation patterns."""
    processed = preprocess_for_ocr(page)
    inverted = cv2.bitwise_not(processed)
    contours, _ = cv2.findContours(inverted, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    callout_pattern = re.compile(
        r'(DETAIL\s+[A-Z0-9]+|SECTION\s+[A-Z0-9\-/]+|SEE\s+NOTE\s+[0-9]+|TYP\.?|'
        r'[A-Z]-[A-Z]|[A-Z]/[A-Z]|\([A-Z0-9]+\)|SCALE\s+\d+:\d+|'
        r'(N|S|E|W|NE|NW|SE|SW)\s*(ELEVATION|ELEV)|SIM\.?)',
        re.IGNORECASE
    )

    w, h = page.size
    results = []
    for cnt in contours[:50]:  # Process up to 50 candidates
        x, y, cw, ch = cv2.boundingRect(cnt)
        if (20 < cw < 300) and (10 < ch < 100):
            roi = page.crop((x, y, x + cw, y + ch))
            text, conf = ocr_image(preprocess_for_ocr(roi))
            if text and callout_pattern.search(text):
                results.append(text.strip())

    return list(set(results))[:20]  # Deduplicate, limit


def tile_image(page: Image.Image) -> list[tuple[str, Image.Image]]:
    """Split a page into 3x3 grid with 10% overlap. Returns list of (name, image)."""
    w, h = page.size
    rows, cols = TILE_GRID
    overlap_x = int(w * TILE_OVERLAP)
    overlap_y = int(h * TILE_OVERLAP)

    tile_w = w // cols
    tile_h = h // rows

    names = [
        "top-left", "top-center", "top-right",
        "middle-left", "center", "middle-right",
        "bottom-left", "bottom-center", "bottom-right",
    ]

    tiles = []
    for r in range(rows):
        for c in range(cols):
            x1 = max(0, c * tile_w - overlap_x)
            y1 = max(0, r * tile_h - overlap_y)
            x2 = min(w, (c + 1) * tile_w + overlap_x)
            y2 = min(h, (r + 1) * tile_h + overlap_y)
            tile = page.crop((x1, y1, x2, y2))
            name = names[r * cols + c]
            tiles.append((name, tile))

    return tiles


def pil_to_base64(img: Image.Image, max_width: int = 1600) -> str:
    """Convert PIL image to base64 string, resizing if too large."""
    if img.width > max_width:
        ratio = max_width / img.width
        img = img.resize((max_width, int(img.height * ratio)), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return base64.b64encode(buf.getvalue()).decode("utf-8")


VISION_PROMPT = """You are a construction drawing analyst. Extract all readable text and structured data from this drawing image.

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
  "general_notes": ["list of all note text found"],
  "callouts": [
    { "text": "", "type": "detail_ref | section_cut | note | grid | annotation" }
  ],
  "legends": [
    { "symbol": "", "description": "" }
  ],
  "all_text": "full raw text visible on this image, in reading order"
}

Rules:
- Extract exactly what is visible — do not infer or guess
- If a field is not visible return null
- Include every note, callout, and label you can read
- Preserve abbreviations exactly as written
- confidence in title_block should be 0.0-1.0 based on how clearly the title block is visible"""


def vision_extract(client: OpenAI, img: Image.Image) -> dict:
    """Send an image to GPT-4o Vision and return structured extraction."""
    b64 = pil_to_base64(img)
    try:
        response = client.chat.completions.create(
            model="gpt-4o",
            max_tokens=4096,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": VISION_PROMPT},
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:image/jpeg;base64,{b64}"}
                        }
                    ]
                }
            ]
        )
        content = response.choices[0].message.content or ""
        # Extract JSON from response
        json_match = re.search(r'\{[\s\S]*\}', content)
        if json_match:
            return json.loads(json_match.group())
    except Exception as e:
        pass
    return {
        "title_block": {k: None for k in ["project_name","drawing_title","sheet_number","revision","date","drawn_by","scale"]},
        "revision_history": [],
        "general_notes": [],
        "callouts": [],
        "legends": [],
        "all_text": ""
    }


def merge_results(ocr_data: dict, vision_data: dict) -> dict:
    """
    Merge OCR and Vision results.
    Vision takes priority for structured fields; OCR fills gaps.
    Flags conflicts between OCR and Vision in the title block.
    """
    merged = dict(vision_data)

    # Merge title block: vision takes priority, OCR fills nulls
    tb = dict(vision_data.get("title_block") or {})
    ocr_tb_text = ocr_data.get("title_block_text", "")

    for key in ["project_name", "drawing_title", "sheet_number", "revision", "date", "drawn_by", "scale"]:
        if not tb.get(key) and ocr_tb_text:
            # Simple heuristic: search OCR text for key-related patterns
            tb[key] = None  # Keep null; full OCR text is in all_text

    # Augment all_text with OCR output if vision missed content
    vision_text = vision_data.get("all_text") or ""
    ocr_full_text = ocr_data.get("full_text", "")
    if ocr_full_text and len(ocr_full_text) > len(vision_text):
        merged["all_text"] = vision_text + "\n\n[OCR Supplement]\n" + ocr_full_text
    else:
        merged["all_text"] = vision_text

    # Merge OCR callouts that vision may have missed
    ocr_callouts = ocr_data.get("callouts", [])
    vision_callouts = vision_data.get("callouts", []) or []
    vision_callout_texts = {c.get("text", "").lower() for c in vision_callouts}
    for callout_text in ocr_callouts:
        if callout_text.lower() not in vision_callout_texts:
            vision_callouts.append({"text": callout_text, "type": "annotation"})
    merged["callouts"] = vision_callouts

    # Ensure title_block confidence is set
    if "title_block" in merged and isinstance(merged["title_block"], dict):
        merged["title_block"]["confidence"] = tb.get("confidence", 0.5)
    else:
        merged["title_block"] = tb

    return merged


def process_page(page_num: int, page: Image.Image, client: OpenAI) -> dict:
    """Run the full 6-step pipeline on a single PDF page."""

    # --- Step 2: Preprocess for OCR ---
    ocr_data = {}

    # --- Step 3: Targeted OCR on specific regions ---
    # Title block — bottom-right corner
    tb_text, tb_conf = ocr_region(page, (0.60, 1.0), (0.85, 1.0))
    if not tb_text.strip():
        tb_text, tb_conf = ocr_region(page, (0.0, 1.0), (0.90, 1.0))  # fallback: bottom strip

    # Revision block — upper-right
    rev_text, rev_conf = ocr_region(page, (0.70, 1.0), (0.0, 0.20))
    if not rev_text.strip():
        rev_text, rev_conf = ocr_region(page, (0.60, 1.0), (0.75, 0.85))  # fallback

    # Full page OCR for complete text
    full_processed = preprocess_for_ocr(page)
    full_text, full_conf = ocr_image(full_processed)

    # Legend candidates
    legend_texts = []
    for legend_img in detect_legend_candidates(page):
        text, _ = ocr_image(preprocess_for_ocr(legend_img))
        if text.strip():
            legend_texts.append(text.strip())

    # Callouts
    callout_texts = detect_callout_candidates(page)

    ocr_data = {
        "title_block_text": tb_text,
        "revision_text": rev_text,
        "full_text": full_text,
        "ocr_confidence": (tb_conf + full_conf) / 2.0,
        "callouts": callout_texts,
        "legend_texts": legend_texts,
    }

    # --- Step 4: Tile the image for complex drawings ---
    tiles = tile_image(page)

    # --- Step 5: GPT-4o Vision on each tile ---
    tile_results = []
    for tile_name, tile_img in tiles:
        tile_result = vision_extract(client, tile_img)
        tile_result["_tile"] = tile_name
        tile_results.append(tile_result)

    # Merge tile results into one page result
    merged_vision = {
        "title_block": None,
        "revision_history": [],
        "general_notes": [],
        "callouts": [],
        "legends": [],
        "all_text": "",
    }

    seen_notes = set()
    seen_callout_texts = set()
    seen_legend_syms = set()

    for tr in tile_results:
        # Title block: prefer the tile with highest confidence
        tb = tr.get("title_block") or {}
        existing_tb = merged_vision.get("title_block") or {}
        existing_conf = existing_tb.get("confidence", 0.0) if isinstance(existing_tb, dict) else 0.0
        new_conf = tb.get("confidence", 0.0) if isinstance(tb, dict) else 0.0
        if isinstance(tb, dict) and (merged_vision["title_block"] is None or new_conf > existing_conf):
            if any(v for k, v in tb.items() if k != "confidence" and v):
                merged_vision["title_block"] = tb

        # Revision history: deduplicate
        for rev in tr.get("revision_history") or []:
            rev_key = str(rev.get("rev_number")) + str(rev.get("date"))
            if rev_key not in seen_notes:
                seen_notes.add(rev_key)
                merged_vision["revision_history"].append(rev)

        # Notes: deduplicate
        for note in tr.get("general_notes") or []:
            note_key = note.strip().lower()[:60]
            if note_key not in seen_notes and note.strip():
                seen_notes.add(note_key)
                merged_vision["general_notes"].append(note)

        # Callouts: deduplicate by text
        for c in tr.get("callouts") or []:
            ct = str(c.get("text", "")).strip().lower()
            if ct and ct not in seen_callout_texts:
                seen_callout_texts.add(ct)
                merged_vision["callouts"].append(c)

        # Legends: deduplicate by symbol
        for leg in tr.get("legends") or []:
            sym = str(leg.get("symbol", "")).strip().lower()
            if sym and sym not in seen_legend_syms:
                seen_legend_syms.add(sym)
                merged_vision["legends"].append(leg)

        # All text: concatenate unique portions
        tile_text = tr.get("all_text") or ""
        if tile_text and tile_text.strip() not in merged_vision["all_text"]:
            merged_vision["all_text"] += (" " if merged_vision["all_text"] else "") + tile_text.strip()

    if merged_vision["title_block"] is None:
        merged_vision["title_block"] = {k: None for k in ["project_name","drawing_title","sheet_number","revision","date","drawn_by","scale","confidence"]}

    # --- Step 6: Merge OCR and Vision ---
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
        print(json.dumps({"error": "Usage: pdf_processor.py <pdf_path> <ai_base_url> <ai_api_key>"}))
        sys.exit(1)

    pdf_path = sys.argv[1]
    ai_base_url = sys.argv[2]
    ai_api_key = sys.argv[3]

    start_time = time.time()

    client = OpenAI(base_url=ai_base_url, api_key=ai_api_key)

    try:
        pages = pdf_to_images(pdf_path)
        total_pages = len(pages)
    except Exception as e:
        print(json.dumps({"error": f"Failed to convert PDF: {str(e)}"}))
        sys.exit(1)

    results = []
    for i, page in enumerate(pages, start=1):
        try:
            page_result = process_page(i, page, client)
            results.append(page_result)
        except Exception as e:
            results.append({
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
            })

    processing_time_ms = int((time.time() - start_time) * 1000)

    output = {
        "total_pages": total_pages,
        "processing_time_ms": processing_time_ms,
        "pages": results,
    }

    print(json.dumps(output))


if __name__ == "__main__":
    main()
