"""A document's own grammar, and the tree it states.

A customer specification states its own structure. Read with fixed rules (an uppercase code pattern, a list of context titles), a
real one lost all its Customer IDs, a quarter of its requirements and the trace under each one. The grammar is learned from the
document instead -- by code, deterministically, and (when the pre-study ran) as confirmed by the model -- and then applied by code
alone, so the same file always gives the same tree:

  * **the requirement unit**: a requirement opens with the document's own code shape (code_shape.py) and runs until the next unit or
    heading, with everything printed under it -- its text, its lists, its Notes and its trace (a label such as "Satisfies:" and the
    parent codes). Once its trailing parts began, a new statement with an obligation and no code is a requirement of its own;
  * **sections**: every numbered heading of a chapter that holds requirements is a Feature, nested by its number; a section's text
    before its first requirement is its description; every requirement is a Requirement under its own section, including those
    stated directly under a section that also has subsections;
  * **a section whose whole body is a one-line marker** ("None.", "Not applicable.") is an empty Feature, never a Requirement;
  * **a chapter with no requirements** before the requirement chapters describes the document: its prose is kept as one Feature's
    description (context), and its sections that hold tables (revision history, references, abbreviations) are front matter, left
    out and reported; a chapter with no requirements after them (a traceability listing) is back matter, left out and reported.

Used by BASELINE (tree_builder.build_baseline_tree) and SURVEY (llm_leveling) alike, whenever the document has a learned code shape and
numbered headings; any other document is built as before."""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Literal

from app.canonical.model import Block, BlockKind, CanonicalDoc, SourceRef, Table
from app.distillation.description import assemble_description
from app.distillation.title import extract_baseline_title
from app.leveling.code_shape import CodeShape, learn_code_shape
from app.leveling.numbering import numbering_depth, parse_numbering
from app.workitem.model import (
    IntegrityWarning,
    WarningKind,
    WorkItemMode,
    WorkItemNode,
    WorkItemType,
)

# An obligation, in English and Hebrew (the same words informational.py reads).
OBLIGATION = _OBLIGATION = re.compile(
    r"\b(shall|must|will|should|required to|is required|needs to|has to|have to|is to|are to)\b|חייב|נדרש|יש ל|דרישה", re.IGNORECASE
)


def invents_obligation(rewrite: str, source: str) -> bool:
    """A rewrite that adds an obligation to a marker: a one-line body such as "None.", "Not applicable." or "This section is left
    blank." states that there is nothing, and a rewrite into "The system shall ..." invents a requirement. Limited to markers on
    purpose: an imperative ("Provide a mounting bracket."), a Hebrew future-tense requirement or a bare heading ("Power-up test") has
    no obligation word either, and normalising those into a requirement sentence is what the wording passes are for."""
    stripped = source.strip()
    return (
        bool(_OBLIGATION.search(rewrite))
        and not _OBLIGATION.search(stripped)
        and stripped.endswith((".", "!", "?"))
        and 0 < len(stripped.split()) <= MAX_MARKER_WORDS
    )


# A label that opens a part printed under a requirement: "Satisfies:", "Note:", "Rationale:", "Verification method:".
_PART_LABEL = re.compile(r"^\s*([^\W\d_][\w ]{0,30}?):(?:\s|$)")
# A part label is learned when it opens at least this many paragraphs printed inside requirements.
MIN_PART_LABEL_COUNT = 3
# A section body of at most this many words, with no obligation, is a marker ("None.", "Not applicable.").
MAX_MARKER_WORDS = 6
# A code shape is applied only when it opens at least this many paragraphs and the document numbers at least this many headings.
MIN_UNITS = 5
MIN_SECTIONS = 3
# ... and when at least this share of its headings carry a number (the sections nest by their numbers).
MIN_NUMBERED_SHARE = 0.8

LeafConvention = Literal["feature_and_requirement", "heading_is_requirement"]
EmptyTreatment = Literal["empty_feature", "leave_out"]


@dataclass(frozen=True)
class DocumentGrammar:
    code: CodeShape
    part_labels: tuple[str, ...]
    leaf_convention: LeafConvention = "feature_and_requirement"
    empty_treatment: EmptyTreatment = "empty_feature"
    # Heading block ids the pre-study confirmed as context or back matter; empty when only code learned the grammar.
    context_heading_ids: frozenset[str] = frozenset()
    back_matter_heading_ids: frozenset[str] = frozenset()
    source: Literal["code", "model"] = "code"


@dataclass
class _Section:
    heading: Block
    number: str
    depth: int
    body: list[Block] = field(default_factory=list)
    tables: list[Table] = field(default_factory=list)
    children: list[_Section] = field(default_factory=list)
    parent: _Section | None = None

    @property
    def title(self) -> str:
        return " ".join(self.heading.text.split())

    def subtree(self) -> list[_Section]:
        return [self, *(s for c in self.children for s in c.subtree())]


@dataclass
class GrammarResult:
    nodes: list[WorkItemNode]
    warnings: list[IntegrityWarning]
    left_out: list[tuple[str, int | None, int | None]]  # (heading, first page, last page) of what was left out, in document order


def _paragraphs(doc: CanonicalDoc) -> list[str]:
    return [b.text for b in doc.blocks if b.kind in (BlockKind.PARAGRAPH, BlockKind.LIST_ITEM)]


def learn_grammar(doc: CanonicalDoc, rulebook: object | None = None) -> DocumentGrammar | None:
    """The document's grammar, or None when it states none this module applies (no clear code shape, or too few numbered sections).

    A code shape the pre-study confirmed (`rulebook.document.requirement_codes`, example codes it named and code checked) is preferred;
    otherwise the shape is learned from the document's own paragraphs."""
    document = getattr(rulebook, "document", None)
    if getattr(document, "labels", ()):
        return None  # the headings state their own item types ("Feature: ..."): those are final, the stated-type path builds them
    if getattr(document, "depth_types", ()) and not (document.has_grammar() if hasattr(document, "has_grammar") else False):
        return None  # the pre-study typed the headings by depth and confirmed no grammar: its types are final
    code: CodeShape | None = None
    source: Literal["code", "model"] = "code"
    examples = tuple(getattr(document, "requirement_codes", ()) or ())
    if examples:
        code = CodeShape.from_examples(examples)
        source = "model" if code is not None else "code"
    if code is None:
        code = learn_code_shape(_paragraphs(doc))
    if code is None:
        return None
    units = sum(1 for text in _paragraphs(doc) if code.opens(text))
    headings = [b for b in doc.blocks if b.kind == BlockKind.HEADING]
    numbered = sum(1 for b in headings if parse_numbering(b.text)[0] is not None)
    # The grammar nests sections by their numbers: a document whose headings are mostly unnumbered is built as before.
    if units < MIN_UNITS or numbered < MIN_SECTIONS or numbered < MIN_NUMBERED_SHARE * len(headings):
        return None
    return DocumentGrammar(
        code=code,
        part_labels=_learn_part_labels(doc, code),
        leaf_convention=getattr(document, "leaf_convention", None) or "feature_and_requirement",
        empty_treatment=getattr(document, "empty_treatment", None) or "empty_feature",
        context_heading_ids=frozenset(getattr(document, "context_headings", ()) or ()),
        back_matter_heading_ids=frozenset(getattr(document, "back_matter_headings", ()) or ()),
        source=source,
    )


def _learn_part_labels(doc: CanonicalDoc, code: CodeShape) -> tuple[str, ...]:
    """The labels that open paragraphs printed inside requirements (after a unit opened, before the next heading) often enough."""
    counts: Counter[str] = Counter()
    inside = False
    for block in doc.blocks:
        if block.kind == BlockKind.HEADING:
            inside = False
        elif code.opens(block.text):
            inside = True
        elif inside:
            match = _PART_LABEL.match(block.text)
            if match:
                counts[match.group(1).strip()] += 1
    return tuple(sorted(label for label, n in counts.items() if n >= MIN_PART_LABEL_COUNT))


def _sections(doc: CanonicalDoc, unowned_tables: list[Table] | None = None) -> tuple[list[Block], list[_Section]]:
    """(blocks before the first numbered heading, the numbered sections as a forest). A heading's depth is its number's depth."""
    roots: list[_Section] = []
    stack: list[_Section] = []
    preamble: list[Block] = []
    unowned = unowned_tables if unowned_tables is not None else []
    current: _Section | None = None
    for block in doc.blocks:
        label = parse_numbering(block.text)[0] if block.kind == BlockKind.HEADING else None
        if block.kind == BlockKind.HEADING and label is None and current is not None:
            # An unnumbered heading (an appendix, a sub-title) is never swallowed into the text before it: a top-level heading opens a
            # chapter, any other heading a subsection of the section it follows.
            depth = 1 if (block.heading_level or 1) <= 1 else stack[-1].depth + 1 if stack else 1
            label = ""
        if label is not None:
            depth = numbering_depth(label) if label else depth
            section = _Section(heading=block, number=label.rstrip("."), depth=depth)
            while stack and stack[-1].depth >= section.depth:
                stack.pop()
            if stack:
                section.parent = stack[-1]
                stack[-1].children.append(section)
            else:
                roots.append(section)
            stack.append(section)
            current = section
        elif current is None:
            preamble.append(block)
        else:
            current.body.append(block)
    # Tables go to the section whose heading precedes them in document order.
    ordered = [s for r in roots for s in r.subtree()]
    for table in doc.tables:
        owner = None
        for section in ordered:
            if _order(section.heading.source_ref) <= _order(table.source_ref):
                owner = section
        if owner is not None:
            owner.tables.append(table)
        else:
            unowned.append(table)
    return preamble, roots


def _order(ref: SourceRef) -> tuple[int, int]:
    return (ref.page or 0, ref.start_offset)


@dataclass
class _Unit:
    code: str | None
    body: str  # the requirement's own text, verbatim (with its code, as printed)
    blocks: list[Block]
    title_text: str = ""  # the text the title is taken from: the body without its code
    parts: list[str] = field(default_factory=list)
    trace: list[str] = field(default_factory=list)  # the trace printed under it ("Satisfies:" and its parent codes), verbatim
    in_parts: bool = False

    def text(self) -> str:
        """The requirement's text with its lists and Notes, then its trace set apart by a blank line: the trace stays in the description,
        word for word, but never runs into the requirement itself."""
        statement = "\n".join([self.body, *self.parts])
        return f"{statement}\n\n{chr(10).join(self.trace)}" if self.trace else statement


def _is_marker(section: _Section) -> bool:
    text = " ".join(b.text for b in section.body)
    return (
        not section.children
        and not section.tables
        and len(section.body) == 1
        and 0 < len(text.split()) <= MAX_MARKER_WORDS
        and not _OBLIGATION.search(text)
    )


class _Builder:
    def __init__(self, doc: CanonicalDoc, grammar: DocumentGrammar, doc_title: str, hash_description, hash_identity) -> None:  # noqa: ANN001
        self.doc, self.g = doc, grammar
        self.doc_title = doc_title
        self.hash_description, self.hash_identity = hash_description, hash_identity
        self.nodes: list[WorkItemNode] = []
        self.left_out: list[tuple[str, int | None, int | None]] = []
        self.context: list[str] = []
        self.empty: list[str] = []
        self.fresh: dict[str, bool] = {}

    # --- units ------------------------------------------------------------------------------------------------------------------------
    def _opens_part(self, text: str) -> bool:
        match = _PART_LABEL.match(text)
        return bool(match) and match.group(1).strip() in self.g.part_labels

    def _units(self, section: _Section) -> tuple[list[Block], list[_Unit]]:
        """(the section's own text before its first requirement, its requirement units), in order."""
        intro: list[Block] = []
        units: list[_Unit] = []
        for block in section.body:
            text = block.text
            lead = self.g.code.leading(text)
            current = units[-1] if units else None
            if lead is not None:
                units.append(_Unit(code=lead[0], body=text.strip(), blocks=[block], title_text=lead[1].strip()))
            elif self._new_uncoded_statement(text, current):
                units.append(_Unit(code=None, body=text.strip(), blocks=[block], title_text=text.strip()))
            elif current is None:
                intro.append(block)
            else:
                (current.trace if self._is_trace(text, current) else current.parts).append(text.strip())
                current.blocks.append(block)
                if self._opens_part(text) or _is_code_list(text):
                    current.in_parts = True
        return intro, units

    def _is_trace(self, text: str, current: _Unit) -> bool:
        """A trace line: a learned part label followed by nothing but codes ("Satisfies: GCS_2 SYS_11"), or a bare list of codes that
        continues a trace (the codes after a page break). A Note ("Note: The rail type ...") is a label followed by words: not a trace."""
        match = _PART_LABEL.match(text)
        if match and match.group(1).strip() in self.g.part_labels:
            rest = text[match.end() :].strip()
            return not rest or _is_code_list(rest)
        return bool(current.trace) and _is_code_list(text)

    def _new_uncoded_statement(self, text: str, current: _Unit | None) -> bool:
        """A complete statement with an obligation and no code is a requirement of its own after the trailing parts of the requirement
        before it began (a learned part label such as "Satisfies:", or a bare list of codes) -- never inside a requirement's own text or
        list, and never before the section's first requirement (an intro such as "The following requirements shall apply.")."""
        stripped = text.strip()
        if current is None or not current.in_parts:
            return False
        return (
            bool(stripped)
            and stripped[0].isupper()
            and not self._opens_part(stripped)
            and bool(_OBLIGATION.search(stripped))
            and stripped.endswith((".", "!", "?"))
            and len(stripped.split()) >= 5
        )

    # --- nodes ------------------------------------------------------------------------------------------------------------------------
    def _node(self, local_id: str, type_: WorkItemType, parent: str | None, title: str, description: str, ref: SourceRef,
              customer_id: str | None = None) -> WorkItemNode:  # fmt: skip
        node = WorkItemNode(
            local_id=local_id,
            type=type_,
            parent_local_id=parent,
            title=title[:256],
            source_title=title[:256],
            description=description,
            customer_id=customer_id,
            source_ref=ref,
            fidelity_hash=self.hash_description(description),
            identity_hash=self.hash_identity(description, ref),
            tags=[],
            mode=WorkItemMode.BASELINE,
            child_type=WorkItemType.REQUIREMENT if type_ != WorkItemType.EPIC else WorkItemType.FEATURE,
            verbatim=True,
        )
        self.nodes.append(node)
        return node

    def _ref(self, blocks: list[Block], path: list[str]) -> SourceRef:
        first, last = blocks[0].source_ref, blocks[-1].source_ref
        page_end = last.page_end or last.page
        return first.model_copy(
            update={"section_path": path, "page_end": page_end if page_end != first.page else first.page_end}
        )

    def _tables_html(self, tables: list[Table]) -> list[str]:
        from app.leveling.tree_builder import _table_to_html

        return [_table_to_html(t) for t in tables]

    def build(self, preamble: list[Block], roots: list[_Section]) -> None:
        title_block = next((b for b in self.doc.blocks if b.kind == BlockKind.TITLE), None)
        epic_ref = (title_block or (roots[0].heading if roots else self.doc.blocks[0])).source_ref.model_copy(update={"section_path": []})
        description = self.doc_title
        for block in preamble:
            if block.kind != BlockKind.TITLE:
                description = assemble_description(description, block.text)
        epic = self._node("g_epic", WorkItemType.EPIC, None, self.doc_title, description, epic_ref)

        # A chapter whose coded paragraphs only repeat codes already stated (a traceability listing written as paragraphs) holds no
        # requirement of its own: it is back matter, not a second copy of the requirements.
        seen: set[str] = set()
        self.fresh: dict[str, bool] = {}
        for root in roots:
            codes = [lead[0] for s in root.subtree() for b in s.body if (lead := self.g.code.leading(b.text)) is not None]
            self.fresh[root.heading.id] = any(c not in seen for c in codes)
            seen.update(codes)
        with_units = [r for r in roots if self._holds_units(r)]
        first_req = roots.index(with_units[0]) if with_units else len(roots)
        last_req = roots.index(with_units[-1]) if with_units else -1
        for i, root in enumerate(roots):
            if root.heading.id in self.g.back_matter_heading_ids or (i > last_req and not self._holds_units(root)):
                self._leave_out(root)
            elif not self._holds_units(root) or root.heading.id in self.g.context_heading_ids:
                self._context_chapter(root, epic, before_requirements=i < first_req)
            else:
                self._section(root, epic, [])

    def _holds_units(self, section: _Section) -> bool:
        if not self.fresh.get(section.heading.id, True):
            return False
        return any(self.g.code.opens(b.text) for s in section.subtree() for b in s.body)

    def _leave_out(self, section: _Section) -> None:
        self.left_out.append((section.title[:80], section.heading.source_ref.page, _last_page(section)))

    def _context_chapter(self, root: _Section, epic: WorkItemNode, before_requirements: bool) -> None:
        """A chapter with no requirements: one Feature whose description holds its prose; its sections with tables (revision history,
        references, abbreviations), before the requirement chapters, are front matter and left out."""
        description = root.title
        if before_requirements and root.tables:
            # A table directly under the chapter heading (a document history) is front matter too: reported, never dropped silently.
            page = root.tables[0].source_ref.page or root.heading.source_ref.page
            self.left_out.append((f"{root.title[:70]} (table)", page, page))
        for section in root.subtree():
            if section is not root and before_requirements and section.tables:
                self._leave_out(section)
                continue
            if section is not root:
                description = assemble_description(description, section.title)
                self.context.append(section.title)
            for block in section.body:
                description = assemble_description(description, block.text)
            if not before_requirements:
                for html in self._tables_html(section.tables):
                    description = assemble_description(description, html)
        ref = self._ref([root.heading], [root.title])
        self._node(f"g_{root.heading.id}", WorkItemType.FEATURE, epic.local_id, root.title, description, ref)

    def _section(self, section: _Section, parent: WorkItemNode, path: list[str]) -> None:
        path = [*path, section.title]
        if section.heading.id in self.g.context_heading_ids and not self._holds_units(section):
            # Confirmed by the pre-study as describing the document: kept in its parent's description, never an item.
            for part in [s for s in section.subtree()]:
                text = "\n".join([part.title, *(b.text for b in part.body)])
                parent.description = assemble_description(parent.description, text)
            parent.fidelity_hash = self.hash_description(parent.description)
            parent.identity_hash = self.hash_identity(parent.description, parent.source_ref)
            self.context.append(section.title)
            return
        if _is_marker(section):
            if self.g.empty_treatment == "leave_out":
                self._leave_out(section)
                return
            self.empty.append(section.title)
            marker = " ".join(section.body[0].text.split())
            self._node(f"g_{section.heading.id}", WorkItemType.FEATURE, parent.local_id, section.title,
                       f"{section.title}\n{marker}", self._ref([section.heading, *section.body], path))  # fmt: skip
            return
        intro, units = self._units(section)
        description = section.title
        for block in intro:
            description = assemble_description(description, block.text)
        tables = self._tables_html(section.tables)
        if not units:
            for html in tables:
                description = assemble_description(description, html)
        if self.g.leaf_convention == "heading_is_requirement" and not section.children and len(units) == 1:
            unit = units[0]
            text = assemble_description(unit.text(), "\n".join(tables)) if tables else unit.text()
            self._node(f"g_{section.heading.id}", WorkItemType.REQUIREMENT, parent.local_id, section.title, text,
                       self._ref([section.heading, *unit.blocks], path), unit.code)  # fmt: skip
            return
        feature = self._node(f"g_{section.heading.id}", WorkItemType.FEATURE, parent.local_id, section.title, description,
                             self._ref([section.heading, *intro], path))  # fmt: skip
        for k, unit in enumerate(units, start=1):
            text = unit.text()
            if tables and k == len(units):
                text = assemble_description(text, "\n".join(tables))
            self._node(f"g_{unit.blocks[0].id}", WorkItemType.REQUIREMENT, feature.local_id, extract_baseline_title(unit.title_text),
                       text, self._ref(unit.blocks, path), unit.code)  # fmt: skip
        for child in section.children:
            self._section(child, feature, path)


def build_grammar_tree(doc: CanonicalDoc, grammar: DocumentGrammar, doc_title: str, hash_description, hash_identity) -> GrammarResult:  # noqa: ANN001
    """The tree `doc` states under `grammar` (see the module docstring). `doc` has its cover and contents already left out."""
    unowned: list[Table] = []
    preamble, roots = _sections(doc, unowned)
    builder = _Builder(doc, grammar, doc_title, hash_description, hash_identity)
    builder.build(preamble, roots)
    if unowned and builder.nodes:
        # A table before the first section is kept in the Epic's description: no table is ever dropped.
        epic = builder.nodes[0]
        for html in builder._tables_html(unowned):
            epic.description = assemble_description(epic.description, html)
        epic.fidelity_hash = hash_description(epic.description)
        epic.identity_hash = hash_identity(epic.description, epic.source_ref)
    warnings: list[IntegrityWarning] = []
    if builder.context:
        names = "; ".join(f'"{t}"' for t in builder.context[:10]) + (" ..." if len(builder.context) > 10 else "")
        warnings.append(
            IntegrityWarning.make(
                WarningKind.INFORMATIONAL_SECTION_FOLDED,
                f"Described the document rather than stating a requirement, so kept in the parent item's description, not made a Requirement: {names}.",
                node_ids=[],
                detail={"sections": builder.context},
            )
        )
    return GrammarResult(nodes=builder.nodes, warnings=warnings, left_out=builder.left_out)


def document_code_shape(doc: CanonicalDoc, rulebook: object | None = None) -> CodeShape | None:
    """The document's requirement-code shape: the one the pre-study confirmed, else the one code learns from the paragraphs."""
    examples = tuple(getattr(getattr(rulebook, "document", None), "requirement_codes", ()) or ())
    return (CodeShape.from_examples(examples) if examples else None) or learn_code_shape(_paragraphs(doc))


def requirement_coverage(doc: CanonicalDoc, nodes: list[WorkItemNode], rulebook: object | None = None) -> IntegrityWarning | None:
    """A warning naming the requirements the document numbers with its own code that are in no Requirement item (their text is in no
    Requirement's description, as printed), or None. Computed by comparing the tree with the document: "nothing is missing" is never
    assumed."""
    shape = document_code_shape(doc, rulebook)
    if shape is None:
        return None
    codes: list[str] = []
    for text in _paragraphs(doc):
        lead = shape.leading(text)
        if lead is not None and lead[0] not in codes:
            codes.append(lead[0])
    held = {n.customer_id for n in nodes if n.customer_id}
    in_requirements = {
        lead[0]
        for n in nodes
        if n.type == WorkItemType.REQUIREMENT
        for line in n.description.splitlines()
        if (lead := shape.leading(line)) is not None
    }
    missing = [c for c in codes if c not in held and c not in in_requirements]
    if not missing:
        return None
    names = ", ".join(missing[:12]) + (" ..." if len(missing) > 12 else "")
    return IntegrityWarning.make(
        WarningKind.REQUIREMENTS_NOT_ITEMS,
        f"{len(missing)} requirement(s) the document numbers with its own code are in no Requirement item: {names}. Their text is inside "
        "another item or was not read.",
        detail={"codes": missing, "codeShape": shape.shape, "documentCodes": len(codes)},
    )


def _is_code_list(text: str) -> bool:
    """A paragraph that is only codes ("GCS_9 SYS_45", "SYS_12.1"): parent references of a trace, continued without their label."""
    words = text.split()
    return bool(words) and all(any(c.isalpha() for c in w) and any(c.isdigit() for c in w) for w in words)


def _last_page(section: _Section) -> int | None:
    """The last page a section reaches, with its subsections and tables (a traceability listing over three pages)."""
    pages = [
        ref.page_end or ref.page
        for part in section.subtree()
        for ref in [part.heading.source_ref, *(b.source_ref for b in part.body), *(t.source_ref for t in part.tables)]
        if (ref.page_end or ref.page) is not None
    ]
    return max(pages) if pages else None
