#!/usr/bin/env python3
"""
Targeted re-extraction for a single PDF page with table-aware prompt.
Outputs supplement JSON to stdout. Use reextract_page_update.sql to apply.

Usage:
  python3 scripts/reextract_page.py <pdf_path> <page_num> <ai_base_url> <ai_api_key>
"""

import sys
import json
import base64
import io
import re

import pdf2image
from PIL import Image
from openai import OpenAI

TABLE_PROMPT = """You are a construction drawing analyst specializing in extracting tabular data from engineering drawings.

Analyze this drawing page carefully. Your primary goal is to find and extract ALL tables, including:
- Pavement section tables (layer thicknesses, materials, compaction requirements)
- Compaction density tables (% compaction, density requirements by material/layer)
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

Be thorough — do not skip any table even if partially visible. Extract every number, percentage, and specification value you can read.

NUMERICAL ACCURACY IS CRITICAL:
- Pipe diameters are standard sizes: 12", 15", 18", 24", 30", 36", 42", 48" — never arbitrary values like 13 or 17
- Pipe IDs follow phase conventions: P1-xx for Phase 1, P2-xx for Phase 2, etc.
- Read each cell value carefully by looking at the actual characters in the image
- Double-check every number before including it"""


def pil_to_base64(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    return base64.b64encode(buf.getvalue()).decode()


def main():
    if len(sys.argv) < 5:
        print("Usage: python3 reextract_page.py <pdf_path> <page_num> <ai_base_url> <ai_api_key>", file=sys.stderr)
        sys.exit(1)

    pdf_path = sys.argv[1]
    page_num = int(sys.argv[2])
    ai_base_url = sys.argv[3]
    ai_api_key = sys.argv[4]

    print(f"Loading page {page_num} from {pdf_path}...", file=sys.stderr)
    images = pdf2image.convert_from_path(
        pdf_path,
        dpi=150,
        first_page=page_num,
        last_page=page_num,
        thread_count=1,
    )
    img = images[0]

    if img.width > 2400:
        ratio = 2400 / img.width
        img = img.resize((2400, int(img.height * ratio)), Image.LANCZOS)

    print(f"Image size: {img.width}x{img.height}, sending to GPT-4o...", file=sys.stderr)
    b64 = pil_to_base64(img)

    client = OpenAI(base_url=ai_base_url, api_key=ai_api_key)
    response = client.chat.completions.create(
        model="gpt-4o",
        max_tokens=8192,
        messages=[{
            "role": "user",
            "content": [
                {"type": "text", "text": TABLE_PROMPT},
                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}}
            ]
        }]
    )

    content = response.choices[0].message.content or ""
    print(f"Response length: {len(content)} chars", file=sys.stderr)

    json_match = re.search(r'\{[\s\S]*\}', content)
    if json_match:
        try:
            result = json.loads(json_match.group())
            print(json.dumps(result))
            return
        except json.JSONDecodeError as e:
            print(f"JSON parse error: {e}", file=sys.stderr)

    print(json.dumps({"tables": [], "all_text": content, "notes": [], "callouts": []}))


if __name__ == "__main__":
    main()
