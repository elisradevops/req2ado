"""Overlapping quality categories (Testable / Testability, Clear and unambiguous / Unambiguity, ...) are consolidated by
meaning into a short canonical list, so scoring judges each quality once. The consolidation never loses a source and never
fails the profile build."""
from app.kb.profile import CONSOLIDATION_RUNS, MAX_SCORING_CATEGORIES, SCHEMA_VERSION, build_profile
from tests.test_kb_profile import FakeProfileClient

OVERLAPPING = {
    "HowTo.pptx": "CAT: Clear and unambiguous | One reading only\nCAT: Testable | Can be verified\nCAT: Consistent terminology | Same word, same meaning",
    "Principles.pptx": "CAT: Unambiguity | One reading only\nCAT: Testability | Verified by test\nCAT: Traceability | Linked to its source\nCAT: Essential | Needed",
}

GROUPS = {
    "Clear and unambiguous": ["Clear and unambiguous", "Unambiguity"],
    "Testable": ["Testable", "Testability"],
    "Consistent terminology": ["Consistent terminology"],
    "Traceable": ["Traceability", "Essential"],
}


class Consolidating(FakeProfileClient):
    """Answers every run with `groups`, or run by run with `runs` (a list of group dicts; None = that run fails)."""

    def __init__(self, groups=GROUPS, fail=False, runs=None) -> None:
        super().__init__()
        self.groups, self.fail, self.runs, self.calls, self.preferred = groups, fail, runs, [], []

    def consolidate_kb_categories(self, categories, max_categories, user_id=None, preferred_names=None):
        self.calls.append((categories, max_categories))
        self.preferred.append(preferred_names)
        if self.fail:
            raise RuntimeError("model down")
        groups = self.groups
        if self.runs is not None:
            groups = self.runs[(len(self.calls) - 1) % len(self.runs)]
            if groups is None:
                raise RuntimeError("model down")
        return [{"name": name, "pass_condition": f"{name} condition", "merged_from": members} for name, members in groups.items()]


def test_overlapping_categories_become_one_short_list_that_keeps_every_source() -> None:
    client = Consolidating()
    profile = build_profile(OVERLAPPING, client, model="m1")
    assert [c.name for c in profile.categories] == ["Clear and unambiguous", "Testable", "Consistent terminology", "Traceable"]
    by_name = {c.name: c for c in profile.categories}
    assert by_name["Testable"].sources == ["HowTo.pptx", "Principles.pptx"]
    assert by_name["Traceable"].sources == ["Principles.pptx"]
    assert by_name["Testable"].pass_condition == "Testable condition"
    assert len(client.calls) == CONSOLIDATION_RUNS and client.calls[0][1] == MAX_SCORING_CATEGORIES


def test_the_merge_pass_receives_each_category_once_with_its_condition() -> None:
    client = Consolidating()
    build_profile(OVERLAPPING, client, model="m1")
    sent = {c["name"] for c in client.calls[0][0]}
    assert sent == {"Clear and unambiguous", "Testable", "Consistent terminology", "Unambiguity", "Testability", "Traceability", "Essential"}


def test_a_category_the_model_did_not_place_is_kept_not_lost() -> None:
    profile = build_profile(OVERLAPPING, Consolidating(groups={"Clear": ["Clear and unambiguous", "Unambiguity"]}), model="m1")
    assert "Testable" in {c.name for c in profile.categories}  # unplaced entries survive under their own name


def test_the_list_never_exceeds_the_cap_and_keeps_the_best_supported_entries() -> None:
    many = {f"C{i}": [f"Cat{i}"] for i in range(MAX_SCORING_CATEGORIES + 4)}
    docs = {"A.pptx": "\n".join(f"CAT: Cat{i} | c" for i in range(MAX_SCORING_CATEGORIES + 4)), "B.pptx": "CAT: Cat3 | c"}
    profile = build_profile(docs, Consolidating(groups=many), model="m1")
    assert len(profile.categories) == MAX_SCORING_CATEGORIES
    assert "C3" in {c.name for c in profile.categories}  # supported by two documents
    assert profile.truncated is True


def test_a_failed_or_missing_merge_pass_falls_back_to_the_capped_deterministic_list() -> None:
    for client in (Consolidating(fail=True), FakeProfileClient()):
        profile = build_profile(OVERLAPPING, client, model="m1")
        assert 0 < len(profile.categories) <= MAX_SCORING_CATEGORIES
        assert profile.docs_contributing == 2


def test_nothing_is_asked_when_there_is_nothing_to_merge() -> None:
    client = Consolidating()
    build_profile({"A.pptx": "CAT: Testable | c"}, client, model="m1")
    assert client.calls == []


def test_the_schema_version_changed_so_stored_profiles_are_rebuilt() -> None:
    assert SCHEMA_VERSION not in ("kb-profile-1", "kb-profile-2")


# ---- the model decides the categories; majority vote over several runs makes the decision stable ----

SEPARATE = {"Testable": ["Testable"], "Testability": ["Testability"], "Clear": ["Clear and unambiguous", "Unambiguity"], "Consistent": ["Consistent terminology"], "Traceability": ["Traceability"], "Essential": ["Essential"]}
MERGED = {**{k: v for k, v in SEPARATE.items() if k not in ("Testable", "Testability")}, "Testable": ["Testable", "Testability"]}


def names_of(profile) -> list[str]:
    return sorted(c.name for c in profile.categories)


def test_a_merge_most_runs_agree_on_is_kept_and_one_dissenting_run_does_not_change_the_result() -> None:
    profile = build_profile(OVERLAPPING, Consolidating(runs=[MERGED, SEPARATE, MERGED]), model="m1")
    assert "Testable" in names_of(profile) and "Testability" not in names_of(profile)
    assert next(c for c in profile.categories if c.name == "Testable").sources == ["HowTo.pptx", "Principles.pptx"]


def test_a_merge_only_one_run_proposed_is_not_made() -> None:
    profile = build_profile(OVERLAPPING, Consolidating(runs=[SEPARATE, MERGED, SEPARATE]), model="m1")
    assert {"Testable", "Testability"} <= set(names_of(profile))


def test_the_result_does_not_depend_on_the_order_the_runs_come_in() -> None:
    runs = [MERGED, SEPARATE, MERGED]
    results = {tuple(names_of(build_profile(OVERLAPPING, Consolidating(runs=[runs[i] for i in order]), model="m1"))) for order in [(0, 1, 2), (1, 2, 0), (2, 0, 1), (1, 0, 2)]}
    assert len(results) == 1


def test_the_most_common_name_wins_and_ties_are_broken_the_same_way_every_time() -> None:
    a = {"Verifiable": ["Testable", "Testability"], **{k: v for k, v in SEPARATE.items() if k not in ("Testable", "Testability")}}
    b = {"Testable": ["Testable", "Testability"], **{k: v for k, v in SEPARATE.items() if k not in ("Testable", "Testability")}}
    for runs in ([a, b, b], [b, a, b], [b, b, a]):
        assert "Testable" in names_of(build_profile(OVERLAPPING, Consolidating(runs=runs), model="m1"))
    tie = [names_of(build_profile(OVERLAPPING, Consolidating(runs=order), model="m1")) for order in ([a, b, None], [b, a, None])]
    assert tie[0] == tie[1]


def test_a_failed_run_is_ignored_and_all_runs_failing_keeps_the_deterministic_list() -> None:
    profile = build_profile(OVERLAPPING, Consolidating(runs=[MERGED, None, MERGED]), model="m1")
    assert "Testability" not in names_of(profile)
    fallback = build_profile(OVERLAPPING, Consolidating(runs=[None, None, None]), model="m1")
    assert fallback.docs_contributing == 2 and len(fallback.categories) == 7


def test_the_model_decides_how_many_categories_there_are_no_cut_to_a_small_number() -> None:
    twelve = {f"Quality {i}": [f"Cat{i}"] for i in range(12)}
    docs = {"A.pptx": "\n".join(f"CAT: Cat{i} | c" for i in range(12))}
    profile = build_profile(docs, Consolidating(groups=twelve), model="m1")
    assert len(profile.categories) == 12 and profile.truncated is False


def test_the_previous_category_names_are_offered_on_a_rebuild_so_names_stay_stable() -> None:
    first = build_profile(OVERLAPPING, Consolidating(), model="m1")
    client = Consolidating()
    build_profile({**OVERLAPPING, "New.pptx": "CAT: Testable | Verified"}, client, model="m1", previous=first)
    assert all(set(p or []) == {c.name for c in first.categories} for p in client.preferred)
    fresh = Consolidating()
    build_profile(OVERLAPPING, fresh, model="m1")
    assert all(not p for p in fresh.preferred)
