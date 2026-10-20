"""The KB profile: what the user's whole knowledge base says about how work items are defined, written and judged.

Built from EVERY document (never from the top few chunks of one), each judged for relevance to creating the work-item
hierarchy, merged with provenance, and rebuilt only when the documents or the building model change. These tests use a
fake model whose answers depend only on the text it is shown, so nothing here needs a real LLM."""
from __future__ import annotations

import json
import random

import pytest

from app.kb.profile import (
    MAX_SCORING_CATEGORIES,
    SCHEMA_VERSION,
    InMemoryProfileStore,
    KbProfile,
    build_profile,
    ensure_profile,
    merge_document_profiles,
    profile_version,
    windows_of,
)


class FakeProfileClient:
    """Reads simple marker lines from the text it is given:
    `CAT: <name> | <pass condition>`, `RULE: <text>`, `DEF <Epic|Feature|Requirement>: <text>`, `TERM: <term> = <definition>`,
    `IRRELEVANT` (the whole document is about something else), `BOOM` (the call fails)."""

    def __init__(self, flaky_relevance: bool = False) -> None:
        self.relevance_calls: list[str] = []
        self.extract_calls: list[str] = []
        self.flaky_relevance = flaky_relevance

    def judge_kb_document_relevance(self, name: str, excerpt: str, user_id: str | None = None) -> dict:
        self.relevance_calls.append(name)
        if self.flaky_relevance:
            raise RuntimeError("model down")
        if "IRRELEVANT" in excerpt:
            return {"relevant": False, "reason": "about the weather"}
        return {"relevant": True, "reason": "writes requirements"}

    def extract_kb_document_profile(self, name: str, window_text: str, user_id: str | None = None) -> dict:
        self.extract_calls.append(name)
        if "BOOM" in window_text:
            raise RuntimeError("400 status code (no body)")
        categories, rules, definitions, glossary = [], [], [], []
        for line in window_text.splitlines():
            line = line.strip()
            if line.startswith("CAT:"):
                cat, _, cond = line[4:].partition("|")
                categories.append({"name": cat.strip(), "pass_condition": cond.strip()})
            elif line.startswith("RULE:"):
                rules.append(line[5:].strip())
            elif line.startswith("DEF "):
                kind, _, text = line[4:].partition(":")
                definitions.append({"item_type": kind.strip().lower(), "text": text.strip()})
            elif line.startswith("TERM:"):
                term, _, text = line[5:].partition("=")
                glossary.append({"term": term.strip(), "definition": text.strip()})
        return {"categories": categories, "type_definitions": definitions, "rules": rules, "glossary": glossary}


DOCS = {
    "HowTo.pptx": "CAT: Clear and unambiguous | One reading only\nCAT: Testable | Can be verified\nRULE: One requirement per statement\nDEF Requirement: A verifiable statement of need",
    "Principles.pptx": "CAT: clear  and Unambiguous | One reading only\nCAT: Implementable | Can be built\nRULE: one requirement per statement.\nTERM: SRS = software requirements specification",
    "ALM.pptx": "CAT: Testable | Verified by test, inspection or analysis\nDEF Epic: A large body of work",
}


def test_every_document_contributes_and_the_merge_keeps_provenance() -> None:
    profile = build_profile(DOCS, FakeProfileClient(), model="m1")

    assert profile.docs_in_kb == 3 and profile.docs_contributing == 3
    by_name = {c.name.casefold(): c for c in profile.categories}
    assert set(by_name) == {"clear and unambiguous", "testable", "implementable"}
    assert by_name["clear and unambiguous"].sources == ["HowTo.pptx", "Principles.pptx"]  # spelling variants merge
    assert by_name["testable"].sources == ["ALM.pptx", "HowTo.pptx"]
    assert [r.text for r in profile.rules] == ["One requirement per statement"]
    assert profile.rules[0].sources == ["HowTo.pptx", "Principles.pptx"]
    assert {d.item_type for d in profile.type_definitions} == {"requirement", "epic"}
    assert [g.term for g in profile.glossary] == ["SRS"]


def test_two_documents_that_define_the_same_category_differently_are_a_conflict_not_a_silent_choice() -> None:
    profile = build_profile(DOCS, FakeProfileClient(), model="m1")
    conflict = next(c for c in profile.conflicts if c.key == "testable")
    assert conflict.kind == "category"
    assert {frozenset(v.sources) for v in conflict.variants} == {frozenset({"HowTo.pptx"}), frozenset({"ALM.pptx"})}
    assert not any(c.key == "clear and unambiguous" for c in profile.conflicts)  # identical wording is not a conflict


def test_the_profile_does_not_depend_on_the_order_the_documents_arrive_in() -> None:
    reference = build_profile(DOCS, FakeProfileClient(), model="m1").model_dump_json()
    for seed in range(6):
        names = list(DOCS)
        random.Random(seed).shuffle(names)
        assert build_profile({n: DOCS[n] for n in names}, FakeProfileClient(), model="m1").model_dump_json() == reference


def test_an_unrelated_document_is_recorded_with_its_reason_and_contributes_nothing() -> None:
    docs = {**DOCS, "weather.pdf": "IRRELEVANT\nCAT: Sunny | not a quality category"}
    client = FakeProfileClient()
    profile = build_profile(docs, client, model="m1")

    status = next(d for d in profile.docs if d.file == "weather.pdf")
    assert (status.status, status.reason) == ("not_relevant", "about the weather")
    assert "sunny" not in {c.name.casefold() for c in profile.categories}
    assert "weather.pdf" not in client.extract_calls  # never mined
    assert profile.docs_in_kb == 4 and profile.docs_contributing == 3


def test_a_failing_relevance_call_keeps_the_document_a_failing_extraction_never_fails_the_build() -> None:
    flaky = build_profile(DOCS, FakeProfileClient(flaky_relevance=True), model="m1")
    assert flaky.docs_contributing == 3  # "relevant unless clearly not": a failed judgement does not drop a document

    docs = {**DOCS, "broken.pptx": "BOOM"}
    profile = build_profile(docs, FakeProfileClient(), model="m1")
    broken = next(d for d in profile.docs if d.file == "broken.pptx")
    assert broken.status == "failed" and "400" in (broken.reason or "")
    assert profile.docs_contributing == 3


def test_a_document_with_nothing_extractable_is_explained_not_silently_ignored() -> None:
    profile = build_profile({**DOCS, "notes.docx": "just some prose"}, FakeProfileClient(), model="m1")
    status = next(d for d in profile.docs if d.file == "notes.docx")
    assert status.status == "extracted_nothing"


def test_the_completeness_invariant_accounts_for_every_document() -> None:
    docs = {**DOCS, "weather.pdf": "IRRELEVANT", "broken.pptx": "BOOM", "notes.docx": "prose"}
    profile = build_profile(docs, FakeProfileClient(), model="m1")
    accounted = sum(1 for d in profile.docs if d.status in ("contributed", "not_relevant", "extracted_nothing", "failed"))
    assert accounted == profile.docs_in_kb == len(docs)


def test_a_long_document_is_read_in_windows_so_nothing_past_the_first_page_is_lost() -> None:
    filler = "\n".join(f"filler line {i}" for i in range(2500))
    text = f"CAT: Early | first\n{filler}\nCAT: Late | last"
    assert len(windows_of(text)) > 1
    profile = build_profile({"long.pptx": text}, FakeProfileClient(), model="m1")
    assert {c.name for c in profile.categories} == {"Early", "Late"}


def test_a_category_cut_by_a_window_boundary_is_not_lost() -> None:
    windows = windows_of("a" * 12_000)
    assert windows[0][-500:] == windows[1][:500] or len(windows[0]) >= 9_000  # windows overlap


def test_the_profile_is_capped_with_a_stable_ranking_and_says_so() -> None:
    many = "\n".join(f"CAT: Category {i:03d} | cond" for i in range(80))
    shared = "CAT: Category 079 | cond"
    profile = build_profile({"a.pptx": many, "b.pptx": shared}, FakeProfileClient(), model="m1")
    assert profile.truncated is True and len(profile.categories) == MAX_SCORING_CATEGORIES
    assert "Category 079" in {c.name for c in profile.categories}  # supported by two documents: ranks first
    # The merge itself keeps at most 40 before the short list is made.
    merged = merge_document_profiles({"a.pptx": {"categories": [{"name": f"Category {i:03d}", "pass_condition": None} for i in range(80)], "rules": [], "glossary": [], "type_definitions": []}}, "m1", "v")
    assert merged.truncated is True and len(merged.categories) == 40


def test_the_version_changes_with_the_documents_and_the_model_only() -> None:
    base = profile_version(DOCS, "m1")
    assert base == profile_version(dict(reversed(list(DOCS.items()))), "m1")
    assert base != profile_version({**DOCS, "ALM.pptx": DOCS["ALM.pptx"] + "\nRULE: new"}, "m1")
    assert base != profile_version({k: v for k, v in DOCS.items() if k != "ALM.pptx"}, "m1")
    assert base != profile_version(DOCS, "m2")
    assert SCHEMA_VERSION in json.dumps([SCHEMA_VERSION])  # the schema version is part of the version input


class _Kb:
    """The slice of KbVectorStore the service reads."""

    def __init__(self, docs: dict[str, str]) -> None:
        self.docs = docs

    def list_documents(self, user_id: str) -> list[str]:
        return sorted(self.docs)

    def get_document(self, user_id: str, source_file: str) -> tuple[str | None, bool]:
        return self.docs.get(source_file), False


def test_ensure_profile_builds_once_and_rebuilds_only_when_the_knowledge_base_changes() -> None:
    store, client, kb = InMemoryProfileStore(), FakeProfileClient(), _Kb(dict(DOCS))

    first = ensure_profile("u1", kb, store, client, model="m1")
    calls_after_first = len(client.extract_calls)
    again = ensure_profile("u1", kb, store, client, model="m1")
    assert again == first and len(client.extract_calls) == calls_after_first  # stored, not rebuilt

    kb.docs["new.pptx"] = "CAT: Verifiable | by test"
    rebuilt = ensure_profile("u1", kb, store, client, model="m1")
    assert rebuilt.version != first.version and "verifiable" in {c.name.casefold() for c in rebuilt.categories}

    other_model = ensure_profile("u1", kb, store, client, model="m2")
    assert other_model.version != rebuilt.version and other_model.built_with == "m2"


def test_no_knowledge_base_means_no_profile_and_other_users_are_separate() -> None:
    store, client = InMemoryProfileStore(), FakeProfileClient()
    assert ensure_profile("u1", _Kb({}), store, client, model="m1") is None
    ensure_profile("u2", _Kb(DOCS), store, client, model="m1")
    assert store.get("u1") is None and store.get("u2") is not None


def test_a_stored_profile_round_trips() -> None:
    profile = build_profile(DOCS, FakeProfileClient(), model="m1")
    assert KbProfile.model_validate_json(profile.model_dump_json()) == profile


def test_merge_is_a_pure_function_of_the_per_document_results() -> None:
    per_doc = {"b.pptx": {"categories": [{"name": "X", "pass_condition": "1"}], "type_definitions": [], "rules": [], "glossary": []}}
    assert merge_document_profiles(per_doc, "m1", "v").categories[0].sources == ["b.pptx"]


# --- scoring from the profile ---------------------------------------------------------------------------------

def test_the_scoring_inputs_are_one_fixed_category_list_with_its_pass_conditions_and_a_small_constant_context() -> None:
    from app.kb.profile import scoring_inputs

    profile = build_profile(DOCS, FakeProfileClient(), model="m1")
    categories, definitions, context = scoring_inputs(profile)

    assert [c.casefold() for c in categories] == [c.name.casefold() for c in profile.categories]
    assert definitions["Clear and unambiguous"] == "One reading only"
    assert context is not None and "Testable" in context and "Implementable: Can be built" in context
    assert "One requirement per statement" in context  # the mandatory rules judge a requirement too
    assert len(context) < 8_000


def test_scoring_inputs_ignore_a_profile_with_no_categories_so_the_old_behaviour_applies() -> None:
    from app.kb.profile import scoring_inputs

    assert scoring_inputs(None) == (None, None, None)
    empty = build_profile({"notes.docx": "prose"}, FakeProfileClient(), model="m1")
    assert scoring_inputs(empty) == (None, None, None)


def test_the_scoring_context_does_not_grow_with_the_knowledge_base() -> None:
    from app.kb.profile import scoring_inputs

    big = {f"d{i}.pptx": "\n".join(f"CAT: Category {i}-{j} | " + "condition " * 40 for j in range(30)) for i in range(10)}
    _, _, context = scoring_inputs(build_profile(big, FakeProfileClient(), model="m1"))
    assert len(context) < 8_000


# --- the authoring standard in generation prompts ---------------------------------------------------------------

def test_the_authoring_standard_states_definitions_rules_terms_and_the_quality_bar_within_a_budget() -> None:
    from app.kb.profile import render_authoring_standard

    profile = build_profile(DOCS, FakeProfileClient(), model="m1")
    text = render_authoring_standard(profile)
    assert text is not None and len(text) < 6_500
    assert "Requirement: A verifiable statement of need" in text and "Epic: A large body of work" in text
    assert "One requirement per statement" in text
    assert "SRS: software requirements specification" in text
    assert "Implementable: Can be built" in text
    assert render_authoring_standard(profile) == text  # deterministic


def test_there_is_no_authoring_standard_without_a_profile_or_without_content() -> None:
    from app.kb.profile import render_authoring_standard

    assert render_authoring_standard(None) is None
    assert render_authoring_standard(build_profile({"n.docx": "prose"}, FakeProfileClient(), model="m1")) is None


def test_the_authoring_standard_stays_inside_its_budget_for_a_huge_knowledge_base() -> None:
    from app.kb.profile import render_authoring_standard

    big = {f"d{i}.pptx": "\n".join(f"RULE: rule {i}-{j} " + "words " * 40 for j in range(60)) for i in range(5)}
    assert len(render_authoring_standard(build_profile(big, FakeProfileClient(), model="m1"))) < 6_500
