"""The rubric is reviewable and the user can pin it.

The categories a job is graded against were model-derived and only the numbers reached the user. A user can now see the rubric (each category,
its pass condition, the document wordings merged into it, where it comes from), pin or edit a category, add one of their own, or remove one.
Pins and removals are the user's decision: they override what the model derived, survive a rebuild, and are part of the rubric's version."""
import pytest
from fastapi.testclient import TestClient

from app import main
from app.kb.default_rubric import default_profile
from app.kb.kb_vector_store import KbVectorStore
from app.kb.profile import Category, ChromaProfileStore, InMemoryProfileStore, KbProfile
from app.kb.rubric import RubricOverrides, RubricPin, apply_overrides, rubric_view, validate_overrides

client = TestClient(main.app)


def base() -> KbProfile:
    return KbProfile(
        version="v-base", built_with="m1", built_at="2026-10-21T10:00:00+00:00",
        categories=[
            Category(name="Testable", pass_condition="Can be verified", sources=["A.pptx", "B.pptx"], merged_from=["Testable", "Testability"]),
            Category(name="Unambiguity", pass_condition="One reading only", sources=["A.pptx"], merged_from=["Unambiguity"]),
            Category(name="Essential", pass_condition="Needed", sources=["B.pptx"], merged_from=["Essential and Traceable", "Essential"]),
        ],
    )


def names(profile: KbProfile) -> list[str]:
    return [c.name for c in profile.categories]


def test_no_overrides_leave_the_rubric_and_its_version_as_they_are() -> None:
    effective = apply_overrides(base(), None)
    assert names(effective) == ["Testable", "Unambiguity", "Essential"] and effective.version == "v-base"
    assert apply_overrides(base(), RubricOverrides()).version == "v-base"


def test_a_pin_replaces_the_name_and_pass_condition_and_keeps_where_the_category_came_from() -> None:
    effective = apply_overrides(base(), RubricOverrides(pinned=[RubricPin(name="Testable", pass_condition="Has a measurable acceptance criterion")]))
    testable = next(c for c in effective.categories if c.name == "Testable")
    assert testable.pass_condition == "Has a measurable acceptance criterion"
    assert testable.sources == ["A.pptx", "B.pptx"] and testable.merged_from == ["Testable", "Testability"]
    assert effective.version != "v-base"  # a different rubric is a different version (and a different cache key)


def test_a_pin_matches_a_category_by_any_wording_merged_into_it_so_it_survives_a_rename() -> None:
    renamed_base = base()
    renamed_base.categories[0] = renamed_base.categories[0].model_copy(update={"name": "Testability"})  # a rebuild picked another wording
    effective = apply_overrides(renamed_base, RubricOverrides(pinned=[RubricPin(name="Testable", pass_condition="Pinned condition")]))
    assert names(effective).count("Testable") == 1 and "Testability" not in names(effective)  # the pin's name wins, no duplicate
    assert next(c for c in effective.categories if c.name == "Testable").pass_condition == "Pinned condition"


def test_a_removed_category_is_gone_also_when_named_by_a_merged_wording() -> None:
    effective = apply_overrides(base(), RubricOverrides(removed=["Essential and Traceable", "unambiguity"]))
    assert names(effective) == ["Testable"]


def test_a_pin_that_matches_nothing_is_the_users_own_category() -> None:
    effective = apply_overrides(base(), RubricOverrides(pinned=[RubricPin(name="Safety-relevant", pass_condition="Names the hazard it mitigates")]))
    assert names(effective)[-1] == "Safety-relevant"
    custom = effective.categories[-1]
    assert custom.pass_condition == "Names the hazard it mitigates" and custom.merged_from == ["Safety-relevant"]


def test_pins_survive_a_rebuild_because_they_belong_to_the_user_not_to_one_profile() -> None:
    overrides = RubricOverrides(pinned=[RubricPin(name="Testable", pass_condition="Pinned")], removed=["Essential"])
    rebuilt = KbProfile(version="v-rebuilt", built_with="m1", categories=[
        Category(name="Testable", pass_condition="A fresh wording", sources=["A.pptx"], merged_from=["Testable"]),
        Category(name="Essential and Traceable", sources=["A.pptx"], merged_from=["Essential and Traceable"]),
        Category(name="Singular", pass_condition="One thing", sources=["A.pptx"], merged_from=["Singular"]),
    ])
    effective = apply_overrides(rebuilt, overrides)
    assert [(c.name, c.pass_condition) for c in effective.categories] == [("Testable", "Pinned"), ("Essential and Traceable", None), ("Singular", "One thing")]


def test_the_view_says_what_is_pinned_where_each_category_comes_from_and_what_was_removed() -> None:
    overrides = RubricOverrides(pinned=[RubricPin(name="Testable", pass_condition="Pinned"), RubricPin(name="Mine", pass_condition="Own")], removed=["Unambiguity"])
    view = rubric_view(apply_overrides(base(), overrides), base(), overrides)
    assert view["source"] == "kb" and view["builtAt"] == "2026-10-21T10:00:00+00:00"
    by_name = {c["name"]: c for c in view["categories"]}
    assert by_name["Testable"]["pinned"] is True and by_name["Testable"]["origin"] == "kb" and by_name["Testable"]["mergedFrom"] == ["Testable", "Testability"]
    assert by_name["Essential"]["pinned"] is False and by_name["Mine"]["origin"] == "custom" and by_name["Mine"]["pinned"] is True
    assert view["removed"] == ["Unambiguity"] and "Unambiguity" not in by_name
    assert view["version"] == apply_overrides(base(), overrides).version


def test_the_built_in_rubric_can_be_pinned_and_trimmed_too() -> None:
    overrides = RubricOverrides(pinned=[RubricPin(name="Singular", pass_condition="Exactly one 'shall' per statement")], removed=["Traceable"])
    effective = apply_overrides(default_profile(), overrides)
    assert "Traceable" not in names(effective) and effective.source == "default"
    assert next(c for c in effective.categories if c.name == "Singular").pass_condition == "Exactly one 'shall' per statement"
    assert next(c for c in effective.categories if c.name == "Singular").guidance  # the built-in guidance stays


@pytest.mark.parametrize(
    "pinned, removed, message",
    [
        ([{"name": "A", "pass_condition": "x"}, {"name": " a ", "pass_condition": "y"}], [], "twice"),
        ([{"name": "", "pass_condition": "x"}], [], "name"),
        ([{"name": "A", "pass_condition": "  "}], [], "pass condition"),
        ([{"name": "A" * 81, "pass_condition": "x"}], [], "name"),
        ([{"name": "A", "pass_condition": "x" * 601}], [], "pass condition"),
        ([{"name": f"N{i}", "pass_condition": "x"} for i in range(21)], [], "at most"),
        ([], [f"R{i}" for i in range(31)], "at most"),
    ],
)
def test_a_pin_list_that_makes_no_sense_is_refused_with_a_reason(pinned, removed, message) -> None:
    with pytest.raises(ValueError) as error:
        validate_overrides(pinned, removed)
    assert message in str(error.value)


def test_a_valid_list_is_normalised() -> None:
    overrides = validate_overrides([{"name": "  Safety  relevant ", "pass_condition": " Names   the hazard "}], [" Essential "])
    assert overrides.pinned == [RubricPin(name="Safety relevant", pass_condition="Names the hazard")] and overrides.removed == ["Essential"]


@pytest.mark.parametrize("make_store", [lambda tmp: InMemoryProfileStore(), lambda tmp: ChromaProfileStore(KbVectorStore(str(tmp / "chroma")))])
def test_overrides_are_stored_per_user_and_survive_a_new_store_object(make_store, tmp_path) -> None:
    store = make_store(tmp_path)
    assert store.get_overrides("u1") == RubricOverrides()
    store.put_overrides("u1", RubricOverrides(pinned=[RubricPin(name="Testable", pass_condition="Pinned")], removed=["Essential"]))
    again = make_store(tmp_path) if isinstance(store, ChromaProfileStore) else store
    assert again.get_overrides("u1").pinned[0].name == "Testable" and again.get_overrides("u1").removed == ["Essential"]
    assert again.get_overrides("u2") == RubricOverrides()


@pytest.fixture
def api(monkeypatch):
    store = InMemoryProfileStore()
    store.put("u1", base())
    monkeypatch.setattr(main, "_kb_profile_store", store)
    monkeypatch.setattr(main.settings, "kb_profile_scoring", True)
    monkeypatch.setattr(main, "_make_profile_client", lambda model: object())
    monkeypatch.setattr(main, "ensure_profile", lambda user_id, *a, **k: store.get(user_id))
    return store


def test_get_shows_the_users_rubric_and_a_user_without_a_kb_sees_the_built_in_one(api) -> None:
    mine = client.get("/kb/rubric", params={"user_id": "u1"}).json()
    assert mine["source"] == "kb" and [c["name"] for c in mine["categories"]] == ["Testable", "Unambiguity", "Essential"]
    other = client.get("/kb/rubric", params={"user_id": "nobody"}).json()
    assert other["source"] == "default" and len(other["categories"]) == 8 and other["categories"][0]["guidance"]


def test_put_pins_edits_and_removes_and_the_next_job_is_scored_with_the_result(api) -> None:
    response = client.put("/kb/rubric", json={
        "user_id": "u1", "pinned": [{"name": "Testable", "passCondition": "Pinned condition"}, {"name": "Safety-relevant", "passCondition": "Names the hazard"}], "removed": ["Unambiguity"],
    })
    assert response.status_code == 200, response.text
    view = response.json()
    assert [c["name"] for c in view["categories"]] == ["Testable", "Essential", "Safety-relevant"]
    assert client.get("/kb/rubric", params={"user_id": "u1"}).json() == view

    scored_with = main._profile_for_job("u1", "m1")
    assert names(scored_with) == ["Testable", "Essential", "Safety-relevant"]
    assert scored_with.categories[0].pass_condition == "Pinned condition" and scored_with.version == view["version"]


def test_the_cache_scope_follows_the_rubric_so_a_pin_never_serves_an_old_result(api) -> None:
    before = client.get("/cache-scope", params={"user_id": "u1"}).json()["profile"]
    client.put("/kb/rubric", json={"user_id": "u1", "pinned": [{"name": "Testable", "passCondition": "Changed"}], "removed": []})
    after = client.get("/cache-scope", params={"user_id": "u1"}).json()["profile"]
    assert before == "v-base" and after != before
    client.put("/kb/rubric", json={"user_id": "u1", "pinned": [], "removed": []})  # resetting returns to the model's own rubric
    assert client.get("/cache-scope", params={"user_id": "u1"}).json()["profile"] == "v-base"


def test_a_user_cannot_see_or_change_another_users_pins(api) -> None:
    client.put("/kb/rubric", json={"user_id": "u1", "pinned": [{"name": "Testable", "passCondition": "Only mine"}], "removed": []})
    assert main._stored_profile_or_none("u2").source == "default"
    assert all(c.pass_condition != "Only mine" for c in main._stored_profile_or_none("u2").categories)


def test_put_refuses_nonsense_with_a_400_and_changes_nothing(api) -> None:
    response = client.put("/kb/rubric", json={"user_id": "u1", "pinned": [{"name": "", "passCondition": "x"}], "removed": []})
    assert response.status_code == 400 and "name" in response.json()["detail"]
    assert client.get("/kb/rubric", params={"user_id": "u1"}).json()["version"] == "v-base"


def test_the_chat_and_the_rescore_see_the_pinned_rubric(api) -> None:
    client.put("/kb/rubric", json={"user_id": "u1", "pinned": [{"name": "Testable", "passCondition": "Pinned condition"}], "removed": []})
    stored = main._stored_profile_or_none("u1")
    assert next(c for c in stored.categories if c.name == "Testable").pass_condition == "Pinned condition"
