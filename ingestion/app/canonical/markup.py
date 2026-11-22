"""Turns markup found in a source's text (HTML from a tracker export, a Word list, a Markdown HTML block) into the Markdown a description is stored as.

A description is Markdown end to end: the review screen and the Azure DevOps write-back both render it, and neither shows raw tags (the write-back
escapes every `<`). So HTML kept in a stored description reaches the reader as literal `<div><b>` text. This module is the one place that turns it
into bold, lists and paragraphs instead.

Text that is not markup is returned exactly as it came, so a plain or Markdown source is never touched. "Markup" is decided conservatively (see
`looks_like_html`): a sentence that only mentions a tag or compares with `<`/`>` is plain text. A `<table>` found in text becomes plain lines (one
per row): the only live tables in a description are the ones ingestion renders itself (tree_builder._table_to_html), which the write-back passes
through as trusted HTML."""

from __future__ import annotations

import re
from html.parser import HTMLParser

# The tags a tracker or editor writes into rich text; a text is taken as markup only through one of them.
_KNOWN = frozenset(
    "div p br b i u em strong ul ol li span h1 h2 h3 h4 h5 h6 a table thead tbody tr td th font code pre blockquote section hr".split()
)
# Any well-formed tag (also one not in _KNOWN, e.g. <img>, <sup>): name right after "<", well-formed attributes, closing ">". A comment too.
_ATTR = r"""[a-zA-Z_:][-\w:.]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?"""
_ANY_TAG = re.compile(rf"<(/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+{_ATTR})*)\s*(/?)>|<!--.*?-->", re.DOTALL)
_VOID = frozenset("br hr img col wbr input meta link area base source".split())
_OPTIONAL_END = frozenset("li p td th tr thead tbody".split())  # HTML lets these close implicitly
# Only entities a tracker or editor writes into text; a bare "&" or an "AT&T;" is left alone.
_ENTITY = re.compile(r"&(?:amp|lt|gt|nbsp|quot|apos|#\d{1,6}|#x[0-9a-fA-F]{1,5});")
_BLOCK_TAGS = {"div", "p", "section", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "table", "hr"}
_SKIP_TAGS = {"script", "style", "head"}


def looks_like_html(text: str) -> bool:
    """Whether `text` is markup to convert. Conservative, so a requirement that mentions a tag or compares with `<`/`>` stays as written:
    - every `<` and `>` belongs to a well-formed tag (a stray one is a comparison or a placeholder such as "<TBD>"), and
    - the tags balance (an end tag closes the open element; only the elements HTML lets close implicitly may stay open), and
    - at least one known element is closed by its own end tag, or every tag is a known <br>/<hr> written as a line break (against the text,
      not a word between spaces like "the <br> tag").
    Text with no tags is markup only when it is entity-encoded throughout: it has a known entity and no raw "<", ">" or bare "&"."""
    if not text:
        return False
    tags = list(_ANY_TAG.finditer(text))
    rest = _ANY_TAG.sub(" ", text)
    if not tags:
        return bool(_ENTITY.search(text)) and not re.search(r"[<>]", text) and not re.search(r"&", _ENTITY.sub("", text))
    if "<" in rest or ">" in rest:
        return False
    stack: list[str] = []
    closed_pairs = 0
    line_breaks_only = True
    for tag in tags:
        if tag.group(2) is None:  # a comment
            continue
        closing, name = tag.group(1) == "/", tag.group(2).lower()
        if name in _VOID or tag.group(4):
            if not (name in ("br", "hr") and not closing and _is_line_break(text, tag)):
                line_breaks_only = False
            continue
        line_breaks_only = False
        if not closing:
            stack.append(name)
            continue
        while stack and stack[-1] != name and stack[-1] in _OPTIONAL_END:
            stack.pop()
        if not stack or stack[-1] != name:
            return False
        stack.pop()
        closed_pairs += name in _KNOWN
    if any(name not in _OPTIONAL_END for name in stack):
        return False
    return closed_pairs > 0 or line_breaks_only


def _is_line_break(text: str, tag: re.Match) -> bool:
    before = text[tag.start() - 1] if tag.start() else ""
    after = text[tag.end()] if tag.end() < len(text) else ""
    return not (before.isspace() and after.isspace())


class _Converter(HTMLParser):
    def __init__(self, emphasis: bool = True, escape_lt: bool = False) -> None:
        super().__init__(convert_charrefs=True)
        self.emphasis = emphasis  # False: bold, italic and code stay plain text (for a table cell, where Markdown is not rendered)
        # True (Markdown): a "<" that came from an entity stays "&lt;", so decoded text can never become a tag (a live <table> above all).
        self.escape_lt = escape_lt
        self.row_cells = 0  # cells seen in the current table row
        # Each block: ("p", text) or ("li", depth, text); a list is a run of "li" blocks.
        self.blocks: list[tuple] = []
        self.buf = ""
        self.marks: list[tuple[str, int, str]] = []  # (marker, start offset in buf, closing text)
        self.list_depth = 0
        self.in_item = False
        self.skip = 0
        self.heading = False

    def _flush(self) -> None:
        self._close_open_marks()
        text = re.sub(r"[ \t]+", " ", self.buf)
        text = re.sub(r" *\n *", "\n", text).strip()
        if text:
            if self.in_item:
                self.blocks.append(("li", max(self.list_depth - 1, 0), text))
            else:
                self.blocks.append(("p", text))
        self.buf = ""

    def _close_open_marks(self) -> None:
        while self.marks:
            self._end_mark()

    def _start_mark(self, marker: str) -> None:
        shown = marker if self.emphasis else ""
        self.marks.append((shown, len(self.buf), shown))

    def _end_mark(self) -> None:
        marker, start, closing = self.marks.pop()
        inner = self.buf[start:]
        stripped = inner.strip()
        if not stripped:
            self.buf = self.buf[:start] + inner
            return
        lead = inner[: len(inner) - len(inner.lstrip())]
        trail = inner[len(inner.rstrip()) :]
        self.buf = self.buf[:start] + lead + marker + stripped + closing + trail

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if tag in _SKIP_TAGS:
            self.skip += 1
            return
        if self.skip:
            return
        if tag in ("ul", "ol"):
            self._flush()
            self.list_depth += 1
        elif tag == "li":
            self._flush()
            self.in_item = True
        elif tag in _BLOCK_TAGS:
            self._flush()
            if tag.startswith("h") and len(tag) == 2:
                self._start_mark("**")
                self.heading = True
        elif tag == "br":
            if self.buf.strip():
                self.buf += "\n"
        elif tag == "tr":
            # A table in text is plain lines, one per row, its cells joined by " | ".
            self.row_cells = 0
            if self.buf.strip() and not self.buf.endswith("\n"):
                self.buf += "\n"
        elif tag in ("td", "th"):
            if self.row_cells:
                self.buf += " | "
            self.row_cells += 1
        elif tag in ("b", "strong"):
            self._start_mark("**")
        elif tag in ("i", "em"):
            self._start_mark("*")
        elif tag == "code":
            self._start_mark("`")
        elif tag == "a":
            href = dict(attrs).get("href") or ""
            self.marks.append(
                (
                    "[",
                    len(self.buf),
                    f"]({href})" if re.match(r"(?i)(https?://|mailto:)", href) else "",
                )
            )

    def handle_endtag(self, tag: str) -> None:
        if tag in _SKIP_TAGS:
            self.skip = max(self.skip - 1, 0)
            return
        if self.skip:
            return
        if tag in ("ul", "ol"):
            self._flush()
            self.list_depth = max(self.list_depth - 1, 0)
            self.in_item = self.list_depth > 0 and self.in_item
        elif tag == "li":
            self._flush()
            self.in_item = False
        elif tag in _BLOCK_TAGS:
            self._flush()
        elif tag == "tr":
            self.buf += "\n"
        elif tag in ("b", "strong", "i", "em", "code") and self.marks:
            self._end_mark()
        elif tag == "a" and self.marks:
            marker, start, closing = self.marks.pop()
            inner = self.buf[start:]
            self.buf = self.buf[:start] + (
                f"[{inner.strip()}{closing}" if closing and inner.strip() else inner
            )
        elif tag.startswith("h") and len(tag) == 2 and self.marks:
            self._end_mark()
            self._flush()

    def handle_data(self, data: str) -> None:
        if not self.skip:
            data = data.replace("\xa0", " ")
            self.buf += data.replace("<", "&lt;") if self.escape_lt else data

    def render(self) -> str:
        self._flush()
        out: list[str] = []
        previous_kind = ""
        for block in self.blocks:
            if block[0] == "li":
                line = "  " * block[1] + "- " + block[2].replace("\n", "\n" + "  " * (block[1] + 1))
                out.append(("\n" if previous_kind == "li" else "\n\n" if out else "") + line)
            else:
                out.append(("\n\n" if out else "") + block[1])
            previous_kind = block[0]
        return "".join(out).strip()


def _convert(fragment: str, emphasis: bool = True, escape_lt: bool = False) -> str:
    parser = _Converter(emphasis, escape_lt)
    parser.feed(fragment)
    parser.close()
    return parser.render()


def html_to_markdown(text: str) -> str:
    """The Markdown for `text`; `text` itself, unchanged, when it is not markup. A table in it becomes plain lines, never a live table."""
    if not looks_like_html(text):
        return text
    return _convert(text, escape_lt=True)


def html_to_plain(text: str) -> str:
    """One line of plain text for a title: tags and entities gone, whitespace collapsed; `text` unchanged when it is not HTML."""
    if not looks_like_html(text):
        return text
    plain = re.sub(r"[*`]", "", re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", _convert(text)))
    return re.sub(r"\s+", " ", plain).strip()


def html_to_cell_text(text: str) -> str:
    """Text for a table cell: paragraphs and list items on their own lines, no emphasis markers (a cell is not rendered as Markdown).
    `text` unchanged when it is not HTML."""
    if not looks_like_html(text):
        return text
    return _convert(text, emphasis=False)


def normalize_block_markup(doc):  # noqa: ANN001, ANN201  (CanonicalDoc; imported lazily so this module stays import-light)
    """Turns markup inside a document's running text into Markdown (paragraphs and list items) or plain text (the title and headings), in place.
    A block that is not HTML-looking is not touched, so a plain or Markdown source comes out byte-identical."""
    from app.canonical.model import BlockKind

    for block in doc.blocks:
        if not looks_like_html(block.text):
            continue
        if block.kind in (BlockKind.PARAGRAPH, BlockKind.LIST_ITEM):
            converted = html_to_markdown(block.text)
        elif block.kind in (BlockKind.TITLE, BlockKind.HEADING):
            converted = html_to_plain(block.text)
        else:
            continue
        if converted.strip():
            block.text = converted
    return doc
