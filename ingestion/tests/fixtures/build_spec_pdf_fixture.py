"""Synthetic look-alikes of a customer specification PDF: a cover page with a confidentiality notice, a revision history, a
table of contents with dot leaders and page numbers, an abbreviations table, numbered requirement sections with multi-line
requirements, and a running header and footer. Each shape can be switched on alone, so a failure is traced to one shape.

`build_spec_pdf(out_dir, variant)` writes the PDF and returns (path, truth). `truth` lists the front-matter texts that must
never become items and the requirement texts that must each become exactly one item."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

DOC_TITLE = "Power Distribution Unit Specification"
NOTICE = (
    "This document contains proprietary information of Acme Systems Ltd. It shall not be reproduced, disclosed or used "
    "without the prior written permission of Acme Systems Ltd."
)
HEADER_LINES = ("ACME SYSTEMS LTD", "PDU-SPEC-0042 Rev 2.0")
FOOTER_LINES = ("Acme Proprietary - Do not distribute", "Company confidential information")

REVISIONS = [
    ["Rev", "Date", "Description", "Author"],
    ["1.0", "2024-01-10", "Initial release of the specification.", "J. Doe"],
    ["2.0", "2024-06-02", "Added thermal requirements and updated power rails.", "A. Roe"],
]
ABBREVIATIONS = [
    ["Abbreviation", "Meaning"],
    ["PDU", "Power Distribution Unit"],
    ["BIT", "Built-In Test"],
    ["EMI", "Electromagnetic Interference"],
]

# (number, title, [(requirement id or None, text)]) -- a section with no requirements is prose only.
SECTIONS: list[tuple[str, str, list[tuple[str | None, str]]]] = [
    ("1", "Introduction", []),
    ("1.1", "Scope", []),
    ("2", "Power Requirements", []),
    (
        "2.1",
        "Input Power",
        [
            (
                "REQ-001",
                "The PDU shall accept an input voltage between 18 VDC and 32 VDC across the full operating "
                "temperature range without degradation of any output rail.",
            ),
            (
                "REQ-002",
                "The PDU shall withstand an input transient of 80 V for 100 ms without damage and shall resume "
                "normal operation within 50 ms after the transient ends.",
            ),
            (
                "REQ-003",
                "The PDU shall protect itself against reverse input polarity of up to 32 VDC indefinitely.",
            ),
        ],
    ),
    (
        "2.2",
        "Output Rails",
        [
            (
                "REQ-004",
                "The PDU shall provide a 12 V output rail with a regulation accuracy of plus or minus two "
                "percent at all loads between ten percent and full load.",
            ),
            (
                "REQ-005",
                "The PDU shall provide a 5 V output rail rated for a continuous current of 8 A.",
            ),
        ],
    ),
    ("3", "Built-In Test", []),
    (
        "3.1",
        "Power-Up Test",
        [
            (
                "REQ-006",
                "The PDU shall execute a power-up built-in test within 2 seconds of input power being applied.",
            ),
            (
                "REQ-007",
                "The PDU shall report each built-in test failure to the host over the maintenance bus with a "
                "unique fault code and a time stamp.",
            ),
        ],
    ),
]
PROSE = {
    "1": "This section introduces the power distribution unit.",
    "1.1": "This specification defines the requirements of the power distribution unit used in the vehicle.",
    "2": "This section states the power requirements.",
    "3": "This section states the built-in test requirements.",
}
TOC_PAGES = {"1": 4, "1.1": 4, "2": 4, "2.1": 4, "2.2": 5, "3": 5, "3.1": 5}


@dataclass(frozen=True)
class Variant:
    name: str
    cover: bool = False
    running_header_footer: bool = False
    revision_history: bool = False
    toc: str | None = (
        None  # None | "loose" (one paragraph per line) | "tight" (lines close enough to merge)
    )
    abbreviations: bool = False
    tight_requirements: bool = False  # requirements set with no space between them
    id_prefix: bool = True  # "REQ-001: The PDU shall ..." vs "The PDU shall ..."


VARIANTS: dict[str, Variant] = {
    v.name: v
    for v in [
        Variant("plain"),
        Variant("cover", cover=True),
        Variant("header_footer", running_header_footer=True),
        Variant("revision_history", revision_history=True),
        Variant("toc_loose", toc="loose"),
        Variant("toc_tight", toc="tight"),
        Variant("abbreviations", abbreviations=True),
        Variant("no_id", id_prefix=False),
        Variant("tight_requirements", tight_requirements=True),
        Variant("tight_requirements_no_id", tight_requirements=True, id_prefix=False),
        Variant(
            "all_together",
            cover=True,
            running_header_footer=True,
            revision_history=True,
            toc="loose",
            abbreviations=True,
            tight_requirements=True,
        ),
    ]
}


@dataclass
class Truth:
    front_matter: list[str] = field(
        default_factory=list
    )  # texts that must never appear as an item or inside one
    requirements: list[str] = field(default_factory=list)  # each must be exactly one item
    section_titles: list[str] = field(default_factory=list)  # the real sections, "2.1 Input Power"


def requirement_text(req_id: str | None, text: str, id_prefix: bool) -> str:
    return f"{req_id}: {text}" if req_id and id_prefix else text


def build_spec_pdf(out_dir: Path, variant: Variant | str) -> tuple[Path, Truth]:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.platypus import (
        PageBreak,
        Paragraph,
        SimpleDocTemplate,
        Spacer,
        Table,
        TableStyle,
    )

    v = VARIANTS[variant] if isinstance(variant, str) else variant
    styles = getSampleStyleSheet()
    body = styles["BodyText"]
    tight = ParagraphStyle("Tight", parent=body, spaceBefore=0, spaceAfter=0, leading=11)
    toc_style = (
        ParagraphStyle("TocTight", parent=body, spaceBefore=0, spaceAfter=0, leading=11)
        if v.toc == "tight"
        else ParagraphStyle("TocLoose", parent=body, spaceBefore=4, spaceAfter=4)
    )
    grid = TableStyle([("GRID", (0, 0), (-1, -1), 0.5, colors.black)])
    truth = Truth()
    flow: list = []

    if v.cover:
        flow += [
            Spacer(1, 120),
            Paragraph(DOC_TITLE, styles["Title"]),
            Paragraph("Document number PDU-SPEC-0042, Revision 2.0", body),
            Spacer(1, 200),
            Paragraph(NOTICE, body),
            PageBreak(),
        ]
        truth.front_matter += [NOTICE, "Document number PDU-SPEC-0042"]
    if v.revision_history:
        flow += [
            Paragraph("Revision History", styles["Heading1"]),
            Table(REVISIONS, style=grid),
            Spacer(1, 12),
        ]
        truth.front_matter += [
            "Initial release of the specification.",
            "Added thermal requirements",
        ]
    if v.toc:
        flow.append(Paragraph("Table of Contents", styles["Heading1"]))
        for number, title, _ in SECTIONS:
            indent = "&nbsp;" * 4 * number.count(".")
            dots = "." * (60 - len(number) - len(title) - 4 * number.count("."))
            flow.append(
                Paragraph(f"{indent}{number} {title} {dots} {TOC_PAGES[number]}", toc_style)
            )
        truth.front_matter += [f"{title} ....." for _, title, _ in SECTIONS]
    if v.abbreviations:
        flow += [Paragraph("Abbreviations", styles["Heading1"]), Table(ABBREVIATIONS, style=grid)]
        truth.front_matter += ["Electromagnetic Interference"]
    if v.revision_history or v.toc or v.abbreviations:
        flow.append(PageBreak())

    for number, title, requirements in SECTIONS:
        level = number.count(".") + 1
        if level == 1 and number != "1":
            flow.append(
                PageBreak()
            )  # each top-level section starts a page, so running headers recur
        flow.append(Paragraph(f"{number} {title}", styles[f"Heading{level}"]))
        truth.section_titles.append(f"{number} {title}")
        if number in PROSE:
            flow.append(Paragraph(PROSE[number], body))
        for req_id, text in requirements:
            shown = requirement_text(req_id, text, v.id_prefix)
            flow.append(Paragraph(shown, tight if v.tight_requirements else body))
            truth.requirements.append(shown)

    def on_page(canvas, doc) -> None:
        if not v.running_header_footer or (v.cover and doc.page == 1):
            return
        canvas.saveState()
        canvas.setFont("Helvetica", 8)
        canvas.drawString(72, 805, HEADER_LINES[0])
        canvas.drawString(72, 795, HEADER_LINES[1])
        canvas.drawString(72, 40, FOOTER_LINES[0])
        canvas.drawString(72, 30, FOOTER_LINES[1])
        canvas.drawRightString(523, 30, f"Page {doc.page}")
        canvas.restoreState()

    if v.running_header_footer:
        truth.front_matter += [*HEADER_LINES, *FOOTER_LINES]

    path = Path(out_dir) / f"spec_{v.name}.pdf"
    SimpleDocTemplate(str(path), pagesize=A4, title=DOC_TITLE).build(
        flow, onFirstPage=on_page, onLaterPages=on_page
    )
    return path, truth


if __name__ == "__main__":
    import sys

    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent
    for name in VARIANTS:
        print(build_spec_pdf(target, name)[0])
