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
import time
from datetime import datetime, timezone
from typing import Literal, Protocol

from pydantic import BaseModel, Field

from app.request_identity import redact_identity

logger = logging.getLogger(__name__)

SCHEMA_VERSION = "kb-profile-3"
WINDOW_CHARS = 10_000
WINDOW_OVERLAP = 500
RELEVANCE_EXCERPT_CHARS = 1_500
MAX_CATEGORIES = 40
# The model decides which categories exist (it merges the ones that judge the same quality); this is only a safety ceiling for a
# list that would make scoring answers too large. Scoring batches already shrink as the list grows (scoring_chunk_node_limit).
MAX_SCORING_CATEGORIES = 16
# The merge is asked this many times and only what most runs agree on is kept: Claude and GPT-5.x are forced to temperature 1 by the
# proxy, so one answer is a sample, while the agreement of three is stable.
CONSOLIDATION_RUNS = 3
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
    # When it was built (UTC, ISO). Informational only: never part of `version`, absent on profiles stored before it existed.
    built_at: str | None = None

    @property
    def docs_in_kb(self) -> int:
        return len(self.docs)

    @property
    def docs_contributing(self) -> int:
        return sum(1 for d in self.docs if d.status == "contributed")


class KbProfileClient(Protocol):
    def judge_kb_document_relevance(self, name: str, excerpt: str, user_id: str | None = None) -> dict: ...

    def extract_kb_document_profile(self, name: str, window_text: str, user_id: str | None = None) -> dict: ...

    # Optional: consolidate_kb_categories(categories, max_categories, user_id=None, preferred_names=None)
    #   -> [{name, pass_condition, merged_from}].
    # A client without it, or one that fails, leaves the deterministic list (capped).


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


def build_profile(
    documents: dict[str, str], client: KbProfileClient, *, model: str, user_id: str | None = None, previous: KbProfile | None = None,
) -> KbProfile:
    """Maps every document, then merges. Never raises for a document: each ends with a recorded status. `previous` (the profile
    this one replaces) only lends its category names to the merge, so a rebuild keeps names unless the content changed."""
    started = time.monotonic()
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
    profile = merge_document_profiles(extracted, model, version, statuses)
    stats: dict = {}
    profile.categories, cut = consolidate_categories(
        profile.categories, client, user_id, [c.name for c in previous.categories] if previous else None, stats,
    )
    profile.truncated = profile.truncated or cut
    # Counts only: category names are the company's own material.
    logger.info(
        "KB profile built: documents=%d contributing=%d categories=%d rules=%d conflicts=%d runs=%s/%s contested_pairs=%s "
        "duration=%.1fs model=%s",
        profile.docs_in_kb, profile.docs_contributing, len(profile.categories), len(profile.rules), len(profile.conflicts),
        stats.get("runs_answered", "-"), stats.get("runs_asked", "-"), stats.get("contested_pairs", "-"),
        time.monotonic() - started, model,
    )
    return profile


def consolidate_categories(
    categories: list[Category], client: object, user_id: str | None = None, preferred_names: list[str] | None = None,
    stats: dict | None = None,
) -> tuple[list[Category], bool]:
    """The merged categories as a canonical list decided by the model and made stable by agreement.

    The model says which names mean the same quality. It is asked CONSOLIDATION_RUNS times; two categories are merged only when
    MORE THAN HALF of the answering runs placed them together, the merged entry takes the name most runs gave it (a previous
    profile's name wins a tie, then alphabetical order), and its pass condition is the most common one under that name. The
    outcome is a function of what the runs said, not of their order, and one odd answer cannot change it. Every entry keeps the
    union of its sources, an entry no run grouped keeps its own name, and a list over MAX_SCORING_CATEGORIES is cut
    (best-supported first) as a last safeguard. Without the model (not offered, or every run failing) the deterministic list is
    only capped. Returns (categories, cut). `stats`, when given, receives runs_asked, runs_answered and contested_pairs (pairs
    that some, but not all, answering runs grouped) for the build's log line."""
    def capped(entries: list[Category]) -> tuple[list[Category], bool]:
        ordered = sorted(entries, key=lambda c: (-len(c.sources), c.sources[0] if c.sources else "", c.name))
        return ordered[:MAX_SCORING_CATEGORIES], len(ordered) > MAX_SCORING_CATEGORIES

    consolidate = getattr(client, "consolidate_kb_categories", None)
    if len(categories) < 2 or consolidate is None:
        return categories[:MAX_SCORING_CATEGORIES], len(categories) > MAX_SCORING_CATEGORIES
    by_key = {_key(c.name): c for c in categories}
    keys = list(by_key)
    payload = [{"name": c.name, "pass_condition": c.pass_condition or ""} for c in categories]
    extra = {"preferred_names": list(preferred_names)} if preferred_names else {}

    runs: list[list[tuple[str, str | None, list[str]]]] = []  # per run: (name, condition, member keys), every key exactly once
    for _ in range(CONSOLIDATION_RUNS):
        try:
            groups = consolidate(payload, MAX_SCORING_CATEGORIES, user_id=user_id, **extra)
        except Exception as exc:  # noqa: BLE001 -- the merge only shortens the list; the profile is built either way
            logger.warning("KB category consolidation run failed: %s", redact_identity(" ".join(str(exc).split()))[:200])
            continue
        placed: set[str] = set()
        parsed: list[tuple[str, str | None, list[str]]] = []
        for group in groups or []:
            members = [k for k in dict.fromkeys(_key(m) for m in group.get("merged_from", [])) if k in by_key and k not in placed]
            if not members:
                continue
            placed.update(members)
            name = " ".join(str(group.get("name", "")).split()) or by_key[members[0]].name
            parsed.append((name, (group.get("pass_condition") or None), members))
        parsed += [(by_key[k].name, by_key[k].pass_condition, [k]) for k in keys if k not in placed]
        runs.append(parsed)
    if stats is not None:
        stats.update(runs_asked=CONSOLIDATION_RUNS, runs_answered=len(runs))
    if not runs:
        logger.warning("KB category consolidation gave no usable answer; keeping the capped deterministic list")
        return categories[:MAX_SCORING_CATEGORIES], len(categories) > MAX_SCORING_CATEGORIES

    # Merge a pair only when more than half of the runs put it together; connected pairs form one entry.
    parent = {k: k for k in keys}

    def find(k: str) -> str:
        while parent[k] != k:
            parent[k] = parent[parent[k]]
            k = parent[k]
        return k

    together: dict[tuple[str, str], int] = {}
    for run in runs:
        for _name, _condition, members in run:
            for i, a in enumerate(members):
                for b in members[i + 1:]:
                    pair = (a, b) if keys.index(a) < keys.index(b) else (b, a)
                    together[pair] = together.get(pair, 0) + 1
    if stats is not None:
        stats["contested_pairs"] = sum(1 for count in together.values() if count < len(runs))
    for (a, b), count in together.items():
        if count * 2 > len(runs):
            parent[find(b)] = find(a)
    components: dict[str, list[str]] = {}
    for k in keys:
        components.setdefault(find(k), []).append(k)

    preferred = {_key(n) for n in preferred_names or []}
    entries: list[Category] = []
    for members in components.values():
        member_set = set(members)
        names: dict[str, int] = {}
        conditions: dict[str, dict[str, int]] = {}
        for run in runs:
            best = max(run, key=lambda g: (len(member_set & set(g[2])), -run.index(g)))  # the run's group that overlaps this entry most
            names[best[0]] = names.get(best[0], 0) + 1
            if best[1]:
                conditions.setdefault(best[0], {})
                conditions[best[0]][best[1]] = conditions[best[0]].get(best[1], 0) + 1
        name = min(names, key=lambda n: (-names[n], _key(n) not in preferred, n.casefold(), n))
        said = conditions.get(name, {})
        condition = min(said, key=lambda c: (-said[c], c)) if said else next((by_key[k].pass_condition for k in members if by_key[k].pass_condition), None)
        entries.append(Category(name=name, pass_condition=condition, sources=sorted({src for k in members for src in by_key[k].sources})))
    return capped(entries)


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
    profile = build_profile(texts, client, model=model, user_id=user_id, previous=existing)
    profile.built_at = datetime.now(timezone.utc).isoformat()
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


AUTHORING_STANDARD_MAX_CHARS = 6_000


def render_authoring_standard(profile: KbProfile | None) -> str | None:
    """The profile as the text that leads every prompt that writes a work item's title or description: what the
    organization's own knowledge base says an Epic, Feature and Requirement are, the rules that make a way of writing
    mandatory, its defined terms, and the quality bar a requirement is judged against. None when the profile has none of
    these, so prompts are then byte-identical to what they were before profiles."""
    if profile is None:
        return None
    sections: list[str] = []
    if profile.type_definitions:
        sections.append("Definitions:\n" + "\n".join(f"- {d.item_type.capitalize()}: {d.text}" for d in profile.type_definitions))
    if profile.rules:
        sections.append("Mandatory rules:\n" + "\n".join(f"- {r.text}" for r in profile.rules))
    if profile.categories:
        sections.append(
            "A good requirement is:\n"
            + "\n".join(f"- {c.name}: {c.pass_condition}" if c.pass_condition else f"- {c.name}" for c in profile.categories)
        )
    if profile.glossary:
        sections.append("Terms:\n" + "\n".join(f"- {g.term}: {g.definition}" for g in profile.glossary))
    if not sections:
        return None
    return "\n\n".join(sections)[:AUTHORING_STANDARD_MAX_CHARS]
