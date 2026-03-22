#!/usr/bin/env python3
"""
Lightweight document type detector.
Inspects a PDF and outputs a JSON classification:
  - construction_pdf  (large-format engineering drawings)
  - spec_pdf          (CSI-format letter-size specification)
  - scanned_pdf       (letter-size but image-heavy / no readable text)

Run time: < 3 seconds (reads only first 5 pages).

Usage:
  python3 detect_document.py <pdf_path>
  Output: JSON to stdout
"""

import sys
import json
import re
import pdfplumber

LETTER_MAX_PTS = 828      # 11.5 inches × 72 pts – anything taller is large-format
MIN_WORDS_FOR_TEXT = 80   # avg words/page to consider a PDF "text-heavy"
CSI_PATTERN = re.compile(r'SECTION\s+\d{5,6}\s*[-–]', re.IGNORECASE)
# Also detect "010100" / "NNNNNN" division tables in TOC pages
CSI_TOC_PATTERN = re.compile(r'\b(0[12][0-9]{4}|3[0-9]{5}|22\d{4}|26\d{4}|31\d{4}|32\d{4}|33\d{4})\b')
TITLE_BLOCK_WORDS = re.compile(
    r'\b(SHEET|DRAWING|REVISION|SCALE|PROJECT|ENGINEER|ARCHITECT|CONTRACTOR)\b',
    re.IGNORECASE,
)
# Words common in spec documents but not in drawings
SPEC_WORDS = re.compile(
    r'\b(SPECIFICATIONS?|DIVISION|CONTRACTOR|MATERIALS?|REQUIREMENTS?|SUBMITTALS?|EXECUTION|PRODUCTS?|GENERAL)\b',
    re.IGNORECASE,
)


def detect(pdf_path: str) -> dict:
    with pdfplumber.open(pdf_path) as pdf:
        total_pages = len(pdf.pages)
        sample = pdf.pages[:min(5, total_pages)]

        page0 = sample[0]
        width_pts = page0.width
        height_pts = page0.height
        long_edge = max(width_pts, height_pts)

        # ── Large-format check ───────────────────────────────────────────────
        if long_edge > LETTER_MAX_PTS:
            return {
                "type": "construction_pdf",
                "reason": (
                    f"Large-format page ({width_pts:.0f}×{height_pts:.0f} pts = "
                    f"{width_pts/72:.1f}\"×{height_pts/72:.1f}\")"
                ),
                "total_pages": total_pages,
                "page_width_pts": width_pts,
                "page_height_pts": height_pts,
                "avg_words_per_page": None,
            }

        # ── Letter-size: check text density and CSI markers ─────────────────
        # Sample first 12 pages to catch PDFs with cover + TOC before content
        extended_sample = pdf.pages[:min(12, total_pages)]
        word_counts = []
        combined_text = ""
        for page in extended_sample:
            text = page.extract_text(x_tolerance=2, y_tolerance=2) or ""
            combined_text += text + "\n"
            word_counts.append(len(text.split()))

        # Use median pages 3-12 for word count (skip sparse cover/TOC pages)
        body_counts = word_counts[2:] if len(word_counts) > 3 else word_counts
        avg_words = sum(body_counts) / max(1, len(body_counts))

        has_csi = bool(CSI_PATTERN.search(combined_text))
        # CSI section numbers appearing in TOC lists (e.g. "010100", "033000")
        csi_toc_hits = len(CSI_TOC_PATTERN.findall(combined_text))
        spec_word_hits = len(SPEC_WORDS.findall(combined_text))
        has_title_block = len(TITLE_BLOCK_WORDS.findall(combined_text)) >= 3 and avg_words < 60

        # Strong spec signals: CSI header OR multiple CSI section numbers in TOC
        # OR spec vocabulary + readable text
        is_spec = (
            has_csi
            or csi_toc_hits >= 5
            or (avg_words >= MIN_WORDS_FOR_TEXT and spec_word_hits >= 4)
        )

        if is_spec:
            if has_csi:
                reason = f"CSI section header detected; avg {avg_words:.0f} words/page"
            elif csi_toc_hits >= 5:
                reason = f"CSI section numbers in table of contents ({csi_toc_hits} found); avg {avg_words:.0f} words/page"
            else:
                reason = f"Text-heavy letter-size PDF with spec vocabulary (avg {avg_words:.0f} words/page)"
            pdf_type = "spec_pdf"
        elif has_title_block:
            pdf_type = "construction_pdf"
            reason = f"Engineering title-block terms detected; image-heavy ({avg_words:.0f} words/page avg)"
        else:
            # Low-text letter-size PDF — most likely a scanned drawing
            pdf_type = "construction_pdf"
            reason = f"Letter-size but image-heavy ({avg_words:.0f} words/page avg) — treating as drawing"

        return {
            "type": pdf_type,
            "reason": reason,
            "total_pages": total_pages,
            "page_width_pts": width_pts,
            "page_height_pts": height_pts,
            "avg_words_per_page": round(avg_words, 1),
        }


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: detect_document.py <pdf_path>"}))
        sys.exit(1)
    try:
        result = detect(sys.argv[1])
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
