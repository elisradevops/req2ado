"""Defects an independent review found in the rubric work, each pinned by a scenario that failed before the fix."""
import pytest
from fastapi.testclient import TestClient

from app import main
from app.kb.default_rubric import DEFAULT_RUBRIC_VERSION, default_profile
from app.kb.profile import Category, InMemoryProfileStore, KbProfile
from app.kb.rubric import RubricOverrides, RubricPin, apply_overrides, rubric_view
from app.request_identity import USER_ID_HEADER

client = TestClient(main.app)


def kb_profile() -> KbProfile:
    return KbProfile(
        version="v-base", built_with="m1",
        categories=[
            Category(name="Testable", pass_condition="Can be verified", sources=["A.pptx", "B.pptx"], merged_from=["Testable", "Testability"]),
            Category(name="Clarity", pass_condition="One reading only", sources=["A.pptx"], merged_from=["Clarity"]),
        ],
    )


@pytest.fixture
def env(monkeypatch):
    store = InMemoryProfileStore()
    store.put("u1", kb_profile())
    monkeypatch.setattr(main, "_kb_profile_store", store)
    monkeypatch.setattr(main.settings, "kb_profile_scoring", True)
    monkeypatch.setattr(main, "_make_profile_client", lambda model: object())
    return store


# 1. a build that raises must not silently drop the user's stored KB rubric and pins
def test_a_failing_build_scores_with_the_users_stored_rubric_and_pins_not_the_default(env, monkeypatch) -> None:
    env.put_overrides("u1", RubricOverrides(pinned=[RubricPin(name="Testable", pass_condition="MY PIN")]))

    def boom(*args, **kwargs):
        raise RuntimeError("chroma down")

    monkeypatch.setattr(main, "ensure_profile", boom)
    used = main._profile_for_job("u1", "m1")
    assert used.source == "kb" and next(c for c in used.categories if c.name == "Testable").pass_condition == "MY PIN"
    assert used.version == main._stored_profile_or_none("u1").version  # the same rubric the cache scope names
    assert used.degraded is True  # and it says the job did not get the build it wanted


def test_a_failing_build_with_nothing_stored_is_the_default_and_degraded(monkeypatch) -> None:
    monkeypatch.setattr(main, "_kb_profile_store", InMemoryProfileStore())
    monkeypatch.setattr(main.settings, "kb_profile_scoring", True)
    monkeypatch.setattr(main, "_make_profile_client", lambda model: object())
    monkeypatch.setattr(main, "ensure_profile", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("down")))
    used = main._profile_for_job("u1", "m1")
    assert used.source == "default" and used.degraded is True


def test_a_user_with_no_knowledge_base_is_not_degraded(monkeypatch) -> None:
    monkeypatch.setattr(main, "_kb_profile_store", InMemoryProfileStore())
    monkeypatch.setattr(main.settings, "kb_profile_scoring", True)
    monkeypatch.setattr(main, "_make_profile_client", lambda model: object())
    monkeypatch.setattr(main, "ensure_profile", lambda *a, **k: None)
    assert main._profile_for_job("u1", "m1").degraded is False


def test_a_rebuild_that_came_back_incomplete_keeps_the_last_good_profile_and_says_degraded(env, monkeypatch) -> None:
    half = KbProfile(version="v-half", built_with="m1", categories=[Category(name="Half", sources=["A"], merged_from=["Half"])], degraded=True)
    monkeypatch.setattr(main, "ensure_profile", lambda *a, **k: half)
    used = main._profile_for_job("u1", "m1")
    assert [c.name for c in used.categories] == ["Testable", "Clarity"] and used.degraded is True


# 2. /level says which rubric the job was scored with (and whether it was degraded)
def test_level_reports_the_rubric_version_the_job_was_scored_with(env, monkeypatch) -> None:
    from unittest.mock import patch

    from app.workitem.model import WorkItemTree
    from tests.test_request_identity import _doc

    def fake_build(doc, client, user_id, catalog, job_id, model=None, primer_context=None, rubric_report=None):
        used = main._profile_for_job(user_id, model)
        rubric_report["version"], rubric_report["degraded"] = used.version, used.degraded
        return WorkItemTree(nodes=[], warnings=[])

    monkeypatch.setattr(main, "ensure_profile", lambda user_id, *a, **k: env.get(user_id))
    with patch("app.main._build_survey_tree_with_scoring", side_effect=fake_build):
        response = client.post("/level?mode=survey&job_id=j1", content=_doc().model_dump_json(), headers={"Content-Type": "application/json", USER_ID_HEADER: "u1"})
    assert response.status_code == 200
    assert response.headers["x-req2ado-rubric-version"] == "v-base"
    assert "x-req2ado-rubric-degraded" not in response.headers


def test_level_flags_a_degraded_rubric(env, monkeypatch) -> None:
    from unittest.mock import patch

    from app.workitem.model import WorkItemTree
    from tests.test_request_identity import _doc

    def fake_build(doc, client, user_id, catalog, job_id, model=None, primer_context=None, rubric_report=None):
        rubric_report["version"], rubric_report["degraded"] = "v-old", True
        return WorkItemTree(nodes=[], warnings=[])

    with patch("app.main._build_survey_tree_with_scoring", side_effect=fake_build):
        response = client.post("/level?mode=survey&job_id=j1", content=_doc().model_dump_json(), headers={"Content-Type": "application/json", USER_ID_HEADER: "u1"})
    assert response.headers["x-req2ado-rubric-version"] == "v-old" and response.headers["x-req2ado-rubric-degraded"] == "1"


# 3. a rubric cannot be emptied, and the view shows what jobs are graded with
def test_a_pin_list_that_would_leave_no_category_is_refused(env) -> None:
    response = client.put("/kb/rubric", json={"user_id": "u1", "pinned": [], "removed": ["Testable", "Clarity"]})
    assert response.status_code == 400 and "at least one category" in response.json()["detail"]
    assert client.get("/kb/rubric", params={"user_id": "u1"}).json()["version"] == "v-base"  # nothing stored


def test_removing_all_but_the_last_is_fine_and_the_view_matches_what_jobs_use(env, monkeypatch) -> None:
    assert client.put("/kb/rubric", json={"user_id": "u1", "pinned": [], "removed": ["Clarity"]}).status_code == 200
    view = client.get("/kb/rubric", params={"user_id": "u1"}).json()
    assert [c["name"] for c in view["categories"]] == ["Testable"]
    assert view["version"] == main._stored_profile_or_none("u1").version


def test_a_stored_removal_that_would_now_empty_the_rubric_shows_what_jobs_really_use(env) -> None:
    env.put_overrides("u1", RubricOverrides(removed=["Testable", "Clarity"]))  # stored when the base was different
    view = client.get("/kb/rubric", params={"user_id": "u1"}).json()
    effective = main._stored_profile_or_none("u1")
    assert view["version"] == effective.version == DEFAULT_RUBRIC_VERSION and len(view["categories"]) == len(effective.categories)


# 4. the user id travels in a header, not in the URL
def test_the_rubric_and_the_cache_scope_read_the_user_from_the_header(env) -> None:
    assert client.get("/kb/rubric", headers={USER_ID_HEADER: "u1"}).json()["source"] == "kb"
    assert client.get("/cache-scope", headers={USER_ID_HEADER: "u1"}).json()["profile"] == "v-base"
    assert client.get("/kb/rubric", params={"user_id": "u1"}).json()["source"] == "kb"  # the old form still works for one release
    assert client.get("/kb/rubric").status_code == 400  # but no user at all is refused, not guessed


# 5. a pin matches the exact name first
def test_a_pin_named_exactly_like_a_category_wins_over_a_pin_named_like_a_merged_wording() -> None:
    effective = apply_overrides(kb_profile(), RubricOverrides(pinned=[RubricPin(name="Testable", pass_condition="edited"), RubricPin(name="Testability", pass_condition="mine")]))
    by_name = {c.name: c for c in effective.categories}
    assert by_name["Testable"].pass_condition == "edited" and by_name["Testable"].sources == ["A.pptx", "B.pptx"]  # still the KB category
    assert by_name["Testability"].pass_condition == "mine" and by_name["Testability"].sources == ["(pinned)"]  # the user's own, separate
    assert len(effective.categories) == 3


def test_a_pin_never_replaces_two_categories() -> None:
    base = KbProfile(version="v", built_with="m", categories=[
        Category(name="A", pass_condition="a", sources=["x"], merged_from=["A", "Shared"]),
        Category(name="B", pass_condition="b", sources=["x"], merged_from=["B", "Shared"]),
    ])
    effective = apply_overrides(base, RubricOverrides(pinned=[RubricPin(name="Shared", pass_condition="pinned")]))
    assert len(effective.categories) == 2
    assert [c.pass_condition for c in effective.categories].count("pinned") == 1  # one category took the pin, the other kept its own text


# 6. the view carries the derived text so an unpin can hand it back
def test_the_view_gives_the_derived_pass_condition_next_to_a_pinned_one() -> None:
    overrides = RubricOverrides(pinned=[RubricPin(name="Testable", pass_condition="Pinned text"), RubricPin(name="Mine", pass_condition="Own")])
    view = rubric_view(apply_overrides(kb_profile(), overrides), kb_profile(), overrides)
    by_name = {c["name"]: c for c in view["categories"]}
    assert by_name["Testable"]["passCondition"] == "Pinned text" and by_name["Testable"]["basePassCondition"] == "Can be verified"
    assert by_name["Clarity"]["basePassCondition"] == "One reading only"
    assert by_name["Mine"]["basePassCondition"] is None


# 9. the build version of ingestion is only a cache key when it is known
def test_an_unknown_ingestion_build_is_not_a_cache_key(monkeypatch) -> None:
    monkeypatch.setattr(main, "_ingestion_version", lambda: None)
    monkeypatch.setattr(main, "_stored_profile_or_none", lambda user_id: default_profile())
    assert client.get("/cache-scope", headers={USER_ID_HEADER: "u1"}).json()["ingestion"] is None
