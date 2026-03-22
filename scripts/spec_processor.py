#!/usr/bin/env python3
"""
Construction Specification PDF Processor
==========================================
Designed for CSI-format specification PDFs (letter-size text documents).
Unlike the drawing pipeline, this uses direct text extraction (no OCR/vision)
because specs are text PDFs, not scanned images.

Pipeline:
  1. Extract raw text from each page using pdfplumber (fast, accurate)
  2. Detect project name / header from first few pages
  3. Parse CSI division/section structure via regex
  4. For each section, use GPT-4o to extract structured requirements
  5. Output structured JSON with full section hierarchy

Usage:
  python3 spec_processor.py <pdf_path> <ai_base_url> <ai_api_key>
  Output: JSON to stdout
"""

import sys
import json
import re
import time
import gc
from openai import OpenAI
import pdfplumber

MAX_SECTIONS = 20         # Cap sections sent to GPT (to control cost/time)
MAX_CHARS_PER_SECTION = 8000  # Max chars per section sent to GPT

# CSI MasterFormat patterns
# Note: we do NOT require ^ start-of-line because pdfplumber sometimes
# returns indented text, and section headers may be mid-page after a footer.
SECTION_HEADER = re.compile(
    r'(?m)^[ \t]*SECTION\s+(\d{5,6})\s*[-–]\s*(.+)$', re.IGNORECASE
)
SECTION_HEADER_ALT = re.compile(
    r'(?m)^[ \t]*(\d{6})\s*[-–]\s*(.+)$'
)
DIVISION_HEADER = re.compile(
    r'^DIVISION\s+(\d{1,2})\s*[-–]\s*(.+)$', re.MULTILINE | re.IGNORECASE
)
PART_HEADER = re.compile(
    r'^(PART\s+[123]\s*[-–]?\s*(?:GENERAL|PRODUCTS|EXECUTION|MATERIALS?))\s*$',
    re.MULTILINE | re.IGNORECASE
)
SUBSECTION_HEADER = re.compile(
    r'^(\d+\.\d+)\s+([A-Z][A-Z\s,&/]{2,60})\s*$',
    re.MULTILINE
)

DIVISION_NAMES = {
    "00": "Procurement and Contracting Requirements",
    "01": "General Requirements",
    "02": "Existing Conditions",
    "03": "Concrete",
    "04": "Masonry",
    "05": "Metals",
    "06": "Wood, Plastics, and Composites",
    "07": "Thermal and Moisture Protection",
    "08": "Openings",
    "09": "Finishes",
    "10": "Specialties",
    "11": "Equipment",
    "12": "Furnishings",
    "13": "Special Construction",
    "14": "Conveying Equipment",
    "22": "Plumbing",
    "23": "HVAC",
    "25": "Integrated Automation",
    "26": "Electrical",
    "27": "Communications",
    "28": "Electronic Safety and Security",
    "31": "Earthwork",
    "32": "Exterior Improvements",
    "33": "Utilities",
    "34": "Transportation",
    "35": "Waterway and Marine",
    "40": "Process Integration",
    "41": "Material Processing and Handling",
    "42": "Process Heating, Cooling, and Drying",
    "43": "Process Gas and Liquid Handling",
    "44": "Pollution Control Equipment",
    "45": "Industry-Specific Manufacturing",
    "48": "Electrical Power Generation",
}


def get_page_count(pdf_path: str) -> int:
    with pdfplumber.open(pdf_path) as pdf:
        return len(pdf.pages)


def extract_all_text(pdf_path: str, max_pages: int = 1200) -> list[dict]:
    """Extract text from each page using pdfplumber. Returns list of {page, text}."""
    pages = []
    with pdfplumber.open(pdf_path) as pdf:
        for i, page in enumerate(pdf.pages[:max_pages], start=1):
            try:
                text = page.extract_text(x_tolerance=2, y_tolerance=2) or ""
                pages.append({"page": i, "text": text.strip()})
            except Exception:
                pages.append({"page": i, "text": ""})
    return pages


def detect_project_name(pages: list[dict]) -> str:
    """Heuristic: look for project name on first 3 pages."""
    # Common patterns: "SEPTA <Project Name>" or lines near "SPECIFICATIONS" or "CONTRACT DOCUMENTS"
    project_patterns = [
        re.compile(r'SEPTA\s+(.+?)\s*(?:SPECIFICATIONS|CONTRACT|PROJECT|CONFORMED)', re.IGNORECASE | re.DOTALL),
        re.compile(r'(?:PROJECT|CONTRACT):\s*(.+?)(?:\n|$)', re.IGNORECASE),
        re.compile(r'([A-Z][A-Z\s]{10,60}(?:RETROFIT|REHABILITATION|IMPROVEMENT|RENOVATION|PROJECT))', re.MULTILINE),
    ]
    for page in pages[:3]:
        text = page["text"]
        for pattern in project_patterns:
            m = pattern.search(text)
            if m:
                name = m.group(1).strip()
                name = re.sub(r'\s+', ' ', name)
                if 5 < len(name) < 120:
                    return name
    return ""


def parse_sections(pages: list[dict]) -> list[dict]:
    """
    Parse CSI section structure from page text.
    Returns list of {section_number, section_title, division_number, division_title, page_start, page_end, full_text}
    """
    # Build full document with page markers
    doc_parts = []
    for p in pages:
        doc_parts.append(f"\n<<<PAGE:{p['page']}>>>\n{p['text']}")
    full_doc = "\n".join(doc_parts)

    # Find all section starts
    section_starts = []

    for m in SECTION_HEADER.finditer(full_doc):
        section_num = m.group(1).zfill(6)
        section_title = m.group(2).strip()
        # Find which page this is on
        pos = m.start()
        page_markers = list(re.finditer(r'<<<PAGE:(\d+)>>>', full_doc[:pos + 1]))
        page_num = int(page_markers[-1].group(1)) if page_markers else 1
        section_starts.append({
            "pos": pos,
            "section_number": section_num,
            "section_title": section_title,
            "page": page_num,
        })

    # Deduplicate by section number (keep first occurrence)
    seen = set()
    unique_starts = []
    for s in sorted(section_starts, key=lambda x: x["pos"]):
        if s["section_number"] not in seen:
            seen.add(s["section_number"])
            unique_starts.append(s)

    if not unique_starts:
        # Fallback: treat the whole doc as one section
        return [{
            "section_number": "000000",
            "section_title": "Full Document",
            "division_number": "00",
            "division_title": "Procurement and Contracting Requirements",
            "page_start": pages[0]["page"] if pages else 1,
            "page_end": pages[-1]["page"] if pages else 1,
            "full_text": "\n".join(p["text"] for p in pages)[:MAX_CHARS_PER_SECTION],
        }]

    # For each section, extract text between this start and the next
    sections = []
    for i, start in enumerate(unique_starts):
        end_pos = unique_starts[i + 1]["pos"] if i + 1 < len(unique_starts) else len(full_doc)
        section_text = full_doc[start["pos"]:end_pos]

        # Strip page markers from text
        section_text_clean = re.sub(r'<<<PAGE:\d+>>>', '', section_text).strip()

        # Determine page_end
        page_markers_in = list(re.finditer(r'<<<PAGE:(\d+)>>>', full_doc[start["pos"]:end_pos]))
        page_end = int(page_markers_in[-1].group(1)) if page_markers_in else start["page"]

        # Division from section number
        div_num = start["section_number"][:2]
        div_title = DIVISION_NAMES.get(div_num, f"Division {div_num}")

        sections.append({
            "section_number": start["section_number"],
            "section_title": start["section_title"],
            "division_number": div_num,
            "division_title": div_title,
            "page_start": start["page"],
            "page_end": page_end,
            "full_text": section_text_clean[:MAX_CHARS_PER_SECTION],
        })

    return sections


def parse_parts_regex(section_text: str) -> list[dict]:
    """
    Fast regex-only parsing of Part/subsection structure.
    Used for ALL sections (AI is used only for structured summaries of first N sections).
    """
    parts = []
    # Split by PART headers
    part_splits = list(PART_HEADER.finditer(section_text))

    if not part_splits:
        # Single part fallback
        subs = parse_subsections(section_text)
        return [{"name": "CONTENT", "subsections": subs}]

    for i, part_match in enumerate(part_splits):
        part_name = part_match.group(1).strip().upper()
        start = part_match.end()
        end = part_splits[i + 1].start() if i + 1 < len(part_splits) else len(section_text)
        part_text = section_text[start:end].strip()
        subs = parse_subsections(part_text)
        parts.append({"name": part_name, "subsections": subs})

    return parts


def parse_subsections(text: str) -> list[dict]:
    """Parse numbered subsections like '1.01 DESCRIPTION' and their content."""
    subsections = []
    splits = list(SUBSECTION_HEADER.finditer(text))

    if not splits:
        # Return the whole text as one unnumbered subsection
        if text.strip():
            return [{"identifier": "", "title": None, "content": text.strip()[:2000]}]
        return []

    for i, m in enumerate(splits):
        identifier = m.group(1)
        title = m.group(2).strip()
        start = m.end()
        end = splits[i + 1].start() if i + 1 < len(splits) else len(text)
        content = text[start:end].strip()
        subsections.append({
            "identifier": identifier,
            "title": title,
            "content": content[:1500],
        })

    return subsections


SECTION_PROMPT = """You are a construction specification analyst. Extract structured data from this CSI specification section text.

Return JSON with exactly this structure:
{
  "section_number": "010100",
  "section_title": "SUMMARY OF WORK",
  "parts": [
    {
      "name": "PART 1 GENERAL",
      "subsections": [
        {
          "identifier": "1.01",
          "title": "DESCRIPTION OF WORK",
          "content": "summary of the requirements in this subsection"
        }
      ]
    }
  ]
}

Rules:
- Extract PART 1 GENERAL, PART 2 PRODUCTS, PART 3 EXECUTION (whichever are present)
- For each subsection (1.01, 1.02, A, B, etc.) include the identifier, title, and a condensed summary of requirements
- Keep content summaries under 300 characters each
- Be accurate to the source text"""


def gpt_structure_section(client: OpenAI, section: dict) -> dict:
    """Use GPT-4o to structure a spec section (text only, no vision)."""
    prompt = f"Section: {section['section_number']} - {section['section_title']}\n\n{section['full_text']}"
    try:
        response = client.chat.completions.create(
            model="gpt-4o",
            max_tokens=1500,
            messages=[
                {"role": "system", "content": SECTION_PROMPT},
                {"role": "user", "content": prompt},
            ]
        )
        content = response.choices[0].message.content or ""
        json_match = re.search(r'\{[\s\S]*\}', content)
        if json_match:
            result = json.loads(json_match.group())
            return result.get("parts", [])
    except Exception:
        pass
    return parse_parts_regex(section["full_text"])


def process_spec(pdf_path: str, client: OpenAI) -> dict:
    start_time = time.time()

    # 1. Extract all text
    all_pages = extract_all_text(pdf_path)
    total_pages = len(all_pages)

    # 2. Detect project name
    project_name = detect_project_name(all_pages)

    # 3. Parse section structure
    raw_sections = parse_sections(all_pages)

    # 4. Structure each section
    structured_sections = []
    for i, section in enumerate(raw_sections):
        # Use GPT for first MAX_SECTIONS sections; regex-only for the rest
        if i < MAX_SECTIONS:
            parts = gpt_structure_section(client, section)
        else:
            parts = parse_parts_regex(section["full_text"])

        structured_sections.append({
            "section_number": section["section_number"],
            "section_title": section["section_title"],
            "division_number": section["division_number"],
            "division_title": section["division_title"],
            "page_start": section["page_start"],
            "page_end": section["page_end"],
            "parts": parts,
            "full_text": section["full_text"],
        })
        gc.collect()

    processing_time_ms = int((time.time() - start_time) * 1000)

    return {
        "total_pages": total_pages,
        "project_name": project_name,
        "total_sections": len(structured_sections),
        "sections": structured_sections,
        "processing_time_ms": processing_time_ms,
    }


def main():
    if len(sys.argv) < 4:
        print(json.dumps({"error": "Usage: spec_processor.py <pdf_path> <ai_base_url> <ai_api_key>"}))
        sys.exit(1)

    pdf_path = sys.argv[1]
    ai_base_url = sys.argv[2]
    ai_api_key = sys.argv[3]

    client = OpenAI(base_url=ai_base_url, api_key=ai_api_key)

    try:
        result = process_spec(pdf_path, client)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
