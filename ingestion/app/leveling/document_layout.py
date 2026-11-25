"""The document's layout as far as structure needs it: which blocks and tables are front matter (cover, notices, revision history,
contents, abbreviations, anything before the first numbered section) and so are never items.

Read from the document's own structure, the same in BASELINE and SURVEY, before any item is built:
  * a contents entry is a line that ends in dot leaders and a page number ("2.1 Input Power ........ 4"); a heading followed by
    contents entries is the contents heading;
  * when the document numbers its sections ("1 Introduction", "2.1 Input Power"), everything before its first numbered section is
    front matter -- unless something there opens with a requirement code, in which case nothing is left out by position.
A layout the pre-study learned and checked (study/model_rules.py, `DocumentRules.front_matter`) adds the blocks it names.

What is left out is reported once (`left_out_warning`), with the document's own heading text and pages, never as items."""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from app.canonical.model import Block, BlockKind, CanonicalDoc, SourceRef
from app.leveling.customer_id import opens_a_requirement
from app.leveling.numbering import parse_numbering
from app.workitem.model import IntegrityWarning, WarningKind

# "Introduction ............ 4", "2.1 Input Power …… 12": dot leaders (or an ellipsis run) then a page number at the end.
_CONTENTS_ENTRY_END = re.compile(r"(?:\.{4,}|…{2,}|(?:\s?\.){4,})\s*\d{1,4}\s*$")
# The same entry anywhere in a block, for contents lines a loader merged into one paragraph.
_CONTENTS_ENTRY_ANY = re.compile(r"(?:\.{4,}|…{2,}|(?:\s?\.){4,})\s*\d{1,4}(?=\s|$)")
# A document is read as numbering its sections when at least this many headings carry a literal section number (one of them dotted).
MIN_NUMBERED_SECTIONS = 3
# What is left out by position may be at most this share of the document's blocks.
MAX_POSITIONAL_SHARE = 0.5


@dataclass
class FrontMatter:
    block_ids: set[str] = field(default_factory=set)
    table_ids: set[str] = field(default_factory=set)
    # What the user is told was left out: (the document's own heading or first words, first page, last page; None when unknown), in
    # document order.
    parts: list[tuple[str, int | None, int | None]] = field(default_factory=list)
    # The cover's title, when the document has no title block of its own: kept as the document's title (it names the Epic),
    # not left out and not an item. A PDF never marks a title, so its cover title arrives as an ordinary heading.
    title_block_id: str | None = None
    # The title's text when it is printed over several consecutive cover headings ("COMPONENT SPECIFICATION" / "[412.7] Greenhouse
    # Climate Controller"): joined in order. None when the title block's own text is the title.
    title_text: str | None = None
    # The other headings the title was joined from: left out, but not reported as front matter (they are the title).
    title_line_ids: set[str] = field(default_factory=set)

    def __bool__(self) -> bool:
        return bool(self.block_ids or self.table_ids)


def is_contents_entry(text: str) -> bool:
    """A table-of-contents line: it ends in dot leaders and a page number, or several such entries were merged into one block."""
    stripped = " ".join(text.split())
    return (
        bool(_CONTENTS_ENTRY_END.search(stripped))
        or len(_CONTENTS_ENTRY_ANY.findall(stripped)) >= 2
    )


def _order(ref: SourceRef) -> tuple[int, int]:
    return (ref.page or 0, ref.start_offset)


def _numbered_section(block: Block) -> bool:
    """A section heading whose number is printed in its own text (not one a loader synthesized from font size): "2.1 Input Power",
    or a single number before a capitalised word ("2 Power"). "5 V DC input" and "3 phase supply" are not section numbers."""
    if block.kind != BlockKind.HEADING or is_contents_entry(block.text):
        return False
    label, rest = parse_numbering(block.text)
    if label is None or not rest.strip():
        return False
    if "." in label:
        return True
    first_word = rest.split()[0]
    return len(first_word) >= 2 and first_word[0].isupper()


# A sentence that stops the reader, not the system: a confidentiality or copyright notice ("shall not be reproduced").
_NOTICE_PATTERN = re.compile(
    r"\b(reproduc\w*|disclos\w*|distribut\w*|copyright|proprietary|confidential|permission|all rights reserved)\b",
    re.IGNORECASE,
)
_OBLIGATION_PATTERN = re.compile(r"\b(shall|must)\b", re.IGNORECASE)
# Section titles that open content, never front matter, even before the first numbered section.
_CONTENT_TITLES = frozenset(
    {"overview", "introduction", "scope", "purpose", "summary", "general", "background"}
)


def _states_a_requirement(block: Block) -> bool:
    """A block that states an obligation of the system: a coded requirement, or a sentence with "shall"/"must" that is not a notice."""
    if opens_a_requirement(block.text):
        return True
    text = " ".join(block.text.split())
    return bool(_OBLIGATION_PATTERN.search(text)) and not _NOTICE_PATTERN.search(text)


def _is_content_title(block: Block) -> bool:
    words = re.sub(r"[^\w\s]", " ", block.text).lower().split()
    return bool(words) and words[0] in _CONTENT_TITLES


def find_front_matter(doc: CanonicalDoc, learned: dict[str, str] | None = None) -> FrontMatter:
    """`learned`: the heading block ids the pre-study named as opening front matter, with their roles (learned_front_matter)."""
    blocks = doc.blocks
    left_out: set[str] = set()

    # Contents entries, and the heading right before a run of them.
    for i, block in enumerate(blocks):
        if block.kind in (BlockKind.PARAGRAPH, BlockKind.HEADING) and is_contents_entry(block.text):
            left_out.add(block.id)
            j = i - 1
            while j >= 0 and blocks[j].id in left_out:
                j -= 1
            if j >= 0 and blocks[j].kind == BlockKind.HEADING and not _numbered_section(blocks[j]):
                left_out.add(blocks[j].id)

    # Everything before the first numbered section, when the document numbers its sections.
    table_ids: set[str] = set()
    numbered = [i for i, b in enumerate(blocks) if _numbered_section(b)]
    dotted = any("." in (parse_numbering(blocks[i].text)[0] or "") for i in numbered)
    if len(numbered) >= MIN_NUMBERED_SECTIONS and dotted:
        first = numbered[0]
        # The document's title names its Epic (tree_builder), so it is kept; everything else before the first section goes --
        # but only when nothing there is content: a requirement stated before the first numbered section, or a section titled
        # as content ("Overview", "Scope"), keeps all of it (a wrongly kept cover is a visible item; a lost requirement is not).
        before = [b for b in blocks[:first] if b.id not in left_out and b.kind != BlockKind.TITLE]
        content_before = any(_states_a_requirement(b) for b in before) or any(
            b.kind == BlockKind.HEADING and _is_content_title(b) for b in before
        )
        if before and not content_before and len(before) <= MAX_POSITIONAL_SHARE * len(blocks):
            left_out.update(b.id for b in before)
            boundary = _order(blocks[first].source_ref)
            table_ids = {t.id for t in doc.tables if _order(t.source_ref) < boundary}

    # The cover's title, when the document has none of its own: the first heading left out by position, or a heading the pre-study
    # named as the cover.
    title_block_id: str | None = None
    title_lines: list[Block] = []
    if not any(b.kind == BlockKind.TITLE for b in blocks):
        learned_cover = next(
            (i for i, role in sorted((learned or {}).items()) if role == "cover"), None
        )
        # A paginated document's cover is page 1: its first heading left out by position is the title, even after a banner or a
        # notice printed above it, together with the headings right after it (a title printed over several lines of different
        # sizes). A text format has no pages, so only its very first block can be the title.
        def _title_line(b: Block) -> bool:
            return (
                b.id in left_out
                and b.kind == BlockKind.HEADING
                and not is_contents_entry(b.text)
                and not _is_content_title(b)
            )

        start = next(
            (
                i
                for i, b in enumerate(blocks)
                if (b.source_ref.page == 1 or (b.source_ref.page is None and i == 0)) and _title_line(b)
            ),
            None,
        )
        if start is not None:
            title_lines = [blocks[start]]
            for b in blocks[start + 1 :]:
                if not _title_line(b) or b.source_ref.page != blocks[start].source_ref.page or b.source_ref.page is None:
                    break
                title_lines.append(b)
            title_block_id = title_lines[0].id
        elif learned_cover is not None:
            title_block_id = learned_cover

    for heading_id in sorted(learned or ()):
        section, tables = section_of(doc, heading_id)
        left_out.update(b.id for b in section)
        table_ids |= tables

    if title_block_id is not None:
        left_out.discard(title_block_id)
    result = FrontMatter(
        block_ids=left_out,
        table_ids=table_ids,
        title_block_id=title_block_id,
        title_text=" \u2013 ".join(" ".join(b.text.split()) for b in title_lines) if len(title_lines) > 1 else None,
        title_line_ids={b.id for b in title_lines[1:]},
    )
    for block in blocks:
        if block.id in result.title_line_ids or block.id not in left_out:
            continue
        page = block.source_ref.page_end or block.source_ref.page
        if block.kind == BlockKind.HEADING or not result.parts:
            result.parts.append((" ".join(block.text.split())[:80], block.source_ref.page, page))
        elif page is not None:
            # A part runs until the next part: its last page is the last page of the blocks left out with it.
            text, first, last = result.parts[-1]
            result.parts[-1] = (text, first, max(page, last or page))
    return result


def learned_front_matter(rulebook: object | None) -> dict[str, str]:
    """The heading block ids the pre-study learned and checked as opening front matter (`DocumentRules.front_matter`), with their roles."""
    document = getattr(rulebook, "document", None)
    return {part.block_id: part.role for part in getattr(document, "front_matter", ()) or ()}


def section_of(doc: CanonicalDoc, heading_block_id: str) -> tuple[list[Block], set[str]]:
    """The blocks of a heading's section (the heading and everything up to the next heading at its level or above) and the ids of the
    tables inside it. ([], set()) when the id is not a heading of `doc`."""
    from app.leveling.depth import resolve_block_depth

    blocks = doc.blocks
    start = next((i for i, b in enumerate(blocks) if b.id == heading_block_id), None)
    if start is None:
        return [], set()
    level, _ = resolve_block_depth(blocks[start])
    if level is None:
        return [], set()
    end = len(blocks)
    for j in range(start + 1, len(blocks)):
        if (
            blocks[j].kind != BlockKind.HEADING
        ):  # a body paragraph that starts with a number ("5 V rail ...") never ends a section
            continue
        other, _ = resolve_block_depth(blocks[j])
        if other is not None and other <= level and not is_contents_entry(blocks[j].text):
            end = j
            break
    lo = _order(blocks[start].source_ref)
    hi = _order(blocks[end].source_ref) if end < len(blocks) else None
    tables = {
        t.id
        for t in doc.tables
        if _order(t.source_ref) >= lo and (hi is None or _order(t.source_ref) < hi)
    }
    return blocks[start:end], tables


def without_front_matter(doc: CanonicalDoc, front: FrontMatter) -> CanonicalDoc:
    """`doc` with the front-matter blocks and tables removed (figures stay: a figure is attributed by its own block)."""
    if not front:
        return doc
    return doc.model_copy(
        update={
            "blocks": [
                b.model_copy(
                    update={"kind": BlockKind.TITLE, "heading_level": None, "text": front.title_text or b.text}
                )
                if b.id == front.title_block_id
                else b
                for b in doc.blocks
                if b.id not in front.block_ids
            ],
            "tables": [t for t in doc.tables if t.id not in front.table_ids],
        }
    )


def with_left_out_sections(
    front: FrontMatter | None, sections: list[tuple[str, int | None, int | None]]
) -> FrontMatter | None:
    """`front` with numbered sections the document grammar left out (front matter such as a revision history inside chapter 1, back
    matter such as a traceability listing) added to what is reported, in document order after the unnumbered front matter."""
    if not sections:
        return front
    base = front if front is not None else FrontMatter()
    return FrontMatter(
        block_ids=base.block_ids,
        table_ids=base.table_ids,
        parts=sorted([*base.parts, *sections], key=_part_order),
        title_block_id=base.title_block_id,
        title_text=base.title_text,
        title_line_ids=base.title_line_ids,
    )


def left_out_warning(front: FrontMatter) -> IntegrityWarning | None:
    if not front and not front.parts:
        return None
    # Every page a part covers, so a reader can tell the front matter (pages 1-5) from back matter (pages 28-31).
    pages = sorted(
        {p for _t, first, last in front.parts if first is not None for p in range(first, (last or first) + 1)}
    )
    names = "; ".join(f'"{text}"' + _pages_label(first, last) for text, first, last in front.parts[:12])
    more = " ..." if len(front.parts) > 12 else ""
    return IntegrityWarning.make(
        WarningKind.FRONT_MATTER_LEFT_OUT,
        f"Left out as front matter, not requirements: {names}{more}. "
        f"{len(front.block_ids)} text block(s) and {len(front.table_ids)} table(s) before the first section were not made into items.",
        detail={
            "blockIds": sorted(front.block_ids),
            "tableIds": sorted(front.table_ids),
            "titleBlockId": front.title_block_id,
            "parts": [
                {"text": t, "page": first, **({"pageEnd": last} if last is not None and last != first else {})}
                for t, first, last in front.parts
            ],
            "pages": pages,
        },
    )


def _pages_label(first: int | None, last: int | None) -> str:
    if first is None:
        return ""
    return f" (p{first}-{last})" if last is not None and last != first else f" (p{first})"


def _part_order(part: tuple[str, int | None, int | None]) -> tuple[int, tuple[int, ...]]:
    """Document order for parts from two sources (the pre-study's front matter and the grammar's left-out sections): by page, then by
    section number ("1.3" before "1.4" before "1.5"); an unnumbered part (a cover, a contents page) first on its page. Sorted stably."""
    label, _rest = parse_numbering(part[0])
    numbers = tuple(int(n) for n in re.findall(r"\d+", label)) if label else ()
    return (part[1] or 0, numbers)
