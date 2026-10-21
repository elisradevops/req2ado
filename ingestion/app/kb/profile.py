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
import threading
import time
from datetime import datetime, timezone
from typing import Literal, Protocol

from pydantic import BaseModel, Field

from app.prompts import load_prompt
from app.request_identity import redact_identity

logger = logging.getLogger(__name__)

SCHEMA_VERSION = "kb-profile-4"
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
# Each window of a document is read this many times (the extraction is a temperature-1 sample). Every wording is a candidate; a quality
# is kept only when most of the runs produced it in the same document, and the wording most runs gave names it.
EXTRACTION_RUNS = 3
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
    # The document categories this entry stands for, as the documents wrote them (it is one of them). Lets a rebuild keep
    # the groups it made; absent (empty) on profiles stored before it existed.
    merged_from: list[str] = Field(default_factory=list)
    # Per source document, the extraction runs (0-based) that produced this category (pooled over the wordings merged into it). Used to keep
    # only what most runs agree on; empty on profiles stored before it existed (then nothing is dropped for lack of support).
    seen_in: dict[str, list[int]] = Field(default_factory=dict)


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
    # True when the build could not be done properly (a document failed in whole or part, a relevance judgement failed, the merge pass got
    # no answer). Never persisted: such a profile is used for the job at hand but not stored as current, so the next job rebuilds.
    degraded: bool = Field(default=False, exclude=True)

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


class DocumentCache(Protocol):
    """One user's stored extractions, one per KB document: the document's relevance verdict and what was extracted from it, valid for
    the exact text, model and extraction (prompts, windows) it was made with."""

    def get(self, file: str, fingerprint: str) -> dict | None: ...

    def put(self, file: str, fingerprint: str, result: dict) -> None: ...

    def files(self) -> list[str]: ...

    def keep_only(self, files: set[str]) -> None: ...


def extraction_version() -> str:
    """Identifies how a document is read: change a prompt, the window size or the schema and stored extractions no longer apply."""
    parts = [SCHEMA_VERSION, load_prompt("kb_document_relevance"), load_prompt("extract_kb_document_profile"), WINDOW_CHARS, WINDOW_OVERLAP, RELEVANCE_EXCERPT_CHARS, EXTRACTION_RUNS]
    return hashlib.sha256(json.dumps(parts).encode()).hexdigest()[:24]


def _fingerprint(text: str, model: str) -> str:
    return hashlib.sha256(json.dumps([extraction_version(), model, text]).encode()).hexdigest()


class _MemoryDocumentCache:
    def __init__(self, entries: dict[str, tuple[str, dict]]) -> None:
        self._entries = entries

    def get(self, file: str, fingerprint: str) -> dict | None:
        found = self._entries.get(file)
        return found[1] if found and found[0] == fingerprint else None

    def put(self, file: str, fingerprint: str, result: dict) -> None:
        self._entries[file] = (fingerprint, result)

    def files(self) -> list[str]:
        return sorted(self._entries)

    def keep_only(self, files: set[str]) -> None:
        for gone in [f for f in self._entries if f not in files]:
            del self._entries[gone]


class InMemoryProfileStore:
    def __init__(self) -> None:
        self._profiles: dict[str, str] = {}
        self._documents: dict[str, dict[str, tuple[str, dict]]] = {}

    def document_cache(self, user_id: str) -> DocumentCache:
        return _MemoryDocumentCache(self._documents.setdefault(user_id, {}))

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


def _combine_runs(run_results: list[dict]) -> dict:
    """One document's extraction from its runs. Every wording of a category is kept as its own candidate, with the runs that produced
    it; its pass condition is the most common one and its spelling the most common (ties alphabetical), so the result does not depend
    on the order the runs are in. Rules, glossary terms and type definitions are pooled across the runs."""
    combined = _empty()
    cats: dict[str, dict] = {}
    for run, result in enumerate(run_results):
        for category in result["categories"]:
            entry = cats.setdefault(_key(category["name"]), {"spellings": {}, "conditions": {}, "runs": [], "first": len(cats)})
            entry["runs"].append(run)
            entry["spellings"][category["name"]] = entry["spellings"].get(category["name"], 0) + 1
            condition = category.get("pass_condition")
            if condition:
                entry["conditions"][condition] = entry["conditions"].get(condition, 0) + 1
        _union(combined, {**result, "categories": []})
    for entry in sorted(cats.values(), key=lambda e: (-len(e["runs"]), e["first"])):
        spelling = min(entry["spellings"], key=lambda t: (-entry["spellings"][t], t))
        conditions = entry["conditions"]
        combined["categories"].append(
            {"name": spelling, "pass_condition": min(conditions, key=lambda t: (-conditions[t], t)) if conditions else None, "runs": entry["runs"]}
        )
    return combined


def _cache_get(cache: DocumentCache, file: str, fingerprint: str) -> dict | None:
    """The cache only saves work: a store error is a miss, never a failed build (the model calls were already paid for)."""
    try:
        return cache.get(file, fingerprint)
    except Exception as exc:  # noqa: BLE001
        logger.warning("KB extraction cache read failed (extracting again): %s", redact_identity(" ".join(str(exc).split()))[:200])
        return None


def _cache_put(cache: DocumentCache, file: str, fingerprint: str, result: dict) -> None:
    try:
        cache.put(file, fingerprint, result)
    except Exception as exc:  # noqa: BLE001
        logger.warning("KB extraction cache write failed (not stored): %s", redact_identity(" ".join(str(exc).split()))[:200])


def _cache_keep_only(cache: DocumentCache, files: set[str]) -> None:
    try:
        cache.keep_only(files)
    except Exception as exc:  # noqa: BLE001
        logger.warning("KB extraction cache cleanup failed: %s", redact_identity(" ".join(str(exc).split()))[:200])


def build_profile(
    documents: dict[str, str], client: KbProfileClient, *, model: str, user_id: str | None = None, previous: KbProfile | None = None,
    cache: DocumentCache | None = None, read_cache: bool = True,
) -> KbProfile:
    """Maps every document, then merges. Never raises for a document: each ends with a recorded status. `previous` (the profile
    this one replaces) only lends its category names and groups to the merge. `cache` holds each document's earlier extraction: a
    document whose text, the model and the extraction are unchanged is not read again (`read_cache=False` re-reads everything and
    replaces what was stored), so a rebuild keeps what its unchanged documents said. Only complete results are stored."""
    started = time.monotonic()
    version = profile_version(documents, model)
    extracted: dict[str, dict] = {}
    statuses: list[DocumentStatus] = []
    cached_documents = 0
    degraded = False
    for name in sorted(documents):
        text = documents[name]
        fingerprint = _fingerprint(text, model) if cache is not None else ""
        remembered = _cache_get(cache, name, fingerprint) if cache is not None and read_cache else None
        if remembered is not None:
            cached_documents += 1
            if remembered.get("status") == "not_relevant":
                statuses.append(DocumentStatus(file=name, status="not_relevant", reason=remembered.get("reason") or "judged not relevant"))
            else:
                counts = {k: len(v) for k, v in remembered["extracted"].items()}
                extracted[name] = remembered["extracted"]
                statuses.append(
                    DocumentStatus(
                        file=name, status="contributed", categories=counts["categories"], rules=counts["rules"],
                        type_definitions=counts["type_definitions"], glossary=counts["glossary"],
                    )
                )
            continue
        verdict_ok = True
        try:
            verdict = client.judge_kb_document_relevance(name, text[:RELEVANCE_EXCERPT_CHARS], user_id=user_id)
            relevant = bool(verdict.get("relevant", True)) if isinstance(verdict, dict) else True
            reason = str(verdict.get("reason") or "")[:300] if isinstance(verdict, dict) else ""
        except Exception as exc:  # noqa: BLE001 -- relevant unless clearly not: a failed judgement never drops a document
            logger.warning("KB relevance judgement failed for %s: %s", name, exc)
            relevant, reason, verdict_ok = True, "", False
            degraded = True
        if not relevant:
            statuses.append(DocumentStatus(file=name, status="not_relevant", reason=reason or "judged not relevant"))
            if cache is not None and verdict_ok:
                _cache_put(cache, name, fingerprint, {"status": "not_relevant", "reason": reason})
            continue
        windows = windows_of(text)
        run_results, errors = [_empty() for _ in range(EXTRACTION_RUNS)], []
        for run in range(EXTRACTION_RUNS):
            for window in windows:
                try:
                    _union(run_results[run], client.extract_kb_document_profile(name, window, user_id=user_id))
                except Exception as exc:  # noqa: BLE001
                    errors.append(redact_identity(" ".join(str(exc).split()))[:200])
        combined = _combine_runs(run_results)
        calls = len(windows) * EXTRACTION_RUNS
        counts = {k: len(v) for k, v in combined.items()}
        degraded = degraded or bool(errors)
        if errors and len(errors) == calls:
            statuses.append(DocumentStatus(file=name, status="failed", reason=errors[0]))
        elif sum(counts.values()) == 0:
            statuses.append(DocumentStatus(file=name, status="extracted_nothing", reason="no categories, definitions, rules or terms found"))
        else:
            extracted[name] = combined
            statuses.append(
                DocumentStatus(
                    file=name, status="contributed",
                    reason=f"{len(errors)} of {calls} extraction calls failed" if errors else None,
                    categories=counts["categories"], rules=counts["rules"],
                    type_definitions=counts["type_definitions"], glossary=counts["glossary"],
                )
            )
            if cache is not None and verdict_ok and not errors:
                _cache_put(cache, name, fingerprint, {"status": "contributed", "extracted": combined})
    if cache is not None:
        _cache_keep_only(cache, set(documents))
    profile = merge_document_profiles(extracted, model, version, statuses)
    stats: dict = {}
    profile.categories, cut = consolidate_categories(profile.categories, client, user_id, previous, stats)
    profile.truncated = profile.truncated or cut
    # A build that could not read every document, or whose merge pass got no answer at all, is used but never stored as current.
    profile.degraded = degraded or (stats.get("runs_asked", 0) > 0 and stats.get("runs_answered", 0) == 0)
    # Counts only: category names are the company's own material.
    logger.info(
        "KB profile built: documents=%d contributing=%d cached_documents=%d categories=%d rules=%d conflicts=%d runs=%s/%s "
        "contested_pairs=%s duration=%.1fs model=%s",
        profile.docs_in_kb, profile.docs_contributing, cached_documents, len(profile.categories), len(profile.rules), len(profile.conflicts),
        stats.get("runs_answered", "-"), stats.get("runs_asked", "-"), stats.get("contested_pairs", "-"),
        time.monotonic() - started, model,
    )
    return profile


def _representative_key(member: Category, preferred: set[str]):
    """Which member of a group speaks for it: the previous profile's name first (a rebuild keeps names), then the wording more
    documents used, then the one more extraction runs gave, then a plainly written one (capitalised, shorter), then alphabetical. A rule over the documents' own
    words: nothing the model wrote is used, so sampling cannot rename a quality."""
    support = sum(len(runs) for runs in member.seen_in.values())
    return (_key(member.name) not in preferred, -len(member.sources), -support, 0 if member.name[:1].isupper() else 1, len(member.name), member.name.casefold(), member.name)


def consolidate_categories(
    categories: list[Category], client: object, user_id: str | None = None, previous: "KbProfile | None" = None,
    stats: dict | None = None,
) -> tuple[list[Category], bool]:
    """The merged categories as a canonical list: the model decides which categories judge the same quality, a rule names them.

    The model is asked CONSOLIDATION_RUNS times which input categories belong together. Two are merged when MORE THAN HALF of the
    answering runs grouped them; pairs are joined transitively. The groups of the `previous` profile (for members the documents
    still name) are applied first and ALWAYS, also when the model is absent or every run fails, so what was decided stays decided.
    Each resulting entry is named, and given its pass condition, by `_representative_key` from its members as the documents wrote
    them; it keeps the union of their sources and lists them in `merged_from`. An entry nobody grouped is its own. The outcome depends
    on what the runs said, not on their order, and names are unique because members are. A list over MAX_SCORING_CATEGORIES is cut
    (best-supported first) as a last safeguard. Returns (categories, cut). `stats`, when given, receives runs_asked, runs_answered and
    contested_pairs (pairs that some, but not all, answering runs grouped) for the build's log line."""
    def capped(entries: list[Category]) -> tuple[list[Category], bool]:
        ordered = sorted(entries, key=lambda c: (-len(c.sources), c.sources[0] if c.sources else "", c.name))
        return ordered[:MAX_SCORING_CATEGORIES], len(ordered) > MAX_SCORING_CATEGORIES

    majority = EXTRACTION_RUNS // 2 + 1

    def supported(seen_in: dict[str, list[int]]) -> bool:
        # No run information (a profile stored before it existed): nothing is dropped for lack of support.
        return not seen_in or max(len(runs) for runs in seen_in.values()) >= majority

    def unmerged() -> tuple[list[Category], bool]:
        kept = [c for c in categories if supported(c.seen_in)] or list(categories)
        return [c.model_copy(update={"merged_from": [c.name]}) for c in kept[:MAX_SCORING_CATEGORIES]], len(kept) > MAX_SCORING_CATEGORIES

    by_key = {_key(c.name): c for c in categories}
    keys = list(by_key)
    position = {k: i for i, k in enumerate(keys)}
    previous_groups = [
        still_named
        for earlier in (previous.categories if previous else [])
        if len(still_named := [k for k in dict.fromkeys(_key(m) for m in earlier.merged_from) if k in by_key]) > 1
    ]
    consolidate = getattr(client, "consolidate_kb_categories", None)
    if len(categories) < 2 or (consolidate is None and not previous_groups):
        return unmerged()
    payload = [{"name": c.name, "pass_condition": c.pass_condition or ""} for c in categories]
    previous_names = [c.name for c in previous.categories] if previous else []
    extra = {"preferred_names": previous_names} if previous_names else {}

    runs: list[list[list[str]]] = []  # per answering run: groups of member keys, every key exactly once
    for _ in range(CONSOLIDATION_RUNS if consolidate is not None else 0):
        try:
            groups = consolidate(payload, MAX_SCORING_CATEGORIES, user_id=user_id, **extra)
        except Exception as exc:  # noqa: BLE001 -- the merge only shortens the list; the profile is built either way
            logger.warning("KB category consolidation run failed: %s", redact_identity(" ".join(str(exc).split()))[:200])
            continue
        placed: set[str] = set()
        parsed: list[list[str]] = []
        for group in groups or []:
            members = [k for k in dict.fromkeys(_key(m) for m in group.get("merged_from", [])) if k in by_key and k not in placed]
            if members:
                placed.update(members)
                parsed.append(members)
        parsed += [[k] for k in keys if k not in placed]
        runs.append(parsed)
    if stats is not None and consolidate is not None:
        stats.update(runs_asked=CONSOLIDATION_RUNS, runs_answered=len(runs))
    if not runs and not previous_groups:
        logger.warning("KB category consolidation gave no usable answer; keeping the capped deterministic list")
        return unmerged()

    parent = {k: k for k in keys}

    def find(k: str) -> str:
        while parent[k] != k:
            parent[k] = parent[parent[k]]
            k = parent[k]
        return k

    def union(a: str, b: str) -> None:
        root_a, root_b = find(a), find(b)
        if root_a != root_b:  # the earlier input is the root, so the outcome never depends on call order
            low, high = sorted((root_a, root_b), key=position.__getitem__)
            parent[high] = low

    for group in previous_groups:  # what the previous profile decided stays decided
        for other in group[1:]:
            union(group[0], other)

    together: dict[tuple[str, str], int] = {}
    for run in runs:
        for members in run:
            for i, a in enumerate(members):
                for b in members[i + 1:]:
                    pair = (a, b) if position[a] < position[b] else (b, a)
                    together[pair] = together.get(pair, 0) + 1
    if stats is not None:
        stats["contested_pairs"] = sum(1 for count in together.values() if count < len(runs))
    for (a, b), count in sorted(together.items()):
        if count * 2 > len(runs):
            union(a, b)

    components: dict[str, list[str]] = {}
    for k in keys:
        components.setdefault(find(k), []).append(k)
    preferred = {_key(n) for n in previous_names}
    entries: list[Category] = []
    for member_keys in components.values():
        members = [by_key[k] for k in member_keys]
        ranked = sorted(members, key=lambda m: _representative_key(m, preferred))
        condition = next((m.pass_condition for m in ranked if m.pass_condition), None)
        pooled: dict[str, set[int]] = {}
        for m in members:
            for doc, runs in m.seen_in.items():
                pooled.setdefault(doc, set()).update(runs)  # a run that produced two wordings of one quality counts once
        entries.append(
            Category(
                name=ranked[0].name, pass_condition=condition,
                sources=sorted({src for m in members for src in m.sources}), merged_from=[m.name for m in members],
                seen_in={doc: sorted(runs) for doc, runs in pooled.items()},
            )
        )
    # A quality most runs did not produce (in one document) is a one-off; if nothing would survive, keep the candidates.
    entries = [e for e in entries if supported(e.seen_in)] or entries
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
            entry = categories.setdefault(key, {"name": c["name"], "sources": [], "index": index, "seen_in": {}})
            entry["sources"].append(name)
            entry["seen_in"][name] = sorted(set(entry["seen_in"].get(name, [])) | set(c.get("runs") or [0]))
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
        out_categories.append(Category(name=entry["name"], pass_condition=variants[0].text if variants else None, sources=entry["sources"], seen_in=entry["seen_in"]))
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


_build_locks: dict[str, threading.Lock] = {}
_build_locks_guard = threading.Lock()


def _lock_for(user_id: str) -> threading.Lock:
    with _build_locks_guard:
        return _build_locks.setdefault(user_id, threading.Lock())


def ensure_profile(
    user_id: str, kb: KbDocuments, store: ProfileStore, client: KbProfileClient, *, model: str, refresh: bool = False,
) -> KbProfile | None:
    """The user's profile: the stored one while nothing changed, otherwise a rebuilt (and stored) one; None with no KB.

    One build at a time per user: two jobs starting together used to build two different profiles (the model is sampled), each
    scoring with its own, the last write winning. The second request now waits and reads the stored one.

    A rebuild reuses the stored extraction of every unchanged document (see DocumentCache); `refresh=True` re-reads all of them."""
    with _lock_for(user_id):
        texts: dict[str, str] = {}
        for name in kb.list_documents(user_id):
            text, _truncated = kb.get_document(user_id, name)
            if text:
                texts[name] = text
        if not texts:
            return None
        existing = store.get(user_id)
        if existing is not None and not refresh and existing.version == profile_version(texts, model):
            return existing
        make_cache = getattr(store, "document_cache", None)
        profile = build_profile(
            texts, client, model=model, user_id=user_id,
            # A refresh starts from the documents: earlier merges (which only ever grow) are not carried over.
            previous=None if refresh else existing,
            cache=make_cache(user_id) if make_cache else None, read_cache=not refresh,
        )
        profile.built_at = datetime.now(timezone.utc).isoformat()
        if profile.degraded:
            # Used for the job at hand, never stored as current: the next job rebuilds (the documents that did succeed come from the
            # cache), instead of every later job scoring without the knowledge base's standard until a document changes.
            logger.warning("KB profile build was incomplete; it is used for this request and not stored")
            return profile
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

    def document_cache(self, user_id: str) -> DocumentCache:
        return _ChromaDocumentCache(self._kb_store, user_id)


_DOC_PREFIX = "doc:"


def _doc_part_id(file: str) -> str:
    return _DOC_PREFIX + hashlib.sha256(file.encode()).hexdigest()[:24]


class _ChromaDocumentCache:
    """Per-document extractions kept in the user's profile collection, beside the profile (so a purge drops them too)."""

    def __init__(self, kb_store, user_id: str) -> None:
        self._kb_store, self._user_id = kb_store, user_id

    def _read(self, part_id: str) -> dict | None:
        raw = self._kb_store.get_profile_part(self._user_id, part_id)
        try:
            return json.loads(raw) if raw else None
        except ValueError:
            return None

    def get(self, file: str, fingerprint: str) -> dict | None:
        entry = self._read(_doc_part_id(file))
        return entry["result"] if entry and entry.get("fingerprint") == fingerprint and entry.get("file") == file else None

    def put(self, file: str, fingerprint: str, result: dict) -> None:
        self._kb_store.put_profile_part(self._user_id, _doc_part_id(file), json.dumps({"file": file, "fingerprint": fingerprint, "result": result}))

    def files(self) -> list[str]:
        return sorted(e["file"] for e in (self._read(i) for i in self._kb_store.list_profile_part_ids(self._user_id, _DOC_PREFIX)) if e)

    def keep_only(self, files: set[str]) -> None:
        keep = {_doc_part_id(f) for f in files}
        self._kb_store.delete_profile_parts(self._user_id, [i for i in self._kb_store.list_profile_part_ids(self._user_id, _DOC_PREFIX) if i not in keep])


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
