"""A document's categories are read several times, and what most runs agree on is kept.

The extraction is a temperature-1 sample. One sample wrote 'Complete' where another wrote 'Completeness', and an invented extra
category now and then. Each window is now read EXTRACTION_RUNS times: every wording is a candidate, the merge pass pools the
wordings that mean the same quality, a quality is kept only when most runs produced it (in the same document), and the name of a
merged entry is the wording most runs gave."""
import pytest

from app.kb import profile as profile_module
from app.kb.profile import EXTRACTION_RUNS, InMemoryProfileStore, build_profile, ensure_profile, extraction_version
from tests.test_kb_profile import FakeProfileClient
from tests.test_kb_profile_cache import Kb


@pytest.fixture(autouse=True)
def three_runs(monkeypatch):
    monkeypatch.setattr(profile_module, "EXTRACTION_RUNS", 3)


class RunClient(FakeProfileClient):
    """Answers the n-th call about a document with `script[document][n % 3]`: a list of (category, condition)."""

    def __init__(self, script: dict[str, list[list[tuple[str, str]]]], groups: dict | None = None, rules=None) -> None:
        super().__init__()
        self.script, self.groups, self.rules, self.seen = script, groups or {}, rules or {}, {}

    def extract_kb_document_profile(self, name, window_text, user_id=None):
        self.extract_calls.append(name)
        n = self.seen[name] = self.seen.get(name, -1) + 1
        run = self.script[name][n % 3]
        return {"categories": [{"name": c, "pass_condition": p} for c, p in run], "rules": list(self.rules.get(name, {}).get(n % 3, [])),
                "type_definitions": [], "glossary": []}

    def consolidate_kb_categories(self, categories, max_categories, user_id=None, preferred_names=None):
        names = {c["name"] for c in categories}
        out, placed = [], set()
        for members in self.groups.values():
            present = [m for m in members if m in names]
            if present:
                out.append({"name": present[0], "pass_condition": "", "merged_from": present})
                placed.update(present)
        out += [{"name": n, "pass_condition": "", "merged_from": [n]} for n in sorted(names - placed)]
        return out


DOC = "A.pptx"
TEXT = {DOC: "text of the document"}


def names_of(profile) -> list[str]:
    return sorted(c.name for c in profile.categories)


def test_each_window_is_read_once_per_run() -> None:
    client = RunClient({DOC: [[("Testable", "t")]] * 3})
    build_profile(TEXT, client, model="m1")
    assert client.extract_calls.count(DOC) == EXTRACTION_RUNS == 3


def test_wordings_of_one_quality_are_pooled_and_the_wording_most_runs_gave_is_the_name() -> None:
    script = {DOC: [[("Complete", "c")], [("Completeness", "c")], [("Completeness", "c")]]}
    groups = {"complete": ["Complete", "Completeness"]}
    profile = build_profile(TEXT, RunClient(script, groups), model="m1")
    assert names_of(profile) == ["Completeness"]  # 2 runs against 1; the rule alone would have picked the shorter "Complete"


def test_the_result_does_not_depend_on_which_run_wrote_which_wording() -> None:
    groups = {"complete": ["Complete", "Completeness"]}
    wordings = [[("Complete", "c")], [("Completeness", "c")], [("Complete", "c")]]
    results = set()
    for order in ([0, 1, 2], [1, 2, 0], [2, 0, 1], [1, 0, 2]):
        profile = build_profile(TEXT, RunClient({DOC: [wordings[i] for i in order]}, groups), model="m1")
        results.add(tuple(names_of(profile)))
    assert results == {("Complete",)}


def test_a_category_only_one_run_produced_is_dropped_and_one_two_runs_produced_is_kept() -> None:
    script = {DOC: [[("Testable", "t"), ("Invented", "i")], [("Testable", "t"), ("Singular", "s")], [("Testable", "t"), ("Singular", "s")]]}
    assert names_of(build_profile(TEXT, RunClient(script), model="m1")) == ["Singular", "Testable"]


def test_wordings_that_are_one_quality_together_can_reach_the_majority_when_none_does_alone() -> None:
    script = {DOC: [[("Complete", "c")], [("Completeness", "c")], [("Testable", "t")]]}
    # "Complete" and "Completeness" are one quality seen in two runs; "Testable" was seen once.
    profile = build_profile(TEXT, RunClient(script, {"complete": ["Complete", "Completeness"]}), model="m1")
    assert names_of(profile) == ["Complete"]  # one run each: equal support, so the plainer (shorter) wording
    assert "Testable" not in names_of(profile)


def test_runs_are_counted_per_document_not_pooled_across_documents() -> None:
    texts = {"A.pptx": "a", "B.pptx": "b"}
    script = {
        "A.pptx": [[("Odd", "o"), ("Fine", "f")], [("Fine", "f")], [("Fine", "f")]],  # Odd: run 0 of A only
        "B.pptx": [[("Fine", "f")], [("Odd", "o"), ("Fine", "f")], [("Fine", "f")]],  # Odd: run 1 of B only
    }
    # Two runs in all, but never two in the same document: no majority in either.
    assert names_of(build_profile(texts, RunClient(script), model="m1")) == ["Fine"]


def test_when_nothing_would_survive_the_majority_the_candidates_are_kept_rather_than_an_empty_profile() -> None:
    script = {DOC: [[("One", "1")], [("Two", "2")], [("Three", "3")]]}
    assert names_of(build_profile(TEXT, RunClient(script), model="m1")) == ["One", "Three", "Two"]


def test_rules_are_pooled_across_the_runs() -> None:
    script = {DOC: [[("Testable", "t")]] * 3}
    client = RunClient(script, rules={DOC: {0: ["Rule one"], 1: ["Rule one", "Rule two"], 2: []}})
    assert sorted(r.text for r in build_profile(TEXT, client, model="m1").rules) == ["Rule one", "Rule two"]


def test_a_run_that_failed_makes_the_build_degraded_so_it_is_not_stored() -> None:
    class OneRunFails(RunClient):
        def extract_kb_document_profile(self, name, window_text, user_id=None):
            if len(self.extract_calls) == 1:
                self.extract_calls.append(name)
                raise RuntimeError("model down")
            return super().extract_kb_document_profile(name, window_text, user_id=user_id)

    store, kb = InMemoryProfileStore(), Kb(dict(TEXT))
    profile = ensure_profile("u1", kb, store, OneRunFails({DOC: [[("Testable", "t")]] * 3}), model="m1")
    assert profile.degraded and store.get("u1") is None


def test_the_runs_are_part_of_what_a_stored_extraction_is_valid_for(monkeypatch) -> None:
    three = extraction_version()
    monkeypatch.setattr(profile_module, "EXTRACTION_RUNS", 1)
    assert extraction_version() != three


def test_a_cached_document_is_not_read_again_and_keeps_its_run_support() -> None:
    script = {DOC: [[("Testable", "t"), ("Invented", "i")], [("Testable", "t")], [("Testable", "t")]]}
    store, kb, client = InMemoryProfileStore(), Kb({**TEXT}), RunClient(script)
    first = ensure_profile("u1", kb, store, client, model="m1")
    kb.docs["B.pptx"] = "b"
    client.script["B.pptx"] = [[("Singular", "s")]] * 3
    second = ensure_profile("u1", kb, store, client, model="m1")
    assert client.extract_calls.count(DOC) == 3  # not read again
    assert names_of(first) == ["Testable"] and names_of(second) == ["Singular", "Testable"]
