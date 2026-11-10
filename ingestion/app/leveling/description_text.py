"""The text a model reads for a work item's description.

A description is the ADO System.Description field: rich HTML (tables as <table> markup, and whatever Word, Excel or the web editor
pasted), or plain/markdown text. Sending it to a model as it is made the model read the markup (style attributes, colgroups, Office tags)
together with the content. This turns it into plain text for that purpose only: tables become CSV with every row kept (one line each, spans
repeated so each row stands alone, no invented header), other markup is dropped, and text without HTML comes back unchanged. The stored
description, the ADO write-back and the review UI keep the HTML; nothing here is ever stored.

Pure, stdlib only, deterministic (the result cache and the score cache key on what the model is sent)."""
from __future__ import annotations

import csv
import io
import re
from html.parser import HTMLParser

from app.config import settings

# Tags that make a string "HTML" at all; anything else in angle brackets ("<value>", "x <10") is the author's text and is kept.
_KNOWN_TAGS = (
    "table|thead|tbody|tfoot|tr|td|th|caption|colgroup|col|p|div|span|br|hr|ul|ol|li|h[1-6]|b|i|u|em|strong|a|font|img|blockquote|pre|code|sub|sup"
)
_LOOKS_LIKE_HTML = re.compile(rf"</?(?:{_KNOWN_TAGS})\b[^>]*>|<!--", re.IGNORECASE)
_BREAK_BEFORE_AND_AFTER = {"p", "div", "ul", "ol", "blockquote", "pre", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "tr"}
_DROPPED_CONTENT = {"script", "style", "head", "title"}
_MAX_SPAN = 1000


class _Converter(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self._skip = 0  # inside <script>/<style>
        self._table_depth = 0
        self._rows: list[list[tuple[str, int, int]]] = []
        self._head_rows = 0
        self._first_row_all_th = True
        self._in_thead = False
        self._caption: list[str] = []
        self._in_caption = False
        self._cell: list[str] | None = None
        self._cell_attrs = (1, 1)
        self._cell_is_th = False

    # -- helpers -------------------------------------------------------------------------------------------------------------------
    @staticmethod
    def _span(attrs: dict, name: str) -> int:
        try:
            return max(1, min(int(attrs.get(name) or 1), _MAX_SPAN))
        except ValueError:
            return 1

    def _emit(self, text: str) -> None:
        if self._cell is not None:
            self._cell.append(text)
        elif self._in_caption:
            self._caption.append(text)
        else:
            self.out.append(text)

    # -- parser callbacks ------------------------------------------------------------------------------------------------------------
    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if tag in _DROPPED_CONTENT:
            self._skip += 1
            return
        if self._skip:
            return
        a = {k.lower(): v for k, v in attrs}
        if tag == "table":
            if self._table_depth == 0:
                self._start_table()
            else:
                self._emit(" ")
            self._table_depth += 1
            return
        if self._table_depth == 1:
            if tag == "thead":
                self._in_thead = True
            elif tag == "tr":
                self._rows.append([])
                if self._in_thead:
                    self._head_rows += 1
            elif tag in ("td", "th"):
                if not self._rows:
                    self._rows.append([])
                self._cell = []
                self._cell_attrs = (self._span(a, "colspan"), self._span(a, "rowspan"))
                self._cell_is_th = tag == "th"
            elif tag == "caption":
                self._in_caption = True
            elif tag == "br" and self._cell is not None:
                self._cell.append(" ")
            elif self._cell is not None and tag in ("p", "div", "li", "tr"):
                self._cell.append(" ")
            return
        if self._table_depth > 1:  # inside a nested table: its text is flattened into the outer cell
            if tag in ("td", "th", "tr", "br", "p", "div", "li"):
                self._emit(" ")
            return
        # outside any table
        if tag == "br":
            self.out.append("\n")
        elif tag == "li":
            self.out.append("\n- ")
        elif tag in _BREAK_BEFORE_AND_AFTER:
            self.out.append("\n\n")
        elif ":" in tag or re.fullmatch(_KNOWN_TAGS, tag):
            pass  # formatting or Office markup: dropped, its text stays
        else:
            self.out.append(self.get_starttag_text() or "")  # not HTML: the author's own "<value>"

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag in _DROPPED_CONTENT:
            self._skip = max(0, self._skip - 1)
            return
        if self._skip:
            return
        if tag == "table":
            if self._table_depth == 0:
                return
            self._table_depth -= 1
            if self._table_depth == 0:
                self._finish_table()
            return
        if self._table_depth == 1:
            if tag == "thead":
                self._in_thead = False
            elif tag in ("td", "th") and self._cell is not None:
                self._rows[-1].append((" ".join("".join(self._cell).split()), *self._cell_attrs))
                if not self._cell_is_th and len(self._rows) == 1:
                    self._first_row_all_th = False
                self._cell = None
            elif tag == "caption":
                self._in_caption = False
            return
        if self._table_depth > 1:
            return
        if tag in ("p", "div", "ul", "ol", "blockquote", "pre", "h1", "h2", "h3", "h4", "h5", "h6"):
            self.out.append("\n\n")

    def handle_data(self, data):
        if not self._skip:
            self._emit(data)

    def handle_comment(self, data):  # Word's conditional comments and the like
        pass

    def handle_decl(self, decl):
        pass

    def unknown_decl(self, data):
        pass

    # -- tables ----------------------------------------------------------------------------------------------------------------------
    def _start_table(self) -> None:
        self._rows = []
        self._head_rows = 0
        self._first_row_all_th = True
        self._in_thead = False
        self._caption = []

    def _finish_table(self) -> None:
        self._cell = None
        self._in_caption = False
        rendered = _render_table(self._rows, self._head_rows, self._first_row_all_th, " ".join("".join(self._caption).split()))
        self.out.append("\n\n" + rendered + "\n\n" if rendered else "\n\n")

    def finish(self) -> str:
        while self._table_depth > 0:  # an unclosed table still yields its rows
            self._table_depth -= 1
            if self._table_depth == 0:
                self._finish_table()
        return "".join(self.out)


def _expand(rows: list[list[tuple[str, int, int]]]) -> list[list[str]]:
    """Resolves colspan/rowspan into a rectangular grid; a spanned position repeats its owner's text."""
    grid: list[list[str]] = []
    pending: dict[tuple[int, int], str] = {}
    for r, row in enumerate(rows):
        out: list[str] = []
        c = 0
        cells = iter(row)
        while True:
            while (r, c) in pending:
                out.append(pending.pop((r, c)))
                c += 1
            cell = next(cells, None)
            if cell is None:
                break
            text, colspan, rowspan = cell
            for dc in range(colspan):
                out.append(text)
                for dr in range(1, rowspan):
                    pending[(r + dr, c + dc)] = text
            c += colspan
        grid.append(out)
    width = max((len(r) for r in grid), default=0)
    return [r + [""] * (width - len(r)) for r in grid]


def _render_table(rows: list[list[tuple[str, int, int]]], head_rows: int, first_row_all_th: bool, caption: str) -> str:
    grid = _expand(rows)
    if not any(cell.strip() for row in grid for cell in row):
        return ""
    n_head = head_rows or (1 if rows and rows[0] and first_row_all_th else 0)
    head, body = grid[:n_head], grid[n_head:]
    body = [row for row in body if any(cell.strip() for cell in row)]  # a spacer row carries nothing
    lines: list[list[str]] = []
    if head:
        labels = []
        for c in range(len(grid[0])):
            parts: list[str] = []
            for row in head:  # several header rows: "Group / Sub", a colspan's repeats collapsed
                if row[c] and (not parts or parts[-1] != row[c]):
                    parts.append(row[c])
            labels.append(" / ".join(parts))
        lines.append(labels)
    lines.extend(body)
    buffer = io.StringIO()
    csv.writer(buffer, lineterminator="\n").writerows(lines)
    title = "Table (CSV):" + (f" {caption}" if caption else "")
    return title + "\n" + buffer.getvalue().rstrip("\n")


def description_for_model(description: str | None) -> str:
    """What a model is sent for a description: plain text, every table as CSV. Text with no HTML in it is returned as it is. With
    DESCRIPTION_TEXT_FOR_MODEL_ENABLED off the stored text is returned as it is."""
    if not settings.description_text_for_model_enabled:
        return description or ""
    return html_to_model_text(description)


def html_to_model_text(description: str | None) -> str:
    """The conversion itself, independent of the setting (the chat table listing always needs CSV)."""
    text = description or ""
    if not _LOOKS_LIKE_HTML.search(text):
        return text
    parser = _Converter()
    parser.feed(text)
    parser.close()
    converted = parser.finish().replace("\xa0", " ")
    converted = "\n".join(line.rstrip() for line in converted.split("\n"))
    return re.sub(r"\n{3,}", "\n\n", converted).strip()


# -- chat: tables are read-only context -------------------------------------------------------------------------------------------------
# A proposal replaces the whole description, so a table the model had to copy back could be paraphrased, flattened or dropped. The model is
# shown each table as a marker plus its CSV (to understand the item) and never writes one: the stored HTML is put back by code.

_TABLE_TAG = re.compile(r"<(/?)table\b[^>]*>", re.IGNORECASE)
_MARKER = re.compile(r"\[\s*\[?\s*TABLE\s*#?\s*(\d+)\s*\]?\s*\]", re.IGNORECASE)
# What restore_tables accepts as a marker. A single-bracket "[Table 1]" is also what an author writes in prose ("see [Table 1]"), so it
# counts only alone on its line, where the model put the marker; inline it is left as written.
_MARKER_DOUBLE = re.compile(r"\[\s*\[\s*TABLE\s*#?\s*(\d+)\s*\]\s*\]", re.IGNORECASE)
_MARKER_SINGLE_ALONE = re.compile(r"^([ \t]*)\[\s*TABLE\s*#?\s*(\d+)\s*\](?=[ \t]*$)", re.IGNORECASE | re.MULTILINE)


def table_marker(number: int) -> str:
    return f"[[TABLE {number}]]"


def split_tables(description: str | None) -> tuple[str, list[str]]:
    """(the description with each outermost <table>...</table> replaced by its marker, the original blocks in order). A table with no
    closing tag is left in the text. Text without a table comes back unchanged."""
    text = description or ""
    pieces: list[str] = []
    tables: list[str] = []
    cursor = 0
    depth = 0
    start = 0
    for match in _TABLE_TAG.finditer(text):
        if match.group(1) == "":
            if depth == 0:
                start = match.start()
            depth += 1
        elif depth > 0:
            depth -= 1
            if depth == 0:
                pieces.append(text[cursor:start])
                tables.append(text[start:match.end()])
                pieces.append(table_marker(len(tables)))
                cursor = match.end()
    pieces.append(text[cursor:])
    return "".join(pieces), tables


def markers_as_words(text: str) -> str:
    """A marker the model mentioned in its reply to the user reads as plain words ("table 1")."""
    return _MARKER.sub(lambda match: f"table {match.group(1)}", text)


def table_context(tables: list[str]) -> str:
    """The read-only listing of every table for a prompt: its marker and its CSV."""
    return "\n\n".join(f"{table_marker(n)} (read-only):\n{html_to_model_text(table)}" for n, table in enumerate(tables, start=1))


def _echoed_csv_lines(tables: list[str]) -> set[str]:
    lines: set[str] = set()
    for table in tables:
        for line in html_to_model_text(table).split("\n"):
            line = line.strip()
            if line.startswith("Table (CSV)") or ("," in line and line):
                lines.add(line)
    return lines


def restore_tables(proposed: str, tables: list[str]) -> tuple[str, dict[str, int]]:
    """Puts the stored tables back into a proposal that holds markers. Each marker (matched loosely: case, spacing; one bracket short only alone on its line) becomes its
    original HTML byte for byte; a duplicated or unknown marker is dropped; a table whose marker is missing is appended at the end in
    original order; CSV lines the model echoed into the prose are removed. Returns the text and counts for the log."""
    counts = {"restored": 0, "reattached": 0, "dropped_extra": 0, "csv_rows_removed": 0}
    echoed = _echoed_csv_lines(tables)
    kept: list[str] = []
    for line in proposed.split("\n"):
        if line.strip() in echoed:
            counts["csv_rows_removed"] += 1
        else:
            kept.append(line)
    text = "\n".join(kept)
    used: set[int] = set()

    def table_for(number: int) -> str:
        if not 1 <= number <= len(tables) or number in used:
            counts["dropped_extra"] += 1
            return ""
        used.add(number)
        counts["restored"] += 1
        return tables[number - 1]

    text = _MARKER_DOUBLE.sub(lambda match: table_for(int(match.group(1))), text)
    text = _MARKER_SINGLE_ALONE.sub(lambda match: match.group(1) + table_for(int(match.group(2))), text)
    for number, table in enumerate(tables, start=1):
        if number not in used:
            text = text.rstrip() + "\n\n" + table
            counts["reattached"] += 1
    return text, counts
