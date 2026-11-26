"""The TV twin as a Word document: the same SECTIONS as build_tv_twin_pdf.py, laid out the way a requirements tool exports to Word.

- headings use the Heading 1-4 styles, numbered by Word's own multilevel list linked to those styles: the numbers are not typed in the text;
- the page header holds the company logo, the document type and the label/value grid, and the confidentiality notice;
- the cover carries a CONFIDENTIAL stamp line beside the title, a notice and the export stamp, then a typed contents list;
- each requirement starts with its code in a hanging-indent column (code, tab, text); lists, Notes and the trace ("Satisfies:" and one
  parent code per line) follow it; one requirement has no code; coded sub-items (``men_3.a``) are their own paragraphs;
- revision history, references and abbreviations are tables (front matter), and the requirement identities are a table (back matter).

``build_tv_twin_docx(out_dir)`` writes tv_twin_spec.docx and returns ``(path, truth)``, the same truth as the PDF.
tv_twin_spec.doc (Word 97-2003) is this file converted by LibreOffice; regenerate it with `python build_tv_twin_docx.py --doc` where
`soffice` is installed (the ingestion image has it)."""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
from pathlib import Path

from build_tv_twin_pdf import (
    ABBREVIATIONS,
    COMPANY,
    COVER_NOTICE,
    DATE,
    DEFINITIONS,
    DOC_ID,
    DOC_TYPE,
    GENERATION_STAMP,
    ISSUE,
    LOGO,
    MARGIN_NOTICE,
    REFERENCES,
    SECTIONS,
    TRACE_LABEL,
    Req,
    Section,
    TwinTruth,
    twin_truth,
)

_HEADING_NUM_ID = 90  # far above the ids the default template's numbering part already uses


def _add_heading_numbering(document) -> None:  # noqa: ANN001
    """A multilevel list (1, 1.1, 1.1.1, 1.1.1.1) linked to Heading 1-4, so Word numbers the headings itself."""
    from docx.oxml import parse_xml
    from docx.oxml.ns import nsdecls, qn

    numbering = document.part.numbering_part.element
    levels = "".join(
        f'<w:lvl w:ilvl="{i}"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:pStyle w:val="Heading{i + 1}"/>'
        f'<w:lvlText w:val="{".".join(f"%{k + 1}" for k in range(i + 1))}"/><w:lvlJc w:val="left"/>'
        f'<w:pPr><w:ind w:left="{720 + 360 * i}" w:hanging="{720 + 360 * i}"/></w:pPr></w:lvl>'
        for i in range(4)
    )
    abstract = parse_xml(
        f'<w:abstractNum {nsdecls("w")} w:abstractNumId="{_HEADING_NUM_ID}"><w:multiLevelType w:val="multilevel"/>{levels}</w:abstractNum>'
    )
    first_num = numbering.find(qn("w:num"))
    if first_num is not None:
        first_num.addprevious(abstract)  # every abstractNum must come before the first num
    else:
        numbering.append(abstract)
    numbering.append(
        parse_xml(
            f'<w:num {nsdecls("w")} w:numId="{_HEADING_NUM_ID}"><w:abstractNumId w:val="{_HEADING_NUM_ID}"/></w:num>'
        )
    )
    for level in range(1, 5):
        ppr = document.styles[f"Heading {level}"].element.get_or_add_pPr()
        ppr.insert(
            0,
            parse_xml(
                f'<w:numPr {nsdecls("w")}><w:ilvl w:val="{level - 1}"/><w:numId w:val="{_HEADING_NUM_ID}"/></w:numPr>'
            ),
        )


def _runs(paragraph, text: str) -> None:  # noqa: ANN001
    """The PDF builder's inline markup: "<i>...</i>" is italics. "<br/>" is where the PDF breaks a line inside a word ("Over-<br/>The-Air");
    Word wraps lines itself, so the text is joined there, as Req.plain reads it. A "|" (a page break in the PDF) is handled by the caller."""
    for j, part in enumerate(re.split(r"</?i>", text.replace("<br/>", ""))):
        if part:
            paragraph.add_run(part).italic = bool(j % 2)


def _hanging(paragraph, left_twips: int = 1440, hanging_twips: int = 1440) -> None:  # noqa: ANN001
    from docx.shared import Twips

    fmt = paragraph.paragraph_format
    fmt.left_indent = Twips(left_twips)
    fmt.first_line_indent = Twips(-hanging_twips)


def _indent(paragraph, left_twips: int = 1440) -> None:  # noqa: ANN001
    from docx.shared import Twips

    paragraph.paragraph_format.left_indent = Twips(left_twips)


def _table(document, rows: list[list[str]]) -> None:  # noqa: ANN001
    table = document.add_table(rows=0, cols=len(rows[0]))
    table.style = "Table Grid"
    for row in rows:
        cells = table.add_row().cells
        for cell, value in zip(cells, row):
            cell.text = value


def _page_header(document) -> None:  # noqa: ANN001
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import Inches, Pt

    header = document.sections[0].header
    first = header.paragraphs[0]
    first.add_run().add_picture(LOGO, width=Inches(0.86))
    first.add_run(f"\t{DOC_TYPE}\t").bold = True
    grid = header.add_table(rows=0, cols=3, width=Inches(6.5))
    for row in (
        (("Date", DATE), ("Issue", ISSUE), ("Document ID", DOC_ID)),
        (
            ("Issued by", "Consumer Display Line"),
            ("Classification Company Confidentiality", "FICTIONAL - FOR TESTING ONLY"),
            ("", ""),
        ),
        (
            ("Classification Export Control", "NOT EXPORT CONTROLLED"),
            ("Classification Defence Secrecy", "NOT CLASSIFIED"),
            ("", ""),
        ),
    ):
        cells = grid.add_row().cells
        for cell, (label, value) in zip(cells, row):
            cell.text = ""
            if label:
                cell.paragraphs[0].add_run(label).font.size = Pt(6)
                cell.add_paragraph().add_run(value).font.size = Pt(8)
    notice = header.add_paragraph()
    notice.alignment = WD_ALIGN_PARAGRAPH.LEFT
    notice.add_run(" ".join(MARGIN_NOTICE)).font.size = Pt(6)


def _cover(document) -> None:  # noqa: ANN001
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import Pt, RGBColor

    document.add_paragraph("COMPANY CONFIDENTIAL")
    document.add_paragraph().add_run(COVER_NOTICE).font.size = Pt(8)
    document.add_paragraph().add_run(COMPANY).font.size = Pt(8)
    stamp = document.add_paragraph()
    stamp.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    for text, size in (
        ("CONFIDENTIAL", 15),
        ("  HALVAR ELECTRONICS LTD", 8),
        ("  Ref. 220.3 · Do not copy", 7),
    ):
        run = stamp.add_run(text)
        run.bold, run.font.size, run.font.color.rgb = size > 7, Pt(size), RGBColor(0xC7, 0x1A, 0x1F)
    title = document.add_paragraph().add_run(DOC_TYPE)
    title.bold, title.font.size = True, Pt(16)
    system = document.add_paragraph()
    run = system.add_run("[220.3] Vireo Television")
    run.bold, run.font.size = True, Pt(15)
    run.add_break()
    run = system.add_run("Set (VTS)")
    run.bold, run.font.size = True, Pt(15)
    for text in ("for", "LARK PROGRAMME"):
        document.add_paragraph(text).alignment = WD_ALIGN_PARAGRAPH.CENTER
    document.add_paragraph("Prepared by")
    document.add_paragraph(COMPANY)
    for line in GENERATION_STAMP:
        document.add_paragraph().add_run(line).font.size = Pt(8)
    document.add_page_break()
    contents = document.add_paragraph().add_run("CONTENTS")
    contents.bold, contents.font.size = True, Pt(14)
    page = 3
    for s in SECTIONS:
        level = s.number.count(".") + 1
        if level > 3:
            continue
        page += 1 if s.reqs else 0
        document.add_paragraph(f"{'    ' * (level - 1)}{s.number} {s.title} {'.' * 8} {page}")
    document.add_page_break()


def _requirement(document, r: Req) -> None:  # noqa: ANN001
    first, _, rest = r.text.partition("|")
    paragraph = document.add_paragraph()
    _hanging(paragraph)
    paragraph.add_run(f"{r.code}\t" if r.code else "\t")
    _runs(paragraph, first)
    if rest:
        document.add_page_break()
        more = document.add_paragraph()
        _indent(more)
        _runs(more, rest)
    for i, item in enumerate(r.items):
        if r.items_break_after is not None and i == r.items_break_after:
            document.add_page_break()
        if r.marker:
            bullet = document.add_paragraph(style="List Bullet")
            _indent(bullet, 1800)
            _runs(bullet, item)
        else:
            letter, _, text = item.partition(" ")
            lettered = document.add_paragraph()
            _hanging(lettered, 1800, 360)
            lettered.add_run(f"{letter}\t")
            _runs(lettered, text)
    if r.note:
        note = document.add_paragraph()
        _indent(note)
        _runs(note, r.note)
    if r.parents:
        _indent(document.add_paragraph(TRACE_LABEL))
        for i, parent in enumerate(r.parents):
            if r.parents_break_after is not None and i == r.parents_break_after:
                document.add_page_break()
            _indent(document.add_paragraph(parent))
    if r.full_note:
        _runs(document.add_paragraph(), r.full_note)


def _section(document, s: Section, truth: TwinTruth) -> None:  # noqa: ANN001
    if s.break_before:
        document.add_page_break()
    document.add_paragraph(s.title, style=f"Heading {s.number.count('.') + 1}")
    for sentence in s.prose:
        document.add_paragraph(sentence)
    if s.number == "1.3":
        _table(document, [["Issue", "Date", "Change", "Approved"]])
    elif s.number == "1.4":
        _table(document, [list(r) for r in REFERENCES])
    elif s.number == "1.5":
        _table(document, [list(a) for a in ABBREVIATIONS])
        for d in DEFINITIONS:
            document.add_paragraph(d)
    elif s.number == "3":
        _table(
            document,
            [["Identity in external document", "Identity in this document"]]
            + [["", c] for c in truth.back_matter_codes],
        )
    for r in s.reqs:
        _requirement(document, r)


def build_tv_twin_docx(out_dir: Path) -> tuple[Path, TwinTruth]:
    from docx import Document

    document = Document()
    document.core_properties.title = DOC_TYPE
    _add_heading_numbering(document)
    _page_header(document)
    _cover(document)
    truth = twin_truth()
    for s in SECTIONS:
        _section(document, s, truth)
    path = Path(out_dir) / "tv_twin_spec.docx"
    document.save(str(path))
    return path, truth


def convert_to_doc(docx_path: Path) -> Path:
    """tv_twin_spec.doc beside the .docx, written by LibreOffice (the same converter family the app uses to read a .doc)."""
    soffice = shutil.which("soffice")
    if soffice is None:
        raise SystemExit(
            "soffice (LibreOffice) is not installed; run this where it is, for example in the ingestion image"
        )
    subprocess.run(
        [
            soffice,
            "--headless",
            "--convert-to",
            "doc:MS Word 97",
            "--outdir",
            str(docx_path.parent),
            str(docx_path),
        ],
        check=True,
        timeout=180,
    )
    return docx_path.with_suffix(".doc")


if __name__ == "__main__":
    here = Path(__file__).parent
    built, _ = build_tv_twin_docx(here)
    print(built)
    if "--doc" in sys.argv:
        print(convert_to_doc(built))
