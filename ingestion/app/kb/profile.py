"""The KB profile: what a user's whole knowledge base says about how work items are defined, written and judged.

Before this, the KB reached a job as the top few chunks of whichever documents ranked first, the scoring categories came
from the single best-matching document (a prod KB of three documents scored by one), and each document's checklist was
read from the first 12,000 characters only. The profile is built from EVERY document:

  map     per document: a relevance verdict (is it about creating requirements and the Epic/Feature/Requirement hierarchy at
          all?), then the document is read in overlapping windows and its categories with pass conditions, work-item type
          definitions, mandatory writing rules and glossary terms are extracted;
  reduce  one deterministic merge: duplicates collapse (case, spacing and punctuation variants), every entry keeps the files
          that support it, two documents that define the same thing differently are kept as a visible conflict (never
          silently resolved), and the result is capped with a stable ranking;
  store   one profile per user, rebuilt only when a document's text, the set of documents or the building model changes.

The profile accounts for every document (`docs`): contributed, judged not relevant (with the model's reason), nothing
extractable, or failed. Nothing is dropped without a record. The merge is a pure function of the per-document results and
does not depend on the order documents arrive in."""
from __future__ import annotations

import hashlib
import json
import logging
import re
from typing import Literal, Protocol

from pydantic import BaseModel, Field

from app.request_identity import redact_identity

logger = logging.getLogger(__name__)

SCHEMA_VERSION = "kb-profile-1"
WINDOW_CHARS = 10_000
WINDOW_OVERLAP = 500
RELEVANCE_EXCERPT_CHARS = 1_500
MAX_CATEGORIES = 40
MAX_RULES = 60
MAX_GLOSSARY = 80

ItemType = Literal["epic", "feature", "requirement"]
DocStatus = Literal["contributed", "not_relevant", "extracted_nothing", "failed"]


class Variant(BaseModel):
    text: str
    sources: list[str]


class Category(BaseModel):
    name: str
    pass_condition: str | None = None
    sources: list[str]


class TypeDefinition(BaseModel):
    item_type: ItemType
    text: str
    sources: list[str]


class Rule(BaseModel):
    text: str
    sources: list[str]


class GlossaryTerm(BaseModel):
    term: str
    definition: str
    sources: list[str]


class Conflict(BaseModel):
    kind: Literal["category", "type_definition"]
    key: str
    variants: list[Variant]


class DocumentStatus(BaseModel):
    file: str
    status: DocStatus
    reason: str | None = None
    categories: int = 0
    rules: int = 0
    type_definitions: int = 0
    glossary: int = 0


class KbProfile(BaseModel):
    version: str
    built_with: str
    docs: list[DocumentStatus] = Field(default_factory=list)
    categories: list[Category] = Field(default_factory=list)
    type_definitions: list[TypeDefinition] = Field(default_factory=list)
    rules: list[Rule] = Field(default_factory=list)
    glossary: list[GlossaryTerm] = Field(default_factory=list)
    conflicts: list[Conflict] = Field(default_factory=list)
    truncated: bool = False

    @property
    def docs_in_kb(self) -> int:
        return len(self.docs)

    @property
    def docs_contributing(self) -> int:
        return sum(1 for d in self.docs if d.status == "contributed")


class KbProfileClient(Protocol):
    def judge_kb_document_relevance(self, name: str, excerpt: str, user_id: str | None = None) -> dict: ...

    def extract_kb_document_profile(self, name: str, window_text: str, user_id: str | None = None) -> dict: ...


class ProfileStore(Protocol):
    def get(self, user_id: str) -> KbProfile | None: ...

    def put(self, user_id: str, profile: KbProfile) -> None: ...


class InMemoryProfileStore:
    def __init__(self) -> None:
        self._profiles: dict[str, str] = {}

    def get(self, user_id: str) -> KbProfile | None:
        raw = self._profiles.get(user_id)
        return KbProfile.model_validate_json(raw) if raw else None

    def put(self, user_id: str, profile: KbProfile) -> None:
        self._profiles[user_id] = profile.model_dump_json()


def _key(text: str) -> str:
    return " ".join(re.findall(r"\w+", text.casefold()))


def windows_of(text: str, size: int = WINDOW_CHARS, overlap: int = WINDOW_OVERLAP) -> list[str]:
    """The text in overlapping windows, so a line shorter than the overlap is whole in at least one of them."""
    if len(text) <= size:
        return [text]
    windows, start = [], 0
    while start < len(text):
        windows.append(text[start:start + size])
        if start + size >= len(text):
            break
        start += size - overlap
    return windows


def profile_version(documents: dict[str, str], model: str) -> str:
    """Changes with any document's text, the set of documents, the building model or the schema; nothing else."""
    parts = [SCHEMA_VERSION, model, sorted((name, hashlib.sha256(text.encode()).hexdigest()) for name, text in documents.items())]
    return hashlib.sha256(json.dumps(parts).encode()).hexdigest()[:24]


def _empty() -> dict:
    return {"categories": [], "type_definitions": [], "rules": [], "glossary": []}


def _union(into: dict, extracted: dict) -> None:
    """Adds one window's answer to a document's, first spelling wins, duplicates dropped."""
    seen = {
        "categories": {_key(c.get("name", "")) for c in into["categories"]},
        "rules": {_key(r) for r in into["rules"]},
        "glossary": {_key(g.get("term", "")) for g in into["glossary"]},
        "type_definitions": {(d.get("item_type"), _key(d.get("text", ""))) for d in into["type_definitions"]},
    }
    for c in extracted.get("categories") or []:
        if isinstance(c, dict) and str(c.get("name", "")).strip() and _key(c["name"]) not in seen["categories"]:
            seen["categories"].add(_key(c["name"]))
            into["categories"].append({"name": " ".join(c["name"].split()), "pass_condition": " ".join(str(c.get("pass_condition") or "").split()) or None})
    for r in extracted.get("rules") or []:
        if isinstance(r, str) and r.strip() and _key(r) not in seen["rules"]:
            seen["rules"].add(_key(r))
            into["rules"].append(" ".join(r.split()).rstrip("."))
    for g in extracted.get("glossary") or []:
        if isinstance(g, dict) and str(g.get("term", "")).strip() and _key(g["term"]) not in seen["glossary"]:
            seen["glossary"].add(_key(g["term"]))
            into["glossary"].append({"term": " ".join(g["term"].split()), "definition": " ".join(str(g.get("definition", "")).split())})
    for d in extracted.get("type_definitions") or []:
        kind = str(d.get("item_type", "")).casefold() if isinstance(d, dict) else ""
        text = " ".join(str(d.get("text", "")).split()) if isinstance(d, dict) else ""
        if kind in ("epic", "feature", "requirement") and text and (kind, _key(text)) not in seen["type_definitions"]:
            seen["type_definitions"].add((kind, _key(text)))
            into["type_definitions"].append({"item_type": kind, "text": text})


def build_profile(documents: dict[str, str], client: KbProfileClient, *, model: str, user_id: str | None = None) -> KbProfile:
    """Maps every document, then merges. Never raises for a document: each ends with a recorded status."""
    version = profile_version(documents, model)
    extracted: dict[str, dict] = {}
    statuses: list[DocumentStatus] = []
    for name in sorted(documents):
        text = documents[name]
        try:
            verdict = client.judge_kb_document_relevance(name, text[:RELEVANCE_EXCERPT_CHARS], user_id=user_id)
            relevant = bool(verdict.get("relevant", True)) if isinstance(verdict, dict) else True
            reason = str(verdict.get("reason") or "")[:300] if isinstance(verdict, dict) else ""
        except Exception as exc:  # noqa: BLE001 -- relevant unless clearly not: a failed judgement never drops a document
            logger.warning("KB relevance judgement failed for %s: %s", name, exc)
            relevant, reason = True, ""
        if not relevant:
            statuses.append(DocumentStatus(file=name, status="not_relevant", reason=reason or "judged not relevant"))
            continue
        combined, errors, windows = _empty(), [], windows_of(text)
        for window in windows:
            try:
                _union(combined, client.extract_kb_document_profile(name, window, user_id=user_id))
            except Exception as exc:  # noqa: BLE001
                errors.append(redact_identity(" ".join(str(exc).split()))[:200])
        counts = {k: len(v) for k, v in combined.items()}
        if errors and len(errors) == len(windows):
            statuses.append(DocumentStatus(file=name, status="failed", reason=errors[0]))
        elif sum(counts.values()) == 0:
            statuses.append(DocumentStatus(file=name, status="extracted_nothing", reason="no categories, definitions, rules or terms found"))
        else:
            extracted[name] = combined
            statuses.append(
                DocumentStatus(
                    file=name, status="contributed",
                    reason=f"{len(errors)} of {len(windows)} windows failed" if errors else None,
                    categories=counts["categories"], rules=counts["rules"],
                    type_definitions=counts["type_definitions"], glossary=counts["glossary"],
                )
            )
    return merge_document_profiles(extracted, model, version, statuses)


def merge_document_profiles(extracted: dict[str, dict], model: str, version: str, statuses: list[DocumentStatus] | None = None) -> KbProfile:
    """The deterministic reduce step; a pure function of the per-document results."""
    names = sorted(extracted)
    rank = {name: i for i, name in enumerate(names)}

    def ranked(entries: dict[str, dict], cap: int) -> tuple[list[dict], bool]:
        ordered = sorted(entries.values(), key=lambda e: (-len(e["sources"]), rank[e["sources"][0]], e["index"]))
        return ordered[:cap], len(ordered) > cap

    categories: dict[str, dict] = {}
    category_variants: dict[str, dict[str, Variant]] = {}
    rules: dict[str, dict] = {}
    glossary: dict[str, dict] = {}
    definitions: dict[str, dict[str, Variant]] = {}
    for name in names:
        for index, c in enumerate(extracted[name]["categories"]):
            key = _key(c["name"])
            entry = categories.setdefault(key, {"name": c["name"], "sources": [], "index": index})
            entry["sources"].append(name)
            if c.get("pass_condition"):
                variant = category_variants.setdefault(key, {}).setdefault(_key(c["pass_condition"]), Variant(text=c["pass_condition"], sources=[]))
                variant.sources.append(name)
        for index, rule in enumerate(extracted[name]["rules"]):
            key = _key(rule)
            rules.setdefault(key, {"text": rule, "sources": [], "index": index})["sources"].append(name)
        for index, g in enumerate(extracted[name]["glossary"]):
            key = _key(g["term"])
            glossary.setdefault(key, {"term": g["term"], "definition": g["definition"], "sources": [], "index": index})["sources"].append(name)
        for d in extracted[name]["type_definitions"]:
            variant = definitions.setdefault(d["item_type"], {}).setdefault(_key(d["text"]), Variant(text=d["text"], sources=[]))
            variant.sources.append(name)

    conflicts: list[Conflict] = []
    category_list, cut_categories = ranked(categories, MAX_CATEGORIES)
    out_categories = []
    for entry in category_list:
        key = _key(entry["name"])
        variants = sorted(category_variants.get(key, {}).values(), key=lambda v: (-len(v.sources), v.sources[0]))
        out_categories.append(Category(name=entry["name"], pass_condition=variants[0].text if variants else None, sources=entry["sources"]))
        if len(variants) > 1:
            conflicts.append(Conflict(kind="category", key=key, variants=sorted(variants, key=lambda v: v.sources[0])))
    out_definitions = []
    for kind in ("epic", "feature", "requirement"):
        variants = sorted(definitions.get(kind, {}).values(), key=lambda v: (-len(v.sources), v.sources[0]))
        if variants:
            out_definitions.append(TypeDefinition(item_type=kind, text=variants[0].text, sources=variants[0].sources))  # type: ignore[arg-type]
        if len(variants) > 1:
            conflicts.append(Conflict(kind="type_definition", key=kind, variants=sorted(variants, key=lambda v: v.sources[0])))
    rule_list, cut_rules = ranked(rules, MAX_RULES)
    glossary_list, cut_glossary = ranked(glossary, MAX_GLOSSARY)
    return KbProfile(
        version=version, built_with=model, docs=sorted(statuses or [], key=lambda d: d.file),
        categories=out_categories, type_definitions=out_definitions,
        rules=[Rule(text=r["text"], sources=r["sources"]) for r in rule_list],
        glossary=[GlossaryTerm(term=g["term"], definition=g["definition"], sources=g["sources"]) for g in glossary_list],
        conflicts=sorted(conflicts, key=lambda c: (c.kind, c.key)),
        truncated=cut_categories or cut_rules or cut_glossary,
    )


class KbDocuments(Protocol):
    def list_documents(self, user_id: str) -> list[str]: ...

    def get_document(self, user_id: str, source_file: str) -> tuple[str | None, bool]: ...


def ensure_profile(user_id: str, kb: KbDocuments, store: ProfileStore, client: KbProfileClient, *, model: str) -> KbProfile | None:
    """The user's profile: the stored one while nothing changed, otherwise a rebuilt (and stored) one; None with no KB."""
    texts: dict[str, str] = {}
    for name in kb.list_documents(user_id):
        text, _truncated = kb.get_document(user_id, name)
        if text:
            texts[name] = text
    if not texts:
        return None
    existing = store.get(user_id)
    if existing is not None and existing.version == profile_version(texts, model):
        return existing
    profile = build_profile(texts, client, model=model, user_id=user_id)
    store.put(user_id, profile)
    return profile


class ChromaProfileStore:
    """The profile stored beside the user's KB chunks (KbVectorStore): one JSON document per user."""

    def __init__(self, kb_store) -> None:
        self._kb_store = kb_store

    def get(self, user_id: str) -> KbProfile | None:
        raw = self._kb_store.get_profile_json(user_id)
        if not raw:
            return None
        try:
            return KbProfile.model_validate_json(raw)
        except ValueError:
            logger.warning("A stored KB profile could not be read; it will be rebuilt")
            return None

    def put(self, user_id: str, profile: KbProfile) -> None:
        self._kb_store.put_profile_json(user_id, profile.model_dump_json(), profile.version)


SCORING_CONTEXT_MAX_CHARS = 7_500


def scoring_inputs(profile: KbProfile | None) -> tuple[list[str] | None, dict[str, str] | None, str | None]:
    """What requirement scoring takes from the profile: ONE fixed category list (the same for every batch of the job), the
    pass condition of each category, and a short constant context with those conditions and the mandatory writing rules.
    Its size does not depend on how large the knowledge base is, so scoring requests stay small. (None, None, None) when
    there is no profile or it has no categories: scoring then behaves exactly as it did before profiles."""
    if profile is None or not profile.categories:
        return None, None, None
    names = [c.name for c in profile.categories]
    definitions = {c.name: c.pass_condition for c in profile.categories if c.pass_condition}
    lines = ["The organization's own standard for judging a requirement (from its knowledge base):"]
    lines += [f"- {c.name}: {c.pass_condition}" if c.pass_condition else f"- {c.name}" for c in profile.categories]
    if profile.rules:
        lines.append("Mandatory writing rules:")
        lines += [f"- {r.text}" for r in profile.rules]
    context = "\n".join(lines)
    return names, definitions, context[:SCORING_CONTEXT_MAX_CHARS]
