#!/usr/bin/env python3
"""
Backfill PE stamp data for existing construction extractions.
Runs the dedicated PE seal crop+Vision pass on every page of every completed extraction,
patches the pages JSONB in the database, then triggers re-indexing.

Usage:
  python3 scripts/backfill_pe_stamps.py [extraction_id ...]
  
  If no IDs given, processes all completed extractions.
"""

import sys
import os
import json
import time
import gc

sys.path.insert(0, os.path.join(os.path.dirname(__file__)))

from pdf_processor import (
    load_single_page, vision_extract_pe_stamp, format_pe_stamps_text, DPI
)

import httpx
from openai import OpenAI
import psycopg2

DATABASE_URL = os.environ.get("DATABASE_URL", "")
AI_BASE_URL = os.environ.get("AI_INTEGRATIONS_OPENAI_BASE_URL", "")
AI_API_KEY = os.environ.get("AI_INTEGRATIONS_OPENAI_API_KEY", "")
API_SERVER = os.environ.get("API_SERVER", "http://localhost:8080")


def get_extractions(conn, ids=None):
    cur = conn.cursor()
    if ids:
        placeholders = ",".join(["%s"] * len(ids))
        cur.execute(
            f"SELECT id, file_name, status, total_pages, pages FROM construction_extractions WHERE id IN ({placeholders}) ORDER BY id",
            ids,
        )
    else:
        cur.execute(
            "SELECT id, file_name, status, total_pages, pages FROM construction_extractions WHERE status = 'completed' ORDER BY id"
        )
    rows = cur.fetchall()
    cur.close()
    return rows


def find_pdf_path(file_name):
    candidates = [
        os.path.join("attached_assets", file_name),
        os.path.join("/tmp", file_name),
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    for root, dirs, files in os.walk("attached_assets"):
        for f in files:
            if f == file_name:
                return os.path.join(root, f)
    return None


def main():
    if not DATABASE_URL:
        print("ERROR: DATABASE_URL not set", file=sys.stderr)
        sys.exit(1)
    if not AI_BASE_URL or not AI_API_KEY:
        print("ERROR: AI_INTEGRATIONS_OPENAI_BASE_URL / AI_INTEGRATIONS_OPENAI_API_KEY not set", file=sys.stderr)
        sys.exit(1)

    target_ids = [int(x) for x in sys.argv[1:]] if len(sys.argv) > 1 else None

    client = OpenAI(
        base_url=AI_BASE_URL,
        api_key=AI_API_KEY,
        timeout=httpx.Timeout(120, connect=30.0),
    )

    conn = psycopg2.connect(DATABASE_URL)
    extractions = get_extractions(conn, target_ids)
    print(f"Found {len(extractions)} extraction(s) to process", file=sys.stderr)

    for ext_id, file_name, status, total_pages, pages_json in extractions:
        print(f"\n{'='*60}", file=sys.stderr)
        print(f"Extraction {ext_id}: {file_name} ({total_pages} pages, status={status})", file=sys.stderr)

        pdf_path = find_pdf_path(file_name)
        if not pdf_path:
            print(f"  SKIP: PDF not found for {file_name}", file=sys.stderr)
            continue

        pages = pages_json if isinstance(pages_json, list) else json.loads(pages_json) if pages_json else []
        if not pages:
            print(f"  SKIP: No pages data", file=sys.stderr)
            continue

        updated = False
        total_stamps = 0
        for i, page in enumerate(pages):
            page_num = page.get("page_number", i + 1)
            existing_stamps = page.get("pe_stamps", [])
            if existing_stamps:
                print(f"  Page {page_num}: already has {len(existing_stamps)} PE stamps, re-extracting anyway", file=sys.stderr)

            try:
                img = load_single_page(pdf_path, page_num)
                pe_data = vision_extract_pe_stamp(client, img)
                del img
                gc.collect()

                stamps = pe_data.get("pe_stamps", [])
                firm = pe_data.get("firm_info")

                if stamps:
                    stamp_names = [s.get("name", "?") for s in stamps]
                    print(f"  Page {page_num}: {len(stamps)} PE stamp(s): {', '.join(stamp_names)}", file=sys.stderr)
                    total_stamps += len(stamps)
                else:
                    print(f"  Page {page_num}: no PE stamps", file=sys.stderr)

                page["pe_stamps"] = stamps
                page["firm_info"] = firm

                pe_text = format_pe_stamps_text(pe_data)
                if pe_text:
                    all_text = page.get("all_text", "")
                    start_marker = "--- PROFESSIONAL ENGINEER SEALS/STAMPS ---"
                    end_marker = "--- END PE SEALS ---"
                    if start_marker in all_text:
                        start_idx = all_text.index(start_marker)
                        prefix_idx = all_text.rfind("\n", 0, start_idx)
                        if prefix_idx < 0:
                            prefix_idx = 0
                        end_idx = all_text.find(end_marker, start_idx)
                        if end_idx >= 0:
                            all_text = all_text[:prefix_idx] + all_text[end_idx + len(end_marker):]
                        else:
                            all_text = all_text[:prefix_idx]
                    page["all_text"] = all_text.rstrip() + "\n" + pe_text

                updated = True
            except Exception as e:
                print(f"  Page {page_num}: ERROR: {e}", file=sys.stderr)
                continue

            time.sleep(0.2)

        if updated:
            cur = conn.cursor()
            cur.execute(
                "UPDATE construction_extractions SET pages = %s, updated_at = NOW() WHERE id = %s",
                (json.dumps(pages), ext_id),
            )
            conn.commit()
            cur.close()
            print(f"  DB updated: {total_stamps} total PE stamps found across {len(pages)} pages", file=sys.stderr)

            print(f"  Triggering re-index for linked projects...", file=sys.stderr)
            try:
                resp = httpx.post(
                    f"{API_SERVER}/api/pdf-extractions/{ext_id}/reindex",
                    timeout=300,
                )
                if resp.status_code < 300:
                    print(f"  Re-index triggered successfully", file=sys.stderr)
                else:
                    print(f"  Re-index request returned {resp.status_code}: {resp.text[:200]}", file=sys.stderr)
                    print(f"  NOTE: Restart the API server to trigger embedding backfill", file=sys.stderr)
            except Exception as e:
                print(f"  Re-index request failed: {e}", file=sys.stderr)
                print(f"  NOTE: Restart the API server to trigger embedding backfill", file=sys.stderr)

    conn.close()
    print(f"\nDone!", file=sys.stderr)


if __name__ == "__main__":
    main()
