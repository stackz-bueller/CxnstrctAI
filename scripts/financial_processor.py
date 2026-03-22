#!/usr/bin/env python3
"""
Financial Document Processor
==============================
Handles change orders, supplier invoices, receipts, and related
construction finance documents.

Two modes:
  TEXT mode  — pdfplumber extracts readable text → GPT-4o structures it
  VISION mode — pdf2image converts pages → GPT-4o vision reads images

Mode is chosen automatically based on text density of the first page.

Usage:
  python3 financial_processor.py <pdf_path> <ai_base_url> <ai_api_key>
  Output: JSON to stdout
"""

import sys
import json
import re
import time
import base64
import gc
from io import BytesIO
from openai import OpenAI
import pdfplumber

# Try to import pdf2image; only needed for image-based PDFs
try:
    from pdf2image import convert_from_path
    HAS_PDF2IMAGE = True
except ImportError:
    HAS_PDF2IMAGE = False

MIN_CHARS_FOR_TEXT_MODE = 100   # below this → vision mode
MAX_PAGES = 25                   # max pages to process
VISION_DPI = 150                 # DPI for converting PDF pages to images
VISION_MAX_PX = 1600             # max image dimension for vision

# ── Document type patterns ────────────────────────────────────────────────────
CHANGE_ORDER_PATTERN = re.compile(
    r'(CHANGE ORDER|POTENTIAL CHANGE ORDER|PCO|PROPOSAL FORM|SCOPE OF WORK)',
    re.IGNORECASE
)
INVOICE_PATTERN = re.compile(
    r'(INVOICE NUMBER|INVOICE DATE|INVOICE NO|INVOICE #)',
    re.IGNORECASE
)
RECEIPT_PATTERN = re.compile(
    r'(RECEIPT|CASH RECEIPT|SALES RECEIPT)',
    re.IGNORECASE
)

# ── Prompts ───────────────────────────────────────────────────────────────────
TEXT_EXTRACTION_PROMPT = """You are a construction finance document analyst.
Extract ALL structured data from this financial document text.

Identify the document type and return JSON with this structure:
{
  "type": "change_order" | "invoice" | "receipt" | "other",
  "fields": {
    // All key header fields: project_name, document_number, date, vendor, customer,
    // contractor, po_number, terms, etc. — whatever is present
  },
  "line_items": [
    {
      "description": "...",
      "quantity": "...",
      "unit": "...",
      "unit_price": "...",
      "extension": "...",
      "trade": null,
      "hours": null,
      "rate": null,
      "part_number": null
    }
  ],
  "totals": {
    // All financial totals: subtotal, overhead, profit, markup, tax, total, etc.
  }
}

For change orders: capture the full breakdown including labor, material, equipment sections
with overhead/profit/markup per section.
For invoices: capture each line item with part numbers, quantities, prices.
Be precise with dollar amounts — copy them exactly from the source text."""

VISION_EXTRACTION_PROMPT = """You are a construction finance document analyst.
This is an image of a financial document page. Extract ALL structured data.

Identify the document type and return JSON with this structure:
{
  "type": "change_order" | "invoice" | "receipt" | "other",
  "fields": {
    // All header fields present: invoice_number, date, vendor, customer,
    // project, po_number, terms, account, order_number, etc.
  },
  "line_items": [
    {
      "description": "item description",
      "quantity": "qty shipped or ordered",
      "unit": "EA/LB/etc",
      "unit_price": "price per unit",
      "extension": "extended price",
      "trade": null,
      "hours": null,
      "rate": null,
      "part_number": "part number if shown"
    }
  ],
  "totals": {
    // All totals shown: subtotal, tax, shipping, total_invoice, etc.
  }
}

Be precise with part numbers and dollar amounts — copy exactly from the image."""


# ── Text mode extraction ──────────────────────────────────────────────────────

def extract_text_pages(pdf_path: str) -> list[dict]:
    pages = []
    with pdfplumber.open(pdf_path) as pdf:
        for i, page in enumerate(pdf.pages[:MAX_PAGES], start=1):
            text = page.extract_text(x_tolerance=2, y_tolerance=2) or ""
            pages.append({"page": i, "text": text.strip()})
    return pages


def detect_doc_type_from_text(text: str) -> str:
    if CHANGE_ORDER_PATTERN.search(text):
        return "change_order"
    if INVOICE_PATTERN.search(text):
        return "invoice"
    if RECEIPT_PATTERN.search(text):
        return "receipt"
    return "other"


def split_into_documents_text(pages: list[dict]) -> list[dict]:
    """
    Split multi-page PDFs into individual documents.
    Heuristic: each new invoice starts on a page where INVOICE_PATTERN appears
    near the top (first 300 chars) and the previous page ended.
    """
    if not pages:
        return []

    # Build combined texts with page marks
    docs = []
    current_pages = [pages[0]]

    for page in pages[1:]:
        text_top = page["text"][:400]
        # New document if invoice/change-order header appears near top
        is_new_doc = (
            INVOICE_PATTERN.search(text_top)
            or CHANGE_ORDER_PATTERN.search(text_top[:200])
        )
        if is_new_doc and current_pages:
            docs.append(current_pages)
            current_pages = [page]
        else:
            current_pages.append(page)

    if current_pages:
        docs.append(current_pages)

    return [
        {
            "page_start": grp[0]["page"],
            "page_end": grp[-1]["page"],
            "text": "\n\n".join(p["text"] for p in grp)[:12000],
        }
        for grp in docs
    ]


def gpt_extract_text(client: OpenAI, text: str) -> dict:
    try:
        resp = client.chat.completions.create(
            model="gpt-4o",
            max_tokens=2000,
            messages=[
                {"role": "system", "content": TEXT_EXTRACTION_PROMPT},
                {"role": "user", "content": text},
            ],
        )
        content = resp.choices[0].message.content or ""
        m = re.search(r"\{[\s\S]*\}", content)
        if m:
            return json.loads(m.group())
    except Exception:
        pass
    return {"type": "other", "fields": {}, "line_items": [], "totals": {}}


# ── Vision mode extraction ────────────────────────────────────────────────────

def pdf_page_to_b64(pdf_path: str, page_num: int) -> str | None:
    """Convert a single PDF page to a base64-encoded JPEG."""
    if not HAS_PDF2IMAGE:
        return None
    try:
        images = convert_from_path(
            pdf_path,
            dpi=VISION_DPI,
            first_page=page_num,
            last_page=page_num,
        )
        if not images:
            return None
        img = images[0]
        w, h = img.size
        scale = min(1.0, VISION_MAX_PX / max(w, h))
        if scale < 1.0:
            img = img.resize((int(w * scale), int(h * scale)))
        buf = BytesIO()
        img.save(buf, format="JPEG", quality=85)
        return base64.b64encode(buf.getvalue()).decode()
    except Exception:
        return None


def gpt_extract_vision(client: OpenAI, b64_image: str) -> dict:
    try:
        resp = client.chat.completions.create(
            model="gpt-4o",
            max_tokens=2000,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": VISION_EXTRACTION_PROMPT},
                        {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64_image}", "detail": "high"}},
                    ],
                }
            ],
        )
        content = resp.choices[0].message.content or ""
        m = re.search(r"\{[\s\S]*\}", content)
        if m:
            return json.loads(m.group())
    except Exception:
        pass
    return {"type": "other", "fields": {}, "line_items": [], "totals": {}}


def is_continuation_page(data: dict, prev_data: dict | None) -> bool:
    """
    Detect if a page's result is a continuation of the previous invoice
    (same invoice number, no new header fields that differ from previous).
    """
    if prev_data is None:
        return False
    curr_fields = data.get("fields", {})
    prev_fields = prev_data.get("fields", {})
    curr_inv = curr_fields.get("invoice_number") or curr_fields.get("invoice_no")
    prev_inv = prev_fields.get("invoice_number") or prev_fields.get("invoice_no")
    if curr_inv and prev_inv and curr_inv == prev_inv:
        return True
    # If this page has no header fields (only line items / continuation)
    if not curr_inv and not curr_fields.get("vendor") and not curr_fields.get("date"):
        return True
    return False


def merge_pages(base: dict, addition: dict) -> dict:
    """Merge a continuation page's line items and totals into the base doc."""
    base["line_items"] = base.get("line_items", []) + addition.get("line_items", [])
    base["totals"].update(addition.get("totals", {}))
    return base


# ── Main processing ───────────────────────────────────────────────────────────

def process_financial(pdf_path: str, client: OpenAI) -> dict:
    start_time = time.time()

    with pdfplumber.open(pdf_path) as pdf:
        total_pages = len(pdf.pages)
        # Check text density across the first 3 pages (page 1 may be a scanned cover)
        sample_pages = pdf.pages[:min(3, total_pages)]
        sample_text = ""
        for page in sample_pages:
            t = page.extract_text(x_tolerance=2, y_tolerance=2) or ""
            sample_text += t

    is_text_mode = len(sample_text) >= MIN_CHARS_FOR_TEXT_MODE
    documents = []

    if is_text_mode:
        # ── TEXT MODE ─────────────────────────────────────────────────────
        pages = extract_text_pages(pdf_path)
        chunks = split_into_documents_text(pages)

        for chunk in chunks:
            result = gpt_extract_text(client, chunk["text"])
            documents.append({
                "type": result.get("type", "other"),
                "page_start": chunk["page_start"],
                "page_end": chunk["page_end"],
                "fields": result.get("fields", {}),
                "line_items": result.get("line_items", []),
                "totals": result.get("totals", {}),
                "raw_text": chunk["text"][:3000],
            })
            gc.collect()

    else:
        # ── VISION MODE ───────────────────────────────────────────────────
        current_doc: dict | None = None
        current_page_start = 1

        for page_num in range(1, min(total_pages, MAX_PAGES) + 1):
            b64 = pdf_page_to_b64(pdf_path, page_num)
            if b64 is None:
                continue

            page_data = gpt_extract_vision(client, b64)
            gc.collect()

            if current_doc is None:
                current_doc = page_data
                current_page_start = page_num
            elif is_continuation_page(page_data, current_doc):
                current_doc = merge_pages(current_doc, page_data)
            else:
                # New document — save current and start fresh
                documents.append({
                    "type": current_doc.get("type", "other"),
                    "page_start": current_page_start,
                    "page_end": page_num - 1,
                    "fields": current_doc.get("fields", {}),
                    "line_items": current_doc.get("line_items", []),
                    "totals": current_doc.get("totals", {}),
                    "raw_text": "",
                })
                current_doc = page_data
                current_page_start = page_num

        if current_doc is not None:
            documents.append({
                "type": current_doc.get("type", "other"),
                "page_start": current_page_start,
                "page_end": min(total_pages, MAX_PAGES),
                "fields": current_doc.get("fields", {}),
                "line_items": current_doc.get("line_items", []),
                "totals": current_doc.get("totals", {}),
                "raw_text": "",
            })

    processing_time_ms = int((time.time() - start_time) * 1000)

    # Determine overall detected type from documents
    types = [d["type"] for d in documents]
    if "change_order" in types:
        detected_type = "change_order"
    elif "invoice" in types:
        detected_type = "invoice"
    elif "receipt" in types:
        detected_type = "receipt"
    else:
        detected_type = "other"

    return {
        "total_pages": total_pages,
        "detected_type": detected_type,
        "total_documents": len(documents),
        "documents": documents,
        "processing_time_ms": processing_time_ms,
    }


def main():
    if len(sys.argv) < 4:
        print(json.dumps({"error": "Usage: financial_processor.py <pdf_path> <ai_base_url> <ai_api_key>"}))
        sys.exit(1)

    pdf_path, ai_base_url, ai_api_key = sys.argv[1], sys.argv[2], sys.argv[3]
    client = OpenAI(base_url=ai_base_url, api_key=ai_api_key)

    try:
        result = process_financial(pdf_path, client)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
