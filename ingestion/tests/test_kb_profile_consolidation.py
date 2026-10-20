"""Overlapping quality categories (Testable / Testability, Clear and unambiguous / Unambiguity, ...) are consolidated by
meaning into a short canonical list, so scoring judges each quality once. The consolidation never loses a source and never
fails the profile build."""
from app.kb.profile import MAX_SCORING_CATEGORIES, SCHEMA_VERSION, build_profile
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
    def __init__(self, groups=GROUPS, fail=False) -> None:
        super().__init__()
        self.groups, self.fail, self.calls = groups, fail, []

    def consolidate_kb_categories(self, categories, max_categories, user_id=None):
        self.calls.append((categories, max_categories))
        if self.fail:
            raise RuntimeError("model down")
        return [{"name": name, "pass_condition": f"{name} condition", "merged_from": members} for name, members in self.groups.items()]


def test_overlapping_categories_become_one_short_list_that_keeps_every_source() -> None:
    client = Consolidating()
    profile = build_profile(OVERLAPPING, client, model="m1")
    assert [c.name for c in profile.categories] == ["Clear and unambiguous", "Testable", "Consistent terminology", "Traceable"]
    by_name = {c.name: c for c in profile.categories}
    assert by_name["Testable"].sources == ["HowTo.pptx", "Principles.pptx"]
    assert by_name["Traceable"].sources == ["Principles.pptx"]
    assert by_name["Testable"].pass_condition == "Testable condition"
    assert len(client.calls) == 1 and client.calls[0][1] == MAX_SCORING_CATEGORIES


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
    assert SCHEMA_VERSION != "kb-profile-1"
