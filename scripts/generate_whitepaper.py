#!/usr/bin/env python3
"""Generate the ConstructAI Data Privacy Whitepaper as a PDF."""

from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.colors import HexColor
from reportlab.lib.units import inch
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    PageBreak, HRFlowable
)
from reportlab.lib import colors
import os

OUTPUT_PATH = os.path.join(os.path.dirname(__file__), "..", "ConstructAI_Data_Privacy_Whitepaper.pdf")

DARK_BLUE = HexColor("#1a2332")
ACCENT_BLUE = HexColor("#2563eb")
LIGHT_GRAY = HexColor("#f3f4f6")
BORDER_GRAY = HexColor("#d1d5db")
TEXT_DARK = HexColor("#1f2937")
TEXT_MEDIUM = HexColor("#4b5563")
RED_ALERT = HexColor("#dc2626")
GREEN_OK = HexColor("#059669")
AMBER_WARN = HexColor("#d97706")

def build_styles():
    styles = getSampleStyleSheet()

    styles.add(ParagraphStyle(
        "CoverTitle", parent=styles["Title"],
        fontSize=28, leading=34, textColor=DARK_BLUE,
        alignment=TA_CENTER, spaceAfter=12
    ))
    styles.add(ParagraphStyle(
        "CoverSubtitle", parent=styles["Normal"],
        fontSize=14, leading=18, textColor=TEXT_MEDIUM,
        alignment=TA_CENTER, spaceAfter=6
    ))
    styles.add(ParagraphStyle(
        "SectionHeader", parent=styles["Heading1"],
        fontSize=18, leading=22, textColor=DARK_BLUE,
        spaceBefore=24, spaceAfter=10,
        borderWidth=0, borderPadding=0
    ))
    styles.add(ParagraphStyle(
        "SubHeader", parent=styles["Heading2"],
        fontSize=14, leading=18, textColor=ACCENT_BLUE,
        spaceBefore=16, spaceAfter=8
    ))
    styles.add(ParagraphStyle(
        "SubSubHeader", parent=styles["Heading3"],
        fontSize=12, leading=16, textColor=TEXT_DARK,
        spaceBefore=12, spaceAfter=6
    ))
    styles["BodyText"].fontSize = 10
    styles["BodyText"].leading = 14
    styles["BodyText"].textColor = TEXT_DARK
    styles["BodyText"].alignment = TA_JUSTIFY
    styles["BodyText"].spaceAfter = 8
    styles.add(ParagraphStyle(
        "BulletItem", parent=styles["Normal"],
        fontSize=10, leading=14, textColor=TEXT_DARK,
        leftIndent=20, spaceAfter=4, bulletIndent=8
    ))
    styles.add(ParagraphStyle(
        "AlertText", parent=styles["Normal"],
        fontSize=10, leading=14, textColor=RED_ALERT,
        spaceAfter=8, borderWidth=1, borderColor=RED_ALERT,
        borderPadding=8, backColor=HexColor("#fef2f2")
    ))
    styles.add(ParagraphStyle(
        "InfoBox", parent=styles["Normal"],
        fontSize=10, leading=14, textColor=TEXT_DARK,
        spaceAfter=8, borderWidth=1, borderColor=ACCENT_BLUE,
        borderPadding=8, backColor=HexColor("#eff6ff")
    ))
    styles.add(ParagraphStyle(
        "FooterNote", parent=styles["Normal"],
        fontSize=8, leading=10, textColor=TEXT_MEDIUM,
        alignment=TA_CENTER
    ))
    styles.add(ParagraphStyle(
        "TableCell", parent=styles["Normal"],
        fontSize=9, leading=12, textColor=TEXT_DARK
    ))
    styles.add(ParagraphStyle(
        "TableHeader", parent=styles["Normal"],
        fontSize=9, leading=12, textColor=colors.white,
        fontName="Helvetica-Bold"
    ))
    return styles


def make_table(headers, rows, col_widths=None):
    """Build a styled table."""
    style = getSampleStyleSheet()
    header_style = ParagraphStyle("TH", parent=style["Normal"], fontSize=9, leading=12, textColor=colors.white, fontName="Helvetica-Bold")
    cell_style = ParagraphStyle("TC", parent=style["Normal"], fontSize=9, leading=12, textColor=TEXT_DARK)

    data = [[Paragraph(h, header_style) for h in headers]]
    for row in rows:
        data.append([Paragraph(str(c), cell_style) for c in row])

    t = Table(data, colWidths=col_widths, repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), DARK_BLUE),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), 9),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 8),
        ("TOPPADDING", (0, 0), (-1, 0), 8),
        ("BACKGROUND", (0, 1), (-1, -1), colors.white),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, LIGHT_GRAY]),
        ("GRID", (0, 0), (-1, -1), 0.5, BORDER_GRAY),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 1), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 1), (-1, -1), 5),
    ]))
    return t


def hr():
    return HRFlowable(width="100%", thickness=1, color=BORDER_GRAY, spaceBefore=6, spaceAfter=6)


def build_document():
    doc = SimpleDocTemplate(
        OUTPUT_PATH, pagesize=letter,
        leftMargin=0.75*inch, rightMargin=0.75*inch,
        topMargin=0.75*inch, bottomMargin=0.75*inch
    )
    S = build_styles()
    story = []

    # ── COVER PAGE ──
    story.append(Spacer(1, 1.5*inch))
    story.append(Paragraph("ConstructAI", S["CoverTitle"]))
    story.append(Paragraph("Data Privacy &amp; AI Infrastructure Whitepaper", S["CoverSubtitle"]))
    story.append(Spacer(1, 0.3*inch))
    story.append(hr())
    story.append(Spacer(1, 0.3*inch))
    story.append(Paragraph("Limitations, Risks, and Solutions for Handling<br/>Confidential Construction Documents with External AI Providers", S["CoverSubtitle"]))
    story.append(Spacer(1, 0.5*inch))
    story.append(Paragraph("Version 1.0 | March 2026", S["CoverSubtitle"]))
    story.append(Paragraph("CONFIDENTIAL — For Internal Stakeholder Review", S["CoverSubtitle"]))
    story.append(Spacer(1, 1.5*inch))
    story.append(Paragraph("Prepared for ConstructAI System Stakeholders", S["CoverSubtitle"]))

    story.append(PageBreak())

    # ── TABLE OF CONTENTS ──
    story.append(Paragraph("Table of Contents", S["SectionHeader"]))
    story.append(hr())
    toc_items = [
        ("1.", "Executive Summary"),
        ("2.", "Current System Architecture — Data Flow Analysis"),
        ("3.", "Data Exposure Points — What Goes Where"),
        ("4.", "OpenAI Terms &amp; Conditions — API Data Usage"),
        ("5.", "Replit Terms &amp; Conditions — AI Integrations Privacy"),
        ("6.", "Risk Assessment Matrix"),
        ("7.", "Solution 1: OpenAI Zero Data Retention (ZDR)"),
        ("8.", "Solution 2: Self-Hosted Open-Source LLM"),
        ("9.", "Solution 3: Hybrid Architecture (Recommended)"),
        ("10.", "Solution 4: Air-Gapped Deployment"),
        ("11.", "Implementation Roadmap"),
        ("12.", "Cost-Benefit Analysis"),
        ("13.", "Recommendations &amp; Next Steps"),
    ]
    for num, title in toc_items:
        story.append(Paragraph(f"<b>{num}</b>  {title}", S["BodyText"]))
    story.append(PageBreak())

    # ── 1. EXECUTIVE SUMMARY ──
    story.append(Paragraph("1. Executive Summary", S["SectionHeader"]))
    story.append(hr())
    story.append(Paragraph(
        "ConstructAI is an AI-powered document management system designed for construction project managers. "
        "It extracts structured data from construction drawings, specifications, and financial documents, then "
        "provides a natural language Q&amp;A interface that answers questions exclusively from indexed project data.",
        S["BodyText"]
    ))
    story.append(Paragraph(
        "The system currently relies on OpenAI's GPT-4o model (accessed through Replit's AI integrations proxy) for "
        "two critical functions: <b>vision-based document extraction</b> (reading construction drawings) and "
        "<b>natural language question answering</b> (chat). This creates a data privacy concern: confidential "
        "construction documents — which may contain proprietary designs, trade secrets, bid pricing, engineering "
        "specifications, and other commercially sensitive information — are transmitted to external servers for processing.",
        S["BodyText"]
    ))
    story.append(Paragraph(
        "<b>Key Finding:</b> While OpenAI's API terms state that API data is NOT used for model training by default, "
        "data is still retained for up to 30 days for abuse monitoring. For organizations handling trade secrets "
        "or sensitive intellectual property, this default retention policy may not meet internal compliance requirements. "
        "Solutions ranging from Zero Data Retention (ZDR) to fully self-hosted infrastructure are available, "
        "each with distinct tradeoffs in cost, accuracy, and implementation complexity.",
        S["InfoBox"]
    ))
    story.append(PageBreak())

    # ── 2. CURRENT ARCHITECTURE ──
    story.append(Paragraph("2. Current System Architecture — Data Flow Analysis", S["SectionHeader"]))
    story.append(hr())
    story.append(Paragraph("The ConstructAI system consists of four processing layers:", S["BodyText"]))

    story.append(Paragraph("2.1 Local Processing (No External Data Transmission)", S["SubHeader"]))
    story.append(Paragraph(
        "The following operations run entirely on the application server with zero external data transmission:",
        S["BodyText"]
    ))
    bullet_items = [
        "<b>Text embedding / search indexing</b> — Uses a local all-MiniLM-L6-v2 ONNX model (384-dimension vectors). All document chunks are embedded locally and stored in PostgreSQL with pgvector. No document content leaves the server for this operation.",
        "<b>OCR pre-processing</b> — Tesseract OCR and OpenCV image preprocessing run locally on the server.",
        "<b>PDF parsing</b> — pdfplumber text extraction for specification documents runs entirely locally.",
        "<b>Database storage</b> — All extracted data, embeddings, chat history, and project metadata are stored in a local PostgreSQL database.",
        "<b>Keyword search</b> — Full-text search (tsvector), identifier matching, and synonym expansion all run locally against the database.",
    ]
    for item in bullet_items:
        story.append(Paragraph(f"\u2022 {item}", S["BulletItem"]))

    story.append(Paragraph("2.2 External Processing (Data Transmitted to OpenAI via Replit Proxy)", S["SubHeader"]))
    story.append(Paragraph(
        "The following operations transmit document content to OpenAI's GPT-4o model through Replit's AI integrations proxy:",
        S["BodyText"]
    ))
    ext_items = [
        "<b>Vision extraction</b> — Each page of a construction drawing is converted to a JPEG image and sent to GPT-4o Vision for structured data extraction. This is a ONE-TIME operation per document page. The extracted structured data is stored locally; the image is not retained by the application after processing.",
        "<b>Chat question answering</b> — When a user asks a question, the top 15 most relevant document chunks (text excerpts, typically 1,500 characters each) are sent to GPT-4o as context, along with the user's question. This occurs on EVERY question asked.",
        "<b>AI reranking</b> — Up to 25 document chunks are sent to GPT-4o for relevance scoring before final answer generation. This occurs on EVERY question asked.",
        "<b>Query reformulation</b> — When initial search returns no results or low confidence, the user's question is sent to GPT-4o to generate alternative search queries. This occurs only on FAILED searches.",
    ]
    for item in ext_items:
        story.append(Paragraph(f"\u2022 {item}", S["BulletItem"]))
    story.append(PageBreak())

    # ── 3. DATA EXPOSURE POINTS ──
    story.append(Paragraph("3. Data Exposure Points — What Goes Where", S["SectionHeader"]))
    story.append(hr())

    story.append(make_table(
        ["Data Type", "Transmitted Externally?", "Frequency", "Sensitivity Level"],
        [
            ["Construction drawing images", "Yes — to OpenAI GPT-4o", "Once per page at upload", "HIGH — proprietary designs"],
            ["Extracted text chunks (1,500 chars)", "Yes — to OpenAI GPT-4o", "Every chat question", "HIGH — specs, quantities, pricing"],
            ["User questions", "Yes — to OpenAI GPT-4o", "Every chat question", "MEDIUM — reveals project scope"],
            ["Document embeddings (384-dim vectors)", "No — processed locally", "Once at indexing", "LOW — not reversible to text"],
            ["Project metadata (names, dates)", "No — local database only", "Never", "MEDIUM"],
            ["Chat history", "No — local database only", "Never", "LOW"],
            ["PDF files (original)", "No — stored locally", "Never", "HIGH — complete documents"],
        ],
        col_widths=[1.8*inch, 1.6*inch, 1.4*inch, 1.6*inch]
    ))

    story.append(Spacer(1, 12))
    story.append(Paragraph(
        "<b>CRITICAL:</b> The highest-risk data exposure is during vision extraction (full drawing images) and "
        "chat answering (document text excerpts). Together, these operations can expose the complete content of "
        "any indexed document over time.",
        S["AlertText"]
    ))
    story.append(PageBreak())

    # ── 4. OPENAI T&Cs ──
    story.append(Paragraph("4. OpenAI Terms &amp; Conditions — API Data Usage", S["SectionHeader"]))
    story.append(hr())

    story.append(Paragraph("4.1 Data Training Policy", S["SubHeader"]))
    story.append(Paragraph(
        "As of March 1, 2023, OpenAI's API data usage policy states:",
        S["BodyText"]
    ))
    story.append(Paragraph(
        "<i>\"By default, we do not train on any inputs or outputs from our products for business users, "
        "including ChatGPT Team, ChatGPT Enterprise, and the API. Unless they explicitly opt-in, organizations "
        "are opted out of data-sharing by default.\"</i>",
        S["InfoBox"]
    ))
    story.append(Paragraph(
        "This means data sent through ConstructAI's API calls is <b>NOT used to train or improve OpenAI's models</b>. "
        "This policy has been in effect since March 2023 and applies to all API tier customers.",
        S["BodyText"]
    ))

    story.append(Paragraph("4.2 Data Retention for Abuse Monitoring", S["SubHeader"]))
    story.append(Paragraph(
        "While API data is not used for training, OpenAI <b>does retain API inputs and outputs for up to 30 days</b> "
        "for abuse monitoring purposes. This is the default behavior for all standard API customers.",
        S["BodyText"]
    ))
    story.append(Paragraph(
        "<b>What this means in practice:</b> Every construction drawing image sent for vision extraction and every "
        "document chunk sent for chat answering is stored on OpenAI's servers for up to 30 days. During this period, "
        "automated systems (and potentially human reviewers in flagged cases) may access this data to detect policy violations.",
        S["AlertText"]
    ))

    story.append(Paragraph("4.3 Zero Data Retention (ZDR)", S["SubHeader"]))
    story.append(Paragraph(
        "OpenAI offers a <b>Zero Data Retention (ZDR)</b> option for qualifying customers:",
        S["BodyText"]
    ))
    zdr_items = [
        "No customer content is stored in abuse monitoring logs",
        "Data is processed in-memory only — not written to disk or database",
        "No human review of customer data",
        "Requires prior approval from OpenAI's sales team",
        "Customer must accept responsibility for self-moderating abuse",
        "Some API features are restricted (no extended prompt caching, no background mode)",
    ]
    for item in zdr_items:
        story.append(Paragraph(f"\u2022 {item}", S["BulletItem"]))

    story.append(Paragraph("4.4 Modified Abuse Monitoring (MAM)", S["SubHeader"]))
    story.append(Paragraph(
        "An alternative to ZDR, <b>Modified Abuse Monitoring (MAM)</b> excludes customer content from abuse logs "
        "(except rare image/file inputs) while maintaining full API capabilities. This option may be more practical "
        "for ConstructAI since it preserves all endpoint functionality.",
        S["BodyText"]
    ))

    story.append(Paragraph("4.5 Legal Considerations", S["SubHeader"]))
    story.append(Paragraph(
        "In 2025, a legal order related to the New York Times lawsuit temporarily forced OpenAI to retain API data "
        "beyond the standard 30-day window (April–September 2025). <b>ZDR customers were not impacted</b> by this "
        "legal hold. This precedent highlights that standard API retention is subject to legal process, while "
        "ZDR provides stronger protection.",
        S["BodyText"]
    ))

    story.append(make_table(
        ["Policy", "Training on Data?", "Retention Period", "Human Review?", "Approval Required?"],
        [
            ["Standard API (Default)", "No", "Up to 30 days", "Possible (flagged cases)", "No"],
            ["Zero Data Retention", "No", "None (in-memory only)", "No", "Yes — sales approval"],
            ["Modified Abuse Monitoring", "No", "None (mostly)", "No", "Yes — sales approval"],
        ],
        col_widths=[1.5*inch, 1.0*inch, 1.3*inch, 1.4*inch, 1.3*inch]
    ))
    story.append(Spacer(1, 6))
    story.append(Paragraph(
        "Source: OpenAI Enterprise Privacy documentation — https://openai.com/enterprise-privacy/",
        S["FooterNote"]
    ))
    story.append(PageBreak())

    # ── 5. REPLIT T&Cs ──
    story.append(Paragraph("5. Replit Terms &amp; Conditions — AI Integrations Privacy", S["SectionHeader"]))
    story.append(hr())

    story.append(Paragraph("5.1 How Replit's AI Proxy Works", S["SubHeader"]))
    story.append(Paragraph(
        "ConstructAI accesses OpenAI's API through <b>Replit's AI Integrations proxy</b>. This means API requests "
        "are routed through Replit's infrastructure before reaching OpenAI. Replit manages the API credentials "
        "internally — the application never holds OpenAI API keys directly.",
        S["BodyText"]
    ))

    story.append(Paragraph("5.2 Replit's Data Privacy Terms", S["SubHeader"]))
    replit_items = [
        "<b>Paid endpoints:</b> Training is disabled — your data is NOT used for model training by the AI provider.",
        "<b>Logging:</b> Input/output logging is disabled by default on Replit's AI integrations.",
        "<b>SOC 2 Type 2 certified:</b> Replit maintains SOC 2 Type 2 certification for its security controls.",
        "<b>GDPR compliant:</b> Replit's Data Processing Agreement (DPA) incorporates EU Standard Contractual Clauses.",
        "<b>Data not sold:</b> Replit's privacy policy explicitly states they do not sell customer personal data (CCPA definition).",
        "<b>Subprocessors:</b> Replit uses subprocessors including Google Cloud Platform, OpenAI, Anthropic, Stripe, Cloudflare, and Datadog. A full list is maintained at replit.com/subprocessors.",
    ]
    for item in replit_items:
        story.append(Paragraph(f"\u2022 {item}", S["BulletItem"]))

    story.append(Paragraph("5.3 Enterprise Tier Protections", S["SubHeader"]))
    story.append(Paragraph(
        "Replit's Enterprise tier offers additional protections:",
        S["BodyText"]
    ))
    ent_items = [
        "<b>Zero Data Retention endpoints only</b> — requests only routed to endpoints that do NOT retain any data",
        "<b>AI Integrations disabled by default</b> — admins control from organization settings",
        "<b>Data Processing Agreement</b> with breach notification requirements",
        "<b>Data retention limits:</b> Up to 90 days for return after termination; deletion within 180 days",
    ]
    for item in ent_items:
        story.append(Paragraph(f"\u2022 {item}", S["BulletItem"]))

    story.append(Spacer(1, 8))
    story.append(Paragraph(
        "<b>Important:</b> Replit's privacy protections apply to Replit's handling of your data. Once data is "
        "forwarded to OpenAI through the proxy, OpenAI's own data policies (Section 4) govern how that data "
        "is handled on their end. Replit does not control OpenAI's retention or abuse monitoring policies.",
        S["AlertText"]
    ))
    story.append(Paragraph(
        "Sources: Replit Privacy Policy — https://replit.com/privacy-policy | "
        "Replit DPA — https://replit.com/dpa | Replit Subprocessors — https://replit.com/subprocessors",
        S["FooterNote"]
    ))
    story.append(PageBreak())

    # ── 6. RISK ASSESSMENT ──
    story.append(Paragraph("6. Risk Assessment Matrix", S["SectionHeader"]))
    story.append(hr())

    story.append(make_table(
        ["Risk", "Likelihood", "Impact", "Current Mitigation", "Residual Risk"],
        [
            ["OpenAI uses data for training", "Very Low (opt-out by default since Mar 2023)", "High", "API T&Cs prohibit training", "Low"],
            ["Data retained for 30 days on OpenAI servers", "Certain (default policy)", "Medium-High", "None currently", "Medium-High"],
            ["Legal hold extends retention beyond 30 days", "Low (precedent exists from 2025)", "High", "None currently", "Medium"],
            ["OpenAI employee accesses data during abuse review", "Very Low", "High", "OpenAI access controls", "Low-Medium"],
            ["Data breach at OpenAI or Replit", "Very Low", "Critical", "SOC 2 certifications", "Low"],
            ["Replit proxy logs/stores data in transit", "Low (logging disabled by default)", "Medium", "Replit privacy policy", "Low"],
            ["Competitor gains access to bid pricing or designs", "Very Low", "Critical", "API T&Cs, encryption in transit", "Low-Medium"],
            ["Regulatory non-compliance (NDA/contractual)", "Medium (depends on contract terms)", "High", "None — requires review", "Medium-High"],
        ],
        col_widths=[1.5*inch, 1.1*inch, 0.8*inch, 1.5*inch, 1.0*inch]
    ))
    story.append(PageBreak())

    # ── 7. SOLUTION 1: ZDR ──
    story.append(Paragraph("7. Solution 1: OpenAI Zero Data Retention (ZDR)", S["SectionHeader"]))
    story.append(hr())
    story.append(Paragraph("<b>Difficulty: Low | Cost: Free | Timeline: 2–4 weeks (approval process)</b>", S["InfoBox"]))

    story.append(Paragraph("Overview", S["SubHeader"]))
    story.append(Paragraph(
        "Apply for OpenAI's Zero Data Retention (ZDR) or Modified Abuse Monitoring (MAM) program. This eliminates "
        "the 30-day data retention window and prevents any storage of your API inputs and outputs on OpenAI's servers.",
        S["BodyText"]
    ))

    story.append(Paragraph("Step-by-Step Implementation", S["SubHeader"]))
    steps = [
        "<b>Step 1:</b> Contact OpenAI's sales team at sales@openai.com to inquire about ZDR/MAM eligibility. Explain the use case: construction document management with sensitive trade secrets and proprietary engineering data.",
        "<b>Step 2:</b> Prepare a business justification document outlining: (a) the nature of sensitive data processed, (b) contractual obligations (NDAs, client confidentiality), (c) regulatory requirements if applicable.",
        "<b>Step 3:</b> Complete OpenAI's ZDR application process. Accept the additional terms, including the requirement to self-moderate for abuse (since OpenAI will no longer review your data).",
        "<b>Step 4:</b> Once approved, enable ZDR in your OpenAI organization settings: Settings → Organization → Data controls → Data Retention tab.",
        "<b>Step 5:</b> Choose whether to apply ZDR at the organization level or per-project. For ConstructAI, organization-level is recommended.",
        "<b>Step 6:</b> Verify ZDR is active by checking the organization settings dashboard. Test with a sample API call and confirm no data appears in usage logs.",
    ]
    for step in steps:
        story.append(Paragraph(step, S["BulletItem"]))

    story.append(Paragraph("Limitations", S["SubHeader"]))
    lims = [
        "ZDR disables extended prompt caching — may slightly increase API costs",
        "ZDR disables Responses API background mode",
        "Does NOT address data in transit (mitigated by TLS encryption)",
        "Does NOT address Replit's handling of data in the proxy layer",
        "Approval process can take 2–4 weeks and is not guaranteed",
    ]
    for lim in lims:
        story.append(Paragraph(f"\u2022 {lim}", S["BulletItem"]))

    story.append(Paragraph(
        "<b>Verdict:</b> ZDR is the lowest-effort, highest-impact solution for reducing data retention risk. "
        "It should be pursued immediately regardless of which other solutions are also implemented.",
        S["InfoBox"]
    ))
    story.append(PageBreak())

    # ── 8. SOLUTION 2: SELF-HOSTED LLM ──
    story.append(Paragraph("8. Solution 2: Self-Hosted Open-Source LLM", S["SectionHeader"]))
    story.append(hr())
    story.append(Paragraph("<b>Difficulty: High | Cost: $500–$5,000/month | Timeline: 4–8 weeks</b>", S["InfoBox"]))

    story.append(Paragraph("Overview", S["SubHeader"]))
    story.append(Paragraph(
        "Replace OpenAI's GPT-4o with a self-hosted open-source model for all AI operations. No data ever leaves "
        "your infrastructure. This is the only solution that provides complete data sovereignty.",
        S["BodyText"]
    ))

    story.append(Paragraph("Text-Only Tasks (Chat, Reranking, Reformulation)", S["SubSubHeader"]))
    story.append(Paragraph(
        "These tasks can be handled by open-source models with acceptable quality:",
        S["BodyText"]
    ))
    story.append(make_table(
        ["Model", "Parameters", "VRAM Required", "Quality vs GPT-4o", "Best For"],
        [
            ["Llama 3.1 70B", "70B", "40+ GB", "~85–90%", "Best balance of quality and size"],
            ["Llama 3.1 8B", "8B", "8 GB", "~70–75%", "Low resource environments"],
            ["Mistral Large 2", "123B", "80+ GB", "~90–95%", "Highest quality open-source"],
            ["Qwen 2.5 72B", "72B", "40+ GB", "~88–92%", "Strong multilingual + reasoning"],
            ["Phi-3 Medium", "14B", "16 GB", "~75–80%", "Good quality/resource ratio"],
        ],
        col_widths=[1.3*inch, 0.9*inch, 1.1*inch, 1.2*inch, 1.6*inch]
    ))

    story.append(Paragraph("Vision Tasks (Drawing Extraction)", S["SubSubHeader"]))
    story.append(Paragraph(
        "Vision extraction of dense construction drawings is the most demanding task. Open-source vision models exist "
        "but have significant limitations for this use case:",
        S["BodyText"]
    ))
    story.append(make_table(
        ["Model", "VRAM Required", "Quality vs GPT-4o Vision", "Key Limitation"],
        [
            ["LLaVA-NeXT 72B", "48+ GB", "~65–75%", "Struggles with dense tables and fine text"],
            ["InternVL2 76B", "48+ GB", "~70–80%", "Better at OCR but weaker on structured extraction"],
            ["Qwen-VL-Max", "48+ GB", "~75–85%", "Competitive but requires significant VRAM"],
            ["Pixtral Large", "124B", "~80–85%", "Strong but extreme resource requirements"],
        ],
        col_widths=[1.4*inch, 1.2*inch, 1.5*inch, 2.2*inch]
    ))
    story.append(Spacer(1, 8))
    story.append(Paragraph(
        "<b>CRITICAL WARNING:</b> For construction documents where lives and millions of dollars are at stake, "
        "a 15–35% reduction in vision extraction accuracy is unacceptable. Misread pipe diameters, incorrect "
        "quantities, or missed specifications could lead to construction errors with severe consequences. "
        "Self-hosted vision models should only be deployed after extensive validation against your actual documents.",
        S["AlertText"]
    ))

    story.append(Paragraph("Step-by-Step Implementation", S["SubHeader"]))
    steps2 = [
        "<b>Step 1: Provision GPU infrastructure.</b> Options: (a) Cloud GPU — AWS p4d.24xlarge ($32/hr) or Google Cloud a2-ultragpu-1g ($31/hr), (b) Dedicated GPU server — NVIDIA A100 80GB (~$2,500/month lease), (c) On-premise — Purchase NVIDIA A100 or H100 ($15,000–$30,000 per card).",
        "<b>Step 2: Install model serving infrastructure.</b> Deploy vLLM or llama.cpp as the model server. vLLM provides the best throughput for production workloads. Install with: pip install vllm, then run: python -m vllm.entrypoints.openai.api_server --model meta-llama/Llama-3.1-70B-Instruct --port 8000",
        "<b>Step 3: Download and configure models.</b> For text: Download Llama 3.1 70B Instruct (requires Meta license agreement). For vision: Download InternVL2 or Qwen-VL-Max. Total disk space needed: ~200 GB for both models.",
        "<b>Step 4: Update ConstructAI configuration.</b> Change the OpenAI base URL and API key environment variables to point to your local vLLM server. The API is OpenAI-compatible, so no code changes are needed for chat/reranking. Vision extraction may require prompt adjustments for the specific model.",
        "<b>Step 5: Validate extraction accuracy.</b> Re-extract at least 5 representative documents (drawings with tables, specifications, financials) and compare output quality against the existing GPT-4o extractions. Document all discrepancies. Do NOT deploy to production until accuracy meets or exceeds a defined threshold.",
        "<b>Step 6: Load test the system.</b> Simulate concurrent users asking questions while documents are being extracted. Monitor GPU utilization, response times, and error rates. Open-source models are typically 3–10x slower than GPT-4o API for equivalent quality.",
        "<b>Step 7: Set up monitoring and fallback.</b> Implement health checks for the model server. Configure automatic fallback to OpenAI API if the local model server goes down (optional, depends on privacy requirements).",
    ]
    for step in steps2:
        story.append(Paragraph(step, S["BulletItem"]))
    story.append(PageBreak())

    # ── 9. SOLUTION 3: HYBRID ──
    story.append(Paragraph("9. Solution 3: Hybrid Architecture (Recommended)", S["SectionHeader"]))
    story.append(hr())
    story.append(Paragraph("<b>Difficulty: Medium | Cost: $200–$1,000/month | Timeline: 3–5 weeks</b>", S["InfoBox"]))

    story.append(Paragraph("Overview", S["SubHeader"]))
    story.append(Paragraph(
        "This approach combines the strengths of both external and self-hosted models by routing different "
        "tasks to different providers based on sensitivity and quality requirements:",
        S["BodyText"]
    ))

    story.append(make_table(
        ["Task", "Provider", "Rationale"],
        [
            ["Text embeddings", "Local ONNX (current)", "Already self-hosted, no changes needed"],
            ["Chat answering", "Self-hosted Llama 3.1 70B", "Highest frequency of data exposure; text-only task"],
            ["Reranking", "Self-hosted Llama 3.1 70B", "Text-only task, simpler than chat"],
            ["Query reformulation", "Self-hosted Llama 3.1 70B", "Text-only task, simple generation"],
            ["Vision extraction", "OpenAI GPT-4o with ZDR", "One-time per document; accuracy is critical; no viable local alternative"],
        ],
        col_widths=[1.4*inch, 1.8*inch, 3.0*inch]
    ))

    story.append(Spacer(1, 8))
    story.append(Paragraph(
        "This architecture eliminates the ongoing data exposure from chat (which transmits document chunks on every "
        "question) while preserving the critical accuracy of vision extraction for construction drawings. The only "
        "data that reaches OpenAI is the initial drawing images during upload — a one-time, controlled operation.",
        S["BodyText"]
    ))

    story.append(Paragraph("Step-by-Step Implementation", S["SubHeader"]))
    hybrid_steps = [
        "<b>Step 1: Apply for OpenAI ZDR</b> (see Solution 1). This protects the vision extraction data that must still go to OpenAI.",
        "<b>Step 2: Provision a GPU server</b> for the text-only model. A single NVIDIA A100 40GB or equivalent is sufficient for Llama 3.1 70B quantized (GPTQ/AWQ 4-bit). Cloud cost: ~$1–2/hr on demand, ~$500/month reserved.",
        "<b>Step 3: Deploy vLLM</b> with the Llama 3.1 70B Instruct model. Configure it to expose an OpenAI-compatible API endpoint.",
        "<b>Step 4: Create a routing layer</b> in the ConstructAI API server. Modify the existing OpenAI client initialization to use two clients: one pointing to the local model (for chat, reranking, reformulation) and one pointing to OpenAI (for vision extraction only).",
        "<b>Step 5: Update system prompts.</b> The local model may require slightly different prompt formatting. Test the existing system prompt with the local model and adjust if answer quality differs significantly.",
        "<b>Step 6: Validate chat quality.</b> Run a test suite of questions against both the local model and GPT-4o using the same document chunks. Compare answer accuracy, confidence scores, and source citation quality. Target: local model answers should match GPT-4o on 90%+ of test questions.",
        "<b>Step 7: Deploy and monitor.</b> Roll out gradually — start with one project, compare answer quality for a week, then expand to all projects.",
    ]
    for step in hybrid_steps:
        story.append(Paragraph(step, S["BulletItem"]))

    story.append(Paragraph(
        "<b>Verdict:</b> This is the recommended solution. It reduces the ongoing data exposure by ~95% (chat is the "
        "highest-frequency external call) while maintaining critical accuracy for vision extraction. Combined with "
        "ZDR for the remaining OpenAI calls, this provides a strong privacy posture.",
        S["InfoBox"]
    ))
    story.append(PageBreak())

    # ── 10. SOLUTION 4: AIR-GAPPED ──
    story.append(Paragraph("10. Solution 4: Air-Gapped Deployment", S["SectionHeader"]))
    story.append(hr())
    story.append(Paragraph("<b>Difficulty: Very High | Cost: $3,000–$10,000/month | Timeline: 8–16 weeks</b>", S["InfoBox"]))

    story.append(Paragraph("Overview", S["SubHeader"]))
    story.append(Paragraph(
        "For the highest level of data sovereignty, deploy the entire ConstructAI system on isolated infrastructure "
        "with no external network access. All AI models run locally, and no data ever leaves the network.",
        S["BodyText"]
    ))

    story.append(Paragraph("Requirements", S["SubHeader"]))
    air_items = [
        "<b>Hardware:</b> Minimum 2x NVIDIA A100 80GB GPUs (one for text model, one for vision model). Recommended: NVIDIA H100 for better performance. Total hardware cost: $30,000–$60,000 purchase or $3,000–$6,000/month lease.",
        "<b>Infrastructure:</b> Dedicated server(s) with 256 GB RAM, 2 TB NVMe storage, Ubuntu Server 22.04 LTS, NVIDIA drivers and CUDA toolkit.",
        "<b>Model selection:</b> Best available open-source vision model (currently InternVL2 76B or Pixtral Large) plus Llama 3.1 70B for text tasks.",
        "<b>Accuracy tradeoff:</b> Vision extraction accuracy will be 15–35% lower than GPT-4o. This means more extraction errors in construction drawings, which requires manual review processes.",
        "<b>Operational overhead:</b> Requires in-house ML operations expertise for model updates, GPU monitoring, performance optimization, and troubleshooting.",
    ]
    for item in air_items:
        story.append(Paragraph(f"\u2022 {item}", S["BulletItem"]))

    story.append(Paragraph(
        "<b>WARNING:</b> An air-gapped deployment with current open-source vision models will produce lower-quality "
        "extraction results for construction drawings. In a system where \"millions of dollars and lives are at stake,\" "
        "this accuracy reduction introduces its own form of risk. Every extraction should be manually verified until "
        "open-source vision models close the quality gap with GPT-4o.",
        S["AlertText"]
    ))
    story.append(PageBreak())

    # ── 11. IMPLEMENTATION ROADMAP ──
    story.append(Paragraph("11. Implementation Roadmap", S["SectionHeader"]))
    story.append(hr())

    story.append(Paragraph("Phase 1: Immediate (Week 1–2)", S["SubHeader"]))
    p1 = [
        "Apply for OpenAI Zero Data Retention (ZDR). This is free, requires no code changes, and provides the most impactful privacy improvement.",
        "Review all existing NDAs and client contracts for AI/cloud processing restrictions. Identify any contracts that explicitly prohibit sending data to third-party AI providers.",
        "Document which projects contain the most sensitive data. Prioritize these for local model migration.",
    ]
    for item in p1:
        story.append(Paragraph(f"\u2022 {item}", S["BulletItem"]))

    story.append(Paragraph("Phase 2: Short-Term (Week 3–5)", S["SubHeader"]))
    p2 = [
        "Provision GPU infrastructure (cloud or dedicated server).",
        "Deploy Llama 3.1 70B for text-only tasks (chat, reranking, reformulation).",
        "Implement the routing layer in the API server to direct text tasks to the local model.",
        "Run parallel testing: same questions answered by both local model and GPT-4o. Compare quality.",
    ]
    for item in p2:
        story.append(Paragraph(f"\u2022 {item}", S["BulletItem"]))

    story.append(Paragraph("Phase 3: Medium-Term (Week 6–10)", S["SubHeader"]))
    p3 = [
        "Roll out local model for chat to all projects (after validation).",
        "Monitor answer quality and user satisfaction. Adjust system prompts if needed.",
        "Evaluate emerging open-source vision models quarterly for potential vision migration.",
        "Implement automated quality benchmarking: compare local model answers against GPT-4o baseline on a rotating test set.",
    ]
    for item in p3:
        story.append(Paragraph(f"\u2022 {item}", S["BulletItem"]))

    story.append(Paragraph("Phase 4: Long-Term (Ongoing)", S["SubHeader"]))
    p4 = [
        "Re-evaluate vision model landscape every 6 months. Open-source multimodal models are improving rapidly.",
        "When an open-source vision model achieves 95%+ accuracy vs GPT-4o on construction drawings, plan migration of vision extraction to fully local.",
        "Consider air-gapped deployment if regulatory requirements change or client contracts demand it.",
    ]
    for item in p4:
        story.append(Paragraph(f"\u2022 {item}", S["BulletItem"]))
    story.append(PageBreak())

    # ── 12. COST-BENEFIT ──
    story.append(Paragraph("12. Cost-Benefit Analysis", S["SectionHeader"]))
    story.append(hr())

    story.append(make_table(
        ["Solution", "Monthly Cost", "Privacy Level", "Accuracy Impact", "Complexity", "Recommended?"],
        [
            ["Current (no changes)", "$50–200 (API usage)", "Standard API retention (30 days)", "Baseline (100%)", "None", "No"],
            ["Solution 1: ZDR Only", "$50–200 (same API)", "Zero retention at OpenAI", "No impact (100%)", "Low", "Yes (immediate)"],
            ["Solution 3: Hybrid + ZDR", "$500–1,200 (GPU + API)", "Local for chat; ZDR for vision", "~90% for chat; 100% for vision", "Medium", "Yes (recommended)"],
            ["Solution 2: Fully Self-Hosted", "$500–5,000 (GPU only)", "Complete sovereignty", "~70–85% for vision", "High", "Conditional"],
            ["Solution 4: Air-Gapped", "$3,000–10,000", "Maximum (no network)", "~65–85% for vision", "Very High", "Only if required"],
        ],
        col_widths=[1.2*inch, 1.0*inch, 1.2*inch, 1.1*inch, 0.8*inch, 1.0*inch]
    ))
    story.append(PageBreak())

    # ── 13. RECOMMENDATIONS ──
    story.append(Paragraph("13. Recommendations &amp; Next Steps", S["SectionHeader"]))
    story.append(hr())

    story.append(Paragraph(
        "Based on the analysis in this whitepaper, the following actions are recommended:",
        S["BodyText"]
    ))

    story.append(Paragraph("Immediate Action Items", S["SubHeader"]))
    rec1 = [
        "<b>Apply for OpenAI ZDR immediately.</b> This is free, requires no code changes, and eliminates the 30-day data retention risk. There is no reason not to pursue this.",
        "<b>Conduct a contract audit.</b> Review all active project contracts for clauses related to AI processing, cloud storage, data sovereignty, or third-party data sharing. Identify any projects that are non-compliant under current architecture.",
        "<b>Brief project managers.</b> Ensure all users understand that questions they ask and the document excerpts used to answer them are currently transmitted to OpenAI's servers (retained up to 30 days unless ZDR is approved).",
    ]
    for item in rec1:
        story.append(Paragraph(f"\u2022 {item}", S["BulletItem"]))

    story.append(Paragraph("Short-Term Recommendation", S["SubHeader"]))
    story.append(Paragraph(
        "Implement the <b>Hybrid Architecture (Solution 3)</b> combined with ZDR. This provides the best balance of "
        "privacy, accuracy, and cost. The chat system — which is the most frequent source of data exposure — moves "
        "fully local, while the critical vision extraction (which runs only once per document) remains on GPT-4o "
        "with zero retention.",
        S["BodyText"]
    ))

    story.append(Paragraph("Long-Term Recommendation", S["SubHeader"]))
    story.append(Paragraph(
        "Monitor the open-source multimodal model landscape. The gap between open-source vision models and GPT-4o "
        "is closing rapidly. When an open-source model achieves reliable 95%+ accuracy on dense construction drawings "
        "(estimated timeline: 12–24 months based on current trajectory), migrate vision extraction to fully local "
        "and achieve complete data sovereignty with no external dependencies.",
        S["BodyText"]
    ))

    story.append(Spacer(1, 0.5*inch))
    story.append(hr())
    story.append(Spacer(1, 0.3*inch))
    story.append(Paragraph(
        "This whitepaper was prepared for internal stakeholder review. The analysis reflects the state of "
        "OpenAI and Replit terms of service as of March 2026. Terms and policies may change — stakeholders "
        "should verify current terms before making compliance decisions.",
        S["FooterNote"]
    ))
    story.append(Spacer(1, 0.2*inch))
    story.append(Paragraph("End of Document", S["FooterNote"]))

    doc.build(story)
    print(f"Whitepaper generated: {OUTPUT_PATH}")


if __name__ == "__main__":
    build_document()
