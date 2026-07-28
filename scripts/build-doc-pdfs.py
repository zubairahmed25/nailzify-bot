#!/usr/bin/env python3
"""
Render the source documents in data/documents/*.md to PDFs.

    python3 scripts/build-doc-pdfs.py

⚠️ THE PDFs ARE FOR CUSTOMERS, NOT FOR INGESTION.

The RAG pipeline ingests the MARKDOWN, not these PDFs. Markdown already carries
the structure the chunker splits on (headings) and the table survives intact.
Going markdown -> PDF -> text extraction is a lossy round trip that would
reintroduce exactly the risk docs/03-ingestion.md warns about: a mangled sizing
table is the single most damaging extraction failure in this corpus, because a
wrong millimetre value means nails that do not fit.

So: markdown is the source of truth, these PDFs are a distribution format.
"""

from pathlib import Path
import re

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    ListFlowable,
    ListItem,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "documents"
OUT = SRC / "pdf"

PINK = colors.HexColor("#E8639B")
INK = colors.HexColor("#3F3A3C")
BAND = colors.HexColor("#FDEEF3")

styles = getSampleStyleSheet()
H1 = ParagraphStyle("H1", parent=styles["Title"], fontSize=24, leading=28,
                    textColor=PINK, alignment=TA_LEFT, spaceAfter=14)
H2 = ParagraphStyle("H2", parent=styles["Heading2"], fontSize=13, leading=17,
                    textColor=INK, spaceBefore=14, spaceAfter=6)
BODY = ParagraphStyle("Body", parent=styles["BodyText"], fontSize=10.5,
                      leading=15.5, textColor=INK, spaceAfter=6)
SMALL = ParagraphStyle("Small", parent=BODY, fontSize=8.5, leading=12,
                       textColor=colors.HexColor("#8A8286"))


def inline(text: str) -> str:
    """Markdown emphasis -> ReportLab markup. Escapes XML first."""
    text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    text = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text)
    return re.sub(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)", r"<i>\1</i>", text)


def build_table(rows: list[list[str]]) -> Table:
    data = [[Paragraph(f"<b>{inline(c)}</b>", BODY) for c in rows[0]]]
    data += [[Paragraph(inline(c), BODY) for c in r] for r in rows[1:]]

    table = Table(data, hAlign="LEFT", repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), BAND),
        ("TEXTCOLOR", (0, 0), (-1, 0), PINK),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#F0D4DF")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (1, 0), (-1, -1), "CENTER"),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    return table


def render(md_path: Path, pdf_path: Path) -> None:
    lines = md_path.read_text(encoding="utf-8").splitlines()
    story: list = []
    bullets: list[str] = []
    table_rows: list[list[str]] = []

    def flush_bullets() -> None:
        nonlocal bullets
        if bullets:
            story.append(ListFlowable(
                [ListItem(Paragraph(inline(b), BODY), leftIndent=12) for b in bullets],
                bulletType="bullet", bulletColor=PINK, start="circle", leftIndent=14,
            ))
            story.append(Spacer(1, 4))
            bullets = []

    def flush_table() -> None:
        nonlocal table_rows
        if table_rows:
            story.append(Spacer(1, 4))
            story.append(build_table(table_rows))
            story.append(Spacer(1, 8))
            table_rows = []

    for raw in lines:
        line = raw.rstrip()

        if line.startswith("|"):
            cells = [c.strip() for c in line.strip("|").split("|")]
            # Separator row (|---|---|) carries no data.
            if all(set(c) <= set("-: ") for c in cells):
                continue
            table_rows.append(cells)
            continue
        flush_table()

        if line.startswith("- "):
            bullets.append(line[2:])
            continue
        flush_bullets()

        if line.startswith("# "):
            story.append(Paragraph(inline(line[2:]), H1))
        elif line.startswith("## "):
            story.append(Paragraph(inline(line[3:]), H2))
        elif line.startswith("---"):
            story.append(Spacer(1, 10))
        elif line.startswith("Source:"):
            story.append(Paragraph(inline(line), SMALL))
        elif line:
            story.append(Paragraph(inline(line), BODY))

    flush_bullets()
    flush_table()

    SimpleDocTemplate(
        str(pdf_path), pagesize=A4,
        leftMargin=22 * mm, rightMargin=22 * mm,
        topMargin=20 * mm, bottomMargin=18 * mm,
        title=md_path.stem.replace("-", " ").title(), author="Nailzify",
    ).build(story)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for md in sorted(SRC.glob("*.md")):
        pdf = OUT / f"nailzify-{md.stem}.pdf"
        render(md, pdf)
        print(f"  {md.name}  ->  {pdf.relative_to(ROOT)}  ({pdf.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
