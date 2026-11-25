"""The rules a file follows, as plain data: what the pre-study (deterministic detectors, or a model's validated answer) hands to the builders.

A `RuleSpec` says, for one table, which column is what and how a row's type and parent are known; `DocumentRules` says how a document's headings state
their type. Both are *structural*: column numbers, closed vocabularies and exact copied values, never item text. The same spec feeds the same builder
whether a header detector or a model produced it, and `FileRulebook.hash` is taken over the canonical form only, so two answers that mean the same
thing are the same rulebook (same hash, same tree)."""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from dataclasses import dataclass, field

LADDER = ("Epic", "Feature", "Requirement")

# How a row's parent is written. "levels" (Title 1..N columns), "level_number" (a depth number per row), "outline_number" (1.2.3 dots),
# "id_parent" (ID + Parent columns) and "order" (row order and types).
NESTINGS = ("levels", "level_number", "outline_number", "id_parent", "order")


# What a model changes when it "copies exactly": typographic quotes and dashes for the plain ones (a Hebrew geresh for an apostrophe), and invisible
# direction marks around right-to-left text. None of that is a different value, so none of it is compared.
_TYPOGRAPHY = str.maketrans(
    {"\u2019": "'", "\u2018": "'", "\u05f3": "'", "\u02bc": "'", "`": "'", "\u00b4": "'", "\u201c": '"', "\u201d": '"', "\u201e": '"', "\u05f4": '"', "\u2013": "-", "\u2014": "-", "\u2212": "-"}
)


def fold(value: str) -> str:
    """The form a copied value is compared in: NFC, invisible format characters (direction marks, zero-width joiners) dropped, typographic quotes and
    dashes made plain, case-folded, whitespace collapsed. Two spellings of one value are one value."""
    text = "".join(ch for ch in unicodedata.normalize("NFC", value) if unicodedata.category(ch) != "Cf").translate(_TYPOGRAPHY)
    return re.sub(r"\s+", " ", text).strip().casefold()


@dataclass(frozen=True)
class RuleSpec:
    """How one table states its items. Column numbers count from 0, as in the grid the pre-study was shown."""

    header_row: int
    nesting: str
    type_col: int | None = None
    level_cols: tuple[int, ...] = ()  # outermost first
    level_col: int | None = None  # the column holding a depth number or an outline number
    title_col: int | None = None
    id_col: int | None = None
    parent_col: int | None = None
    customer_id_col: int | None = None
    description_cols: tuple[int, ...] = ()
    # The type column's values: folded value -> Epic/Feature/Requirement, or None for a value that is not imported (Test Case, Bug). A value
    # missing here is not imported either. None (no map at all) means the values are the ladder's own names.
    type_map: dict[str, str | None] | None = field(default=None, compare=True)
    # With no type column, the type of each depth (0 = outermost).
    level_types: dict[int, str] | None = field(default=None, compare=True)
    origin: str = "stated"  # "stated" (header detector), "model" or "user"

    def canonical(self) -> dict:
        return {
            "header_row": self.header_row,
            "nesting": self.nesting,
            "type_col": self.type_col,
            "level_cols": list(self.level_cols),
            "level_col": self.level_col,
            "title_col": self.title_col,
            "id_col": self.id_col,
            "parent_col": self.parent_col,
            "customer_id_col": self.customer_id_col,
            "description_cols": sorted(self.description_cols),
            "type_map": None if self.type_map is None else sorted((fold(k), v) for k, v in self.type_map.items()),
            "level_types": None if self.level_types is None else sorted(self.level_types.items()),
        }


@dataclass(frozen=True)
class LabelRule:
    """A heading label convention ("Feature: Power", "דרישה 3.1 - ...") and the type it states."""

    label: str
    separator: str
    type: str  # Epic / Feature / Requirement


# What a front-matter part is, as the pre-study names it and the wizard shows it.
FRONT_MATTER_ROLES = ("cover", "notice", "revision_history", "contents", "abbreviations", "glossary", "other")


@dataclass(frozen=True)
class FrontMatterPart:
    """A heading that opens front matter (its whole section is left out of the items): the heading's block id and what it is."""

    block_id: str
    role: str


@dataclass(frozen=True)
class DocumentRules:
    labels: tuple[LabelRule, ...] = ()
    depth_types: tuple[tuple[int, str], ...] = ()  # (0-based nesting depth, type), only when the document is consistent
    origin: str = "model"
    # The front matter the pre-study found and code checked (study/model_rules.validate_document_answer), used by the structure step
    # (leveling/document_layout.py) to leave those sections out.
    front_matter: tuple[FrontMatterPart, ...] = ()
    # The document's grammar as the pre-study confirmed it and code checked (leveling/document_grammar.py): example requirement codes
    # (code induces their shape), how a section with one requirement is built, what a "None." section becomes, and the headings of
    # sections that describe the document (context) or follow its requirements (back matter).
    requirement_codes: tuple[str, ...] = ()
    leaf_convention: str | None = None  # "feature_and_requirement" | "heading_is_requirement"
    empty_treatment: str | None = None  # "empty_feature" | "leave_out"
    context_headings: tuple[str, ...] = ()  # heading block ids
    back_matter_headings: tuple[str, ...] = ()  # heading block ids

    def has_grammar(self) -> bool:
        return bool(
            self.requirement_codes
            or self.leaf_convention
            or self.empty_treatment
            or self.context_headings
            or self.back_matter_headings
        )

    def canonical(self) -> dict:
        canonical: dict = {
            "labels": sorted((fold(r.label), r.separator, r.type) for r in self.labels),
            "depth_types": sorted(self.depth_types),
        }
        if self.front_matter:  # only when present, so a rulebook stored before front matter existed keeps its hash
            canonical["front_matter"] = sorted((p.block_id, p.role) for p in self.front_matter)
        if self.has_grammar():  # the same: a rulebook stored before the grammar existed keeps its hash
            canonical["grammar"] = {
                "requirement_codes": sorted(self.requirement_codes),
                "leaf_convention": self.leaf_convention,
                "empty_treatment": self.empty_treatment,
                "context_headings": sorted(self.context_headings),
                "back_matter_headings": sorted(self.back_matter_headings),
            }
        return canonical


@dataclass(frozen=True)
class FileRulebook:
    """Everything the pre-study learned about one file: a spec per table (by table id) and the document's heading rules."""

    tables: dict[str, RuleSpec] = field(default_factory=dict)
    document: DocumentRules | None = None

    def canonical(self) -> dict:
        return {
            "tables": {table_id: spec.canonical() for table_id, spec in sorted(self.tables.items())},
            "document": self.document.canonical() if self.document is not None else None,
        }

    @property
    def hash(self) -> str:
        text = json.dumps(self.canonical(), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        return hashlib.sha256(text.encode()).hexdigest()

    def is_empty(self) -> bool:
        return not self.tables and (
            self.document is None
            or not (self.document.labels or self.document.depth_types or self.document.front_matter or self.document.has_grammar())
        )


# --------------------------------------------------------------------------------------------------------------------------------------------
# JSON: the form a rulebook is stored, shown, edited and sent to /level in. Read strictly: an edit made in the wizard arrives through here.
# --------------------------------------------------------------------------------------------------------------------------------------------

RULEBOOK_VERSION = 1


def _int(value: object, name: str, *, low: int = 0, high: int = 10_000) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not low <= value <= high:
        raise ValueError(f"{name} must be a whole number from {low} to {high}")
    return value


def _int_or_none(value: object, name: str) -> int | None:
    return None if value is None else _int(value, name)


def _ladder(value: object, name: str, *, allow_none: bool) -> str | None:
    if value is None and allow_none:
        return None
    if value not in LADDER:
        raise ValueError(f"{name} must be one of {', '.join(LADDER)}" + (" or null" if allow_none else ""))
    return value  # type: ignore[return-value]


def spec_to_json(spec: RuleSpec) -> dict:
    return {
        "header_row": spec.header_row,
        "nesting": spec.nesting,
        "type_col": spec.type_col,
        "level_cols": list(spec.level_cols),
        "level_col": spec.level_col,
        "title_col": spec.title_col,
        "id_col": spec.id_col,
        "parent_col": spec.parent_col,
        "customer_id_col": spec.customer_id_col,
        "description_cols": list(spec.description_cols),
        "type_map": None if spec.type_map is None else dict(spec.type_map),  # a copy: the spec is frozen, its JSON form is not
        "level_types": None if spec.level_types is None else {str(k): v for k, v in spec.level_types.items()},
        "origin": spec.origin,
    }


def spec_from_json(raw: object, origin: str | None = None) -> RuleSpec:
    if not isinstance(raw, dict):
        raise ValueError("a table's rules must be an object")
    nesting = raw.get("nesting")
    if nesting not in NESTINGS:
        raise ValueError(f"nesting must be one of {', '.join(NESTINGS)}")
    type_map_raw = raw.get("type_map")
    type_map: dict[str, str | None] | None = None
    if type_map_raw is not None:
        if not isinstance(type_map_raw, dict) or len(type_map_raw) > 200:
            raise ValueError("type_map must be an object of at most 200 values")
        type_map = {fold(str(k)): _ladder(v, f"type_map['{k}']", allow_none=True) for k, v in type_map_raw.items()}
    level_types_raw = raw.get("level_types")
    level_types: dict[int, str] | None = None
    if level_types_raw is not None:
        if not isinstance(level_types_raw, dict) or len(level_types_raw) > 9:
            raise ValueError("level_types must be an object of at most 9 depths")
        level_types = {_int(int(k) if str(k).isdigit() else -1, "a depth", high=8): _ladder(v, "a depth's type", allow_none=False) for k, v in level_types_raw.items()}  # type: ignore[misc]
    columns = raw.get("level_cols", [])
    descriptions = raw.get("description_cols", [])
    if not isinstance(columns, list) or not isinstance(descriptions, list) or len(columns) > 9 or len(descriptions) > 60:
        raise ValueError("level_cols and description_cols must be short lists of column numbers")
    return RuleSpec(
        header_row=_int(raw.get("header_row"), "header_row", high=5),
        nesting=nesting,
        type_col=_int_or_none(raw.get("type_col"), "type_col"),
        level_cols=tuple(_int(c, "a level column") for c in columns),
        level_col=_int_or_none(raw.get("level_col"), "level_col"),
        title_col=_int_or_none(raw.get("title_col"), "title_col"),
        id_col=_int_or_none(raw.get("id_col"), "id_col"),
        parent_col=_int_or_none(raw.get("parent_col"), "parent_col"),
        customer_id_col=_int_or_none(raw.get("customer_id_col"), "customer_id_col"),
        description_cols=tuple(_int(c, "a description column") for c in descriptions),
        type_map=type_map,
        level_types=level_types,
        origin=origin or ("user" if raw.get("origin") == "user" else "model"),
    )


def rulebook_to_json(rulebook: FileRulebook) -> dict:
    document = rulebook.document
    return {
        "version": RULEBOOK_VERSION,
        "hash": rulebook.hash,
        "tables": {table_id: spec_to_json(spec) for table_id, spec in sorted(rulebook.tables.items())},
        "document": None
        if document is None
        else {
            "labels": [{"label": r.label, "separator": r.separator, "type": r.type} for r in document.labels],
            "depth_types": [[depth, name] for depth, name in document.depth_types],
            "front_matter": [{"block_id": p.block_id, "role": p.role} for p in document.front_matter],
            "origin": document.origin,
            **(
                {
                    "grammar": {
                        "requirement_codes": list(document.requirement_codes),
                        "leaf_convention": document.leaf_convention,
                        "empty_treatment": document.empty_treatment,
                        "context_headings": list(document.context_headings),
                        "back_matter_headings": list(document.back_matter_headings),
                    }
                }
                if document.has_grammar()
                else {}
            ),
        },
    }


def rulebook_from_json(raw: object, origin: str | None = None) -> FileRulebook:
    """A rulebook from its JSON form, or ValueError naming what is wrong. The `hash` in the JSON is never trusted: it is recomputed."""
    if not isinstance(raw, dict):
        raise ValueError("a rulebook must be an object")
    if raw.get("version", RULEBOOK_VERSION) != RULEBOOK_VERSION:
        raise ValueError(f"rulebook version {raw.get('version')} is not supported")
    tables_raw = raw.get("tables", {})
    if not isinstance(tables_raw, dict) or len(tables_raw) > 200:
        raise ValueError("tables must be an object of at most 200 tables")
    tables = {str(table_id): spec_from_json(spec, origin) for table_id, spec in tables_raw.items()}
    document_raw = raw.get("document")
    document: DocumentRules | None = None
    if document_raw is not None:
        if not isinstance(document_raw, dict):
            raise ValueError("document rules must be an object")
        labels_raw, depth_raw = document_raw.get("labels", []), document_raw.get("depth_types", [])
        if not isinstance(labels_raw, list) or not isinstance(depth_raw, list) or len(labels_raw) > 12 or len(depth_raw) > 9:
            raise ValueError("labels and depth_types must be short lists")
        labels = []
        for item in labels_raw:
            if not isinstance(item, dict) or not isinstance(item.get("label"), str) or not item["label"].strip() or len(item["label"]) > 40:
                raise ValueError("a label must be a short word")
            if item.get("separator") not in (":", "-", "–", "—", "."):
                raise ValueError("a label's separator must be one of : - – — .")
            labels.append(LabelRule(item["label"].strip(), item["separator"], _ladder(item.get("type"), "a label's type", allow_none=False)))  # type: ignore[arg-type]
        depths = []
        for item in depth_raw:
            if not isinstance(item, (list, tuple)) or len(item) != 2:
                raise ValueError("a depth type must be a [depth, type] pair")
            depths.append((_int(item[0], "a depth", high=8), _ladder(item[1], "a depth's type", allow_none=False)))
        front_raw = document_raw.get("front_matter", [])
        if not isinstance(front_raw, list) or len(front_raw) > 40:
            raise ValueError("front_matter must be a short list")
        front = []
        for item in front_raw:
            if (
                not isinstance(item, dict)
                or not isinstance(item.get("block_id"), str)
                or not item["block_id"]
                or len(item["block_id"]) > 64
                or item.get("role") not in FRONT_MATTER_ROLES
            ):
                raise ValueError("a front-matter part must be a block id and one of " + ", ".join(FRONT_MATTER_ROLES))
            front.append(FrontMatterPart(item["block_id"], item["role"]))
        grammar = _grammar_from_json(document_raw.get("grammar"))
        document = DocumentRules(labels=tuple(labels), depth_types=tuple(sorted(dict(depths).items())), origin=origin or ("user" if document_raw.get("origin") == "user" else "model"), front_matter=tuple(front), **grammar)  # type: ignore[arg-type]
    return FileRulebook(tables=tables, document=document)


LEAF_CONVENTIONS = ("feature_and_requirement", "heading_is_requirement")
EMPTY_TREATMENTS = ("empty_feature", "leave_out")


def _grammar_from_json(raw: object) -> dict:
    """The grammar fields of DocumentRules from their JSON form ({} when absent), or ValueError naming what is wrong."""
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ValueError("the grammar must be an object")

    def strings(key: str, limit: int, length: int) -> tuple[str, ...]:
        value = raw.get(key, [])
        if not isinstance(value, list) or len(value) > limit or not all(isinstance(v, str) and 0 < len(v) <= length for v in value):
            raise ValueError(f"{key} must be a short list of short strings")
        return tuple(value)

    leaf, empty = raw.get("leaf_convention"), raw.get("empty_treatment")
    if leaf is not None and leaf not in LEAF_CONVENTIONS:
        raise ValueError("leaf_convention must be one of " + ", ".join(LEAF_CONVENTIONS))
    if empty is not None and empty not in EMPTY_TREATMENTS:
        raise ValueError("empty_treatment must be one of " + ", ".join(EMPTY_TREATMENTS))
    return {
        "requirement_codes": strings("requirement_codes", 12, 40),
        "leaf_convention": leaf,
        "empty_treatment": empty,
        "context_headings": strings("context_headings", 60, 64),
        "back_matter_headings": strings("back_matter_headings", 20, 64),
    }
