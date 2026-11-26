"""One ground-truth requirements tree (an ADO tree export) written out in every supported input format.

The truth is read from fixtures/ado_tree_export.csv: its 'Work Item Type' and 'Title 1/2/3' columns state each item's type and level, and its
Description cells are HTML. Each builder writes the same items so a scorecard can ask the same question of every format: did every item keep its
type, its parent and its description, and did no markup leak into the text."""

from __future__ import annotations

import csv
import html
import shutil
from collections.abc import Callable
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path

FIXTURE = Path(__file__).parent / "fixtures" / "ado_tree_export.csv"
LADDER = ("Epic", "Feature", "Requirement")


@dataclass(frozen=True)
class TruthItem:
    type: str
    level: int
    title: str
    parent: str | None
    html: str


class _Paragraphs(HTMLParser):
    """HTML -> [(kind, [(text, bold)])], kind 'p' or 'li'."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.paras: list[tuple[str, list[tuple[str, bool]]]] = []
        self.cur: list[tuple[str, bool]] = []
        self.kind = "p"
        self.bold = 0

    def flush(self) -> None:
        if "".join(t for t, _ in self.cur).strip():
            self.paras.append((self.kind, self.cur))
        self.cur = []

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if tag in ("div", "p", "br", "ul", "ol"):
            self.flush()
            self.kind = "p"
        if tag == "li":
            self.flush()
            self.kind = "li"
        if tag in ("b", "strong"):
            self.bold += 1

    def handle_endtag(self, tag: str) -> None:
        if tag in ("div", "p", "li"):
            self.flush()
            self.kind = "p"
        if tag in ("b", "strong"):
            self.bold -= 1

    def handle_data(self, data: str) -> None:
        self.cur.append((data, self.bold > 0))


def paragraphs(markup: str) -> list[tuple[str, list[tuple[str, bool]]]]:
    parser = _Paragraphs()
    parser.feed(markup)
    parser.flush()
    return parser.paras


def to_markdown(markup: str) -> str:
    out = []
    for kind, runs in paragraphs(markup):
        text = "".join(f"**{t.strip()}** " if b and t.strip() else t for t, b in runs).strip()
        out.append(("- " if kind == "li" else "") + text)
    return "\n\n".join(out)


def to_plain(markup: str) -> str:
    return "\n".join(
        ("- " if kind == "li" else "") + "".join(t for t, _ in runs).strip()
        for kind, runs in paragraphs(markup)
    )


def read_rows() -> list[dict[str, str]]:
    with open(FIXTURE, encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def truth_items() -> list[TruthItem]:
    items: list[TruthItem] = []
    last_title: dict[int, str] = {}
    for row in read_rows():
        level = 1 if row["Title 1"].strip() else 2 if row["Title 2"].strip() else 3
        title = row[f"Title {level}"].strip()
        items.append(
            TruthItem(
                row["Work Item Type"], level, title, last_title.get(level - 1), row["Description"]
            )
        )
        last_title[level] = title
    return items


def ladder_items() -> list[TruthItem]:
    return [i for i in truth_items() if i.type in LADDER]


def _numbers(items: list[TruthItem]):
    counters = [0, 0, 0]
    for item in items:
        counters[item.level - 1] += 1
        for k in range(item.level, 3):
            counters[k] = 0
        yield item, ".".join(str(c) for c in counters[: item.level])


def build_csv(out: Path) -> Path:
    path = out / "csv_ado.csv"
    shutil.copy(FIXTURE, path)
    return path


def build_xlsx_ado(out: Path) -> Path:
    import openpyxl

    rows = read_rows()
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "AQUILA"
    columns = list(rows[0].keys())
    ws.append(columns)
    for row in rows:
        ws.append([row[c] for c in columns])
    path = out / "xlsx_ado.xlsx"
    wb.save(path)
    return path


def build_xlsx_flat(out: Path) -> Path:
    import openpyxl

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Requirements"
    ws.append(["ID", "Work Item Type", "Title", "Parent", "Description"])
    ids: dict[tuple[int, str], int] = {}
    for n, item in enumerate(truth_items(), 1):
        ids[(item.level, item.title)] = n
        parent = ids.get((item.level - 1, item.parent)) if item.parent else None
        ws.append([n, item.type, item.title, parent, to_plain(item.html)])
    path = out / "xlsx_flat_plain.xlsx"
    wb.save(path)
    return path


def build_docx(out: Path, name: str, *, numbered: bool = False, labeled: bool = False) -> Path:
    import docx

    document = docx.Document()
    for item, number in _numbers(ladder_items()):
        text = (
            (f"{number} " if numbered else "") + (f"{item.type}: " if labeled else "") + item.title
        )
        document.add_heading(text, level=item.level)
        for kind, runs in paragraphs(item.html):
            paragraph = document.add_paragraph(style="List Bullet" if kind == "li" else None)
            for text_run, bold in runs:
                paragraph.add_run(text_run).bold = bold
    path = out / name
    document.save(path)
    return path


def build_md(out: Path, name: str, *, raw_html: bool) -> Path:
    lines: list[str] = []
    for item in ladder_items():
        lines += [
            "#" * item.level + " " + item.title,
            "",
            item.html if raw_html else to_markdown(item.html),
            "",
        ]
    path = out / name
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


def build_txt(out: Path) -> Path:
    lines: list[str] = []
    for item, number in _numbers(ladder_items()):
        lines += [f"{number} {item.title}", "", to_plain(item.html), ""]
    path = out / "txt_numbered.txt"
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


def build_pdf(out: Path) -> Path:
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import Paragraph, SimpleDocTemplate

    # The built-in PDF fonts have no arrows or comparison signs, so they are spelled out.
    ascii_map = {"–": "-", "→": "->", "≥": ">=", "≤": "<=", "±": "+/-", "°": " deg"}

    def ascii_only(text: str) -> str:
        for k, v in ascii_map.items():
            text = text.replace(k, v)
        return text

    styles = getSampleStyleSheet()
    flow = []
    for item, number in _numbers(ladder_items()):
        flow.append(
            Paragraph(
                html.escape(ascii_only(f"{number} {item.title}")), styles[f"Heading{item.level}"]
            )
        )
        for kind, runs in paragraphs(item.html):
            body = "".join(f"<b>{html.escape(t)}</b>" if b else html.escape(t) for t, b in runs)
            flow.append(
                Paragraph(("• " if kind == "li" else "") + ascii_only(body), styles["Normal"])
            )
    path = out / "pdf_numbered.pdf"
    SimpleDocTemplate(str(path), pagesize=A4).build(flow)
    return path


# --- conventions the code's header detectors do not know: only a model's rulebook can read them -------------------------------------------------

HEBREW_TYPES = {"Epic": "אפיק", "Feature": "פיצ'ר", "Requirement": "דרישה", "Test Case": "באג"}
KIND_TYPES = {"Epic": "Area", "Feature": "Group", "Requirement": "Item", "Test Case": "Check"}
HEBREW_LABELS = {"Epic": "אפיק", "Feature": "יכולת", "Requirement": "דרישה"}


def build_xlsx_hebrew(out: Path) -> Path:
    """Hebrew headings and type values; the parent of a row is the nearest earlier row of a higher type."""
    import openpyxl

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["מזהה", "סוג פריט", "כותרת", "תיאור", "עדיפות"])
    for n, item in enumerate(truth_items(), 1):
        ws.append([f"X-{n:04d}", HEBREW_TYPES[item.type], item.title, to_plain(item.html), "בינונית"])
    path = out / "xlsx_hebrew.xlsx"
    wb.save(path)
    return path


def build_xlsx_level_number(out: Path) -> Path:
    """No type column: a numeric Level column gives the depth, and the depth gives the type."""
    import openpyxl

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["Level", "Name", "Details"])
    for item in ladder_items():
        ws.append([item.level, item.title, to_plain(item.html)])
    path = out / "xlsx_level_number.xlsx"
    wb.save(path)
    return path


def build_xlsx_kind_parent(out: Path) -> Path:
    """Key/Parent links and a Kind column whose values (Area, Group, Item, Check) are not the ladder's names."""
    import openpyxl

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["Key", "Parent", "Summary", "Kind", "Text"])
    keys: dict[tuple[int, str], str] = {}
    for n, item in enumerate(truth_items(), 1):
        key = f"K{n:04d}"
        keys[(item.level, item.title)] = key
        ws.append([key, keys.get((item.level - 1, item.parent)) if item.parent else None, item.title, KIND_TYPES[item.type], to_plain(item.html)])
    path = out / "xlsx_kind_parent.xlsx"
    wb.save(path)
    return path


def build_xlsx_outline(out: Path) -> Path:
    """No type column: an outline number (1, 1.2, 1.2.3) gives the nesting, and the depth gives the type."""
    import openpyxl

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["Outline", "Name", "Details"])
    for item, number in _numbers(ladder_items()):
        ws.append([number, item.title, to_plain(item.html)])
    path = out / "xlsx_outline.xlsx"
    wb.save(path)
    return path


def build_docx_hebrew_labels(out: Path) -> Path:
    """Headings that begin with a Hebrew label naming the type (אפיק: / יכולת: / דרישה:)."""
    import docx

    document = docx.Document()
    for item in ladder_items():
        document.add_heading(f"{HEBREW_LABELS[item.type]}: {item.title}", level=item.level)
        for _, runs in paragraphs(item.html):
            document.add_paragraph("".join(t for t, _ in runs))
    path = out / "docx_hebrew_labels.docx"
    document.save(path)
    return path


@dataclass(frozen=True)
class UnknownVariant:
    name: str
    build: Callable[[Path], Path]
    document: bool = False  # a document (headings), not a table


UNKNOWN_VARIANTS: list[UnknownVariant] = [
    UnknownVariant("xlsx_hebrew", build_xlsx_hebrew),
    UnknownVariant("xlsx_level_number", build_xlsx_level_number),
    UnknownVariant("xlsx_kind_parent", build_xlsx_kind_parent),
    UnknownVariant("xlsx_outline", build_xlsx_outline),
    UnknownVariant("docx_hebrew_labels", build_docx_hebrew_labels, document=True),
]


@dataclass(frozen=True)
class Variant:
    name: str
    build: Callable[[Path], Path]
    tabular: bool  # carries the Test Case rows (types outside the ladder) too
    rich: bool  # the source has bold/list formatting that should survive as Markdown
    # The file states each item's type (a type column, a "Feature:" label). Only then is an Epic or Feature with no requirement below it the
    # file's own planned item, kept; otherwise it is a section with no requirement, left out and reported (owner approach C, 2026-11-26).
    states_types: bool = False


VARIANTS: list[Variant] = [
    Variant("csv_ado", build_csv, True, True, states_types=True),
    Variant("xlsx_ado", build_xlsx_ado, True, True, states_types=True),
    Variant("xlsx_flat_plain", build_xlsx_flat, True, False, states_types=True),
    Variant("docx_headings", lambda o: build_docx(o, "docx_headings.docx"), False, False),
    Variant(
        "docx_numbered", lambda o: build_docx(o, "docx_numbered.docx", numbered=True), False, False
    ),
    Variant(
        "docx_labeled", lambda o: build_docx(o, "docx_labeled.docx", labeled=True), False, False, states_types=True
    ),
    Variant("md_markdown", lambda o: build_md(o, "md_markdown.md", raw_html=False), False, False),
    Variant("md_rawhtml", lambda o: build_md(o, "md_rawhtml.md", raw_html=True), False, True),
    Variant("txt_numbered", build_txt, False, False),
    Variant("pdf_numbered", build_pdf, False, False),
]
