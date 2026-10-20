"""Overlapping quality categories (Testable / Testability, Clear and unambiguous / Unambiguity, ...) are consolidated into a short
canonical list, so scoring judges each quality once.

The MODEL decides which categories judge the same quality (asked several times; a pair is merged when most runs agree). The
name and pass condition of the merged entry are NOT written by the model: they are one of the member categories as the
documents themselves wrote them, chosen by rule, so a rebuild cannot rename a quality by sampling. A rebuild keeps the previous
profile's names and groups. The consolidation never loses a source and never fails the profile build."""
import random
import threading

from app.kb.profile import (
    CONSOLIDATION_RUNS, MAX_SCORING_CATEGORIES, SCHEMA_VERSION, Category, InMemoryProfileStore, KbProfile, _key, build_profile,
    ensure_profile,
)
from tests.test_kb_profile import FakeProfileClient

OVERLAPPING = {
    "HowTo.pptx": "CAT: Clear and unambiguous | One reading only\nCAT: Testable | Can be verified\nCAT: Consistent terminology | Same word, same meaning",
    "Principles.pptx": "CAT: Unambiguity | One reading only\nCAT: Testability | Verified by test\nCAT: Traceability | Linked to its source\nCAT: Essential | Needed",
}

# What a run says: which input categories belong together (the group names are the model's own words and are not used).
GROUPS = {
    "Clear": ["Clear and unambiguous", "Unambiguity"],
    "Verifiable": ["Testable", "Testability"],
    "Consistent": ["Consistent terminology"],
    "Traced": ["Traceability", "Essential"],
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
        return [{"name": name, "pass_condition": f"{name} (the model's wording)", "merged_from": members} for name, members in groups.items()]


def names_of(profile) -> list[str]:
    return sorted(c.name for c in profile.categories)


def test_overlapping_categories_become_one_short_list_named_in_the_documents_own_words() -> None:
    client = Consolidating()
    profile = build_profile(OVERLAPPING, client, model="m1")
    # Among the members the shorter wording wins when the documents support them equally: Testable, Unambiguity, Essential.
    assert [c.name for c in profile.categories] == ["Testable", "Unambiguity", "Consistent terminology", "Essential"]
    by_name = {c.name: c for c in profile.categories}
    assert by_name["Testable"].sources == ["HowTo.pptx", "Principles.pptx"]
    assert by_name["Essential"].sources == ["Principles.pptx"]
    assert len(client.calls) == CONSOLIDATION_RUNS and client.calls[0][1] == MAX_SCORING_CATEGORIES


def test_the_pass_condition_is_the_chosen_members_own_text_never_the_models() -> None:
    profile = build_profile(OVERLAPPING, Consolidating(), model="m1")
    by_name = {c.name: c for c in profile.categories}
    assert by_name["Testable"].pass_condition == "Can be verified"
    assert by_name["Unambiguity"].pass_condition == "One reading only"
    assert all("model's wording" not in (c.pass_condition or "") for c in profile.categories)


def test_each_entry_records_which_document_categories_it_stands_for() -> None:
    profile = build_profile(OVERLAPPING, Consolidating(), model="m1")
    by_name = {c.name: c for c in profile.categories}
    assert by_name["Testable"].merged_from == ["Testable", "Testability"]
    assert by_name["Essential"].merged_from == ["Traceability", "Essential"]
    assert by_name["Consistent terminology"].merged_from == ["Consistent terminology"]


def test_the_merge_pass_receives_each_category_once_with_its_condition() -> None:
    client = Consolidating()
    build_profile(OVERLAPPING, client, model="m1")
    sent = {c["name"] for c in client.calls[0][0]}
    assert sent == {"Clear and unambiguous", "Testable", "Consistent terminology", "Unambiguity", "Testability", "Traceability", "Essential"}


def test_a_category_the_model_did_not_place_is_kept_not_lost() -> None:
    profile = build_profile(OVERLAPPING, Consolidating(groups={"Clear": ["Clear and unambiguous", "Unambiguity"]}), model="m1")
    assert "Testable" in names_of(profile) and "Testability" in names_of(profile)  # unplaced entries survive under their own name


def test_the_list_never_exceeds_the_ceiling_and_keeps_the_best_supported_entries() -> None:
    many = {f"C{i}": [f"Cat{i}"] for i in range(MAX_SCORING_CATEGORIES + 4)}
    docs = {"A.pptx": "\n".join(f"CAT: Cat{i} | c" for i in range(MAX_SCORING_CATEGORIES + 4)), "B.pptx": "CAT: Cat3 | c"}
    profile = build_profile(docs, Consolidating(groups=many), model="m1")
    assert len(profile.categories) == MAX_SCORING_CATEGORIES
    assert "Cat3" in names_of(profile)  # supported by two documents
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
    assert SCHEMA_VERSION not in ("kb-profile-1", "kb-profile-2", "kb-profile-3")


# ---- the model decides the groups; most runs must agree ----

SEPARATE = {"Testable": ["Testable"], "Testability": ["Testability"], "Clear": ["Clear and unambiguous", "Unambiguity"], "Consistent": ["Consistent terminology"], "Traceability": ["Traceability"], "Essential": ["Essential"]}
MERGED = {**{k: v for k, v in SEPARATE.items() if k not in ("Testable", "Testability")}, "Verifiable": ["Testable", "Testability"]}


def test_a_merge_most_runs_agree_on_is_made_and_one_dissenting_run_does_not_change_the_result() -> None:
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


def test_the_models_own_names_are_ignored_so_they_cannot_change_the_result() -> None:
    renamed = {("Verifiable" if k == "Verifiable" else k): v for k, v in MERGED.items()}
    other = {("Quality of verification" if k == "Verifiable" else k): v for k, v in MERGED.items()}
    a = build_profile(OVERLAPPING, Consolidating(runs=[renamed, other, renamed]), model="m1")
    b = build_profile(OVERLAPPING, Consolidating(runs=[other, other, other]), model="m1")
    assert names_of(a) == names_of(b)
    assert "Verifiable" not in names_of(a) and "Quality of verification" not in names_of(a)


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


def test_names_are_unique_whatever_the_model_says_and_the_result_is_independent_of_run_order() -> None:
    docs = {
        "A.pptx": "CAT: Essential | a\nCAT: Clarity | b\nCAT: Testable | c\nCAT: Necessary | d",
        "B.pptx": "CAT: essential | a\nCAT: Unambiguity | b\nCAT: Testability | c\nCAT: Traceability | e",
    }
    inputs = ["Essential", "Clarity", "Testable", "Necessary", "Unambiguity", "Testability", "Traceability"]
    for seed in range(40):
        rng = random.Random(seed)

        def random_run() -> dict:
            shuffled = inputs[:]
            rng.shuffle(shuffled)
            groups, i = {}, 0
            while i < len(shuffled):
                size = rng.randint(1, 3)
                groups[f"G{len(groups)}"] = shuffled[i:i + size]
                i += size
            return groups

        runs = [random_run() for _ in range(3)]
        a = build_profile(docs, Consolidating(runs=runs), model="m1")
        b = build_profile(docs, Consolidating(runs=list(reversed(runs))), model="m1")
        assert [c.name for c in a.categories] == [c.name for c in b.categories], seed
        assert len({_key(c.name) for c in a.categories}) == len(a.categories), seed  # no two entries share a name
        assert {src for c in a.categories for src in c.sources} == {"A.pptx", "B.pptx"}


# ---- a rebuild keeps what the previous profile decided ----

def previous_profile(names_to_members: dict[str, list[str]], sources=("HowTo.pptx", "Principles.pptx")) -> KbProfile:
    return KbProfile(
        version="old", built_with="m1",
        categories=[Category(name=name, pass_condition="old condition", sources=list(sources), merged_from=members) for name, members in names_to_members.items()],
    )


def test_the_previous_profiles_names_win_over_the_rule_on_a_rebuild() -> None:
    previous = previous_profile({"Testability": ["Testable", "Testability"]})
    profile = build_profile(OVERLAPPING, Consolidating(), model="m1", previous=previous)
    assert "Testability" in names_of(profile) and "Testable" not in names_of(profile)  # the rule alone would pick "Testable"


def test_a_group_the_previous_profile_made_stays_together_even_if_this_time_no_run_merges_it() -> None:
    previous = previous_profile({"Testable": ["Testable", "Testability"]})
    profile = build_profile(OVERLAPPING, Consolidating(runs=[SEPARATE, SEPARATE, SEPARATE]), model="m1", previous=previous)
    assert "Testable" in names_of(profile) and "Testability" not in names_of(profile)


def test_a_previous_member_that_no_document_names_any_more_is_forgotten() -> None:
    previous = previous_profile({"Gone": ["Gone", "Testable"]})
    profile = build_profile(OVERLAPPING, Consolidating(runs=[SEPARATE] * 3), model="m1", previous=previous)
    assert "Gone" not in names_of(profile) and "Testable" in names_of(profile)


def test_the_previous_category_names_are_offered_to_the_model_only_on_a_rebuild() -> None:
    first = build_profile(OVERLAPPING, Consolidating(), model="m1")
    client = Consolidating()
    build_profile({**OVERLAPPING, "New.pptx": "CAT: Testable | Verified"}, client, model="m1", previous=first)
    assert all(set(p or []) == {c.name for c in first.categories} for p in client.preferred)
    fresh = Consolidating()
    build_profile(OVERLAPPING, fresh, model="m1")
    assert all(not p for p in fresh.preferred)


def test_a_profile_stored_before_merged_from_existed_still_reads() -> None:
    old = build_profile(OVERLAPPING, Consolidating(), model="m1").model_dump()
    for category in old["categories"]:
        category.pop("merged_from", None)
    assert all(c.merged_from == [] for c in KbProfile.model_validate(old).categories)


# ---- one build at a time per user ----

def test_two_concurrent_requests_for_the_same_users_profile_build_it_once() -> None:
    class SlowClient(Consolidating):
        def extract_kb_document_profile(self, name, window_text, user_id=None):
            import time

            time.sleep(0.05)
            return super().extract_kb_document_profile(name, window_text, user_id=user_id)

    class Kb:
        def list_documents(self, user_id):
            return sorted(OVERLAPPING)

        def get_document(self, user_id, name):
            return OVERLAPPING[name], False

    store, client, results = InMemoryProfileStore(), SlowClient(), []

    def request() -> None:
        results.append(ensure_profile("u-lock", Kb(), store, client, model="m1"))

    threads = [threading.Thread(target=request) for _ in range(3)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert len(client.extract_calls) == len(OVERLAPPING)  # extracted once per document, not once per request
    assert len({r.built_at for r in results}) == 1  # everyone got the same stored profile


# ---- a build is visible: one log line with numbers, and a build time on the stored profile ----

def test_a_build_logs_one_line_with_the_numbers_and_never_the_names(caplog) -> None:
    import logging

    with caplog.at_level(logging.INFO, logger="app.kb.profile"):
        build_profile(OVERLAPPING, Consolidating(runs=[MERGED, SEPARATE, MERGED]), model="m1")
    line = next(r.getMessage() for r in caplog.records if "KB profile built" in r.getMessage())
    assert "documents=2" in line and "contributing=2" in line and "model=m1" in line
    assert "runs=3/3" in line and "contested_pairs=" in line and "duration=" in line
    assert "Testable" not in line and "Unambiguity" not in line  # counts only


def test_the_consolidation_log_counts_the_runs_that_answered_and_the_pairs_they_disagreed_on(caplog) -> None:
    import logging

    with caplog.at_level(logging.INFO, logger="app.kb.profile"):
        build_profile(OVERLAPPING, Consolidating(runs=[MERGED, None, SEPARATE]), model="m1")
    line = next(r.getMessage() for r in caplog.records if "KB profile built" in r.getMessage())
    assert "runs=2/3" in line and "contested_pairs=1" in line  # Testable/Testability: one run merged them, one did not


def test_the_stored_profile_has_a_build_time_that_is_not_part_of_the_version() -> None:
    from app.kb.profile import InMemoryProfileStore, ensure_profile, profile_version

    class Kb:
        def list_documents(self, user_id):
            return sorted(OVERLAPPING)

        def get_document(self, user_id, name):
            return OVERLAPPING[name], False

    store = InMemoryProfileStore()
    profile = ensure_profile("u1", Kb(), store, Consolidating(), model="m1")
    assert profile.built_at and profile.built_at.endswith("+00:00")
    assert profile.version == profile_version(OVERLAPPING, "m1")
    assert store.get("u1").built_at == profile.built_at


def test_a_profile_stored_before_the_build_time_existed_still_reads() -> None:
    from app.kb.profile import KbProfile

    old = build_profile(OVERLAPPING, Consolidating(), model="m1").model_dump()
    old.pop("built_at", None)
    assert KbProfile.model_validate(old).built_at is None
