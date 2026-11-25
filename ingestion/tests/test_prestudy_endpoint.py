"""The /prestudy route and a stored rulebook on /level: learn or check how a file states its structure, then build from exactly that rulebook."""

from __future__ import annotations

import copy
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app import job_cancel
from app.dispatch import dispatch_by_extension
from app.leveling.rule_builder import (
    verify_tree_against_rules,  # noqa: F401 -- imported so a rename shows up here
)
from app.main import app
from app.study.model_rules import prestudy, prestudy_version
from app.study.rulebook import FileRulebook, RuleSpec, rulebook_from_json, rulebook_to_json

from .accuracy.fake_model import FakeStudyClient
from .accuracy.scorecard import score
from .accuracy.variants import build_xlsx_hebrew, build_xlsx_kind_parent

client = TestClient(app)


@pytest.fixture(scope="module")
def hebrew_doc(tmp_path_factory):
    path = build_xlsx_hebrew(tmp_path_factory.mktemp("hebrew"))
    return dispatch_by_extension(path.name, str(path))


@pytest.fixture(scope="module")
def kind_doc(tmp_path_factory):
    path = build_xlsx_kind_parent(tmp_path_factory.mktemp("kind"))
    return dispatch_by_extension(path.name, str(path))


async def _fake_client(model, user_id):  # noqa: ANN001, ANN201
    return FakeStudyClient()


# --- the JSON form -----------------------------------------------------------------------------------------------------------------------------


def test_a_rulebook_survives_its_json_form_with_the_same_hash(hebrew_doc) -> None:
    rulebook, _ = prestudy(hebrew_doc, FakeStudyClient(), votes=3)
    again = rulebook_from_json(rulebook_to_json(rulebook))
    assert again.hash == rulebook.hash and again.tables.keys() == rulebook.tables.keys()


def test_the_hash_in_the_json_is_never_trusted(hebrew_doc) -> None:
    rulebook, _ = prestudy(hebrew_doc, FakeStudyClient(), votes=3)
    raw = rulebook_to_json(rulebook)
    raw["hash"] = "0" * 64
    assert rulebook_from_json(raw).hash == rulebook.hash


@pytest.mark.parametrize(
    "change",
    [
        lambda r: r["tables"]["t0"].update(nesting="sideways"),
        lambda r: r["tables"]["t0"].update(header_row=-1),
        lambda r: r["tables"]["t0"].update(title_col="two"),
        lambda r: r["tables"]["t0"].update(type_map={"x": "Story"}),
        lambda r: r.update(version=99),
        lambda r: r.update(document={"labels": [{"label": "x", "separator": "?", "type": "Epic"}], "depth_types": []}),
    ],
)
def test_json_that_is_not_a_rulebook_is_refused(change, hebrew_doc) -> None:
    rulebook, _ = prestudy(hebrew_doc, FakeStudyClient(), votes=3)
    raw = copy.deepcopy(rulebook_to_json(rulebook))
    change(raw)
    with pytest.raises(ValueError):
        rulebook_from_json(raw)


# --- /prestudy ---------------------------------------------------------------------------------------------------------------------------------


def test_prestudy_learns_a_rulebook_the_model_stands_behind(hebrew_doc) -> None:
    with patch("app.main._survey_client", _fake_client):
        response = client.post("/prestudy", json={"doc": hebrew_doc.model_dump(mode="json")})
    assert response.status_code == 200
    body = response.json()
    assert body["source"] == "model" and body["version"] == prestudy_version()
    assert body["hash"] == rulebook_from_json(body["rulebook"]).hash
    assert any("סוג פריט" in line for line in body["rules"])
    assert [w["kind"] for w in body["warnings"]] == ["prestudy_applied"]


def test_prestudy_says_none_when_the_model_cannot_be_used(hebrew_doc) -> None:
    async def failing(model, user_id):  # noqa: ANN001, ANN201
        return FakeStudyClient(fail=RuntimeError("down"))

    with patch("app.main._survey_client", failing):
        response = client.post("/prestudy", json={"doc": hebrew_doc.model_dump(mode="json")})
    body = response.json()
    assert response.status_code == 200 and body["source"] == "none" and body["rulebook"]["tables"] == {}
    assert [w["kind"] for w in body["warnings"]] == ["prestudy_rejected"]


def test_prestudy_attaches_the_uploaded_file_to_the_models_calls(hebrew_doc) -> None:
    seen: list[str | None] = []

    class Recording(FakeStudyClient):
        study_file_id = None

        def study_file_rules_table(self, sample, user_id=None, vote=0, accept=None):  # noqa: ANN001, ANN201
            seen.append(self.study_file_id)
            return super().study_file_rules_table(sample, user_id, vote, accept)

    async def recording(model, user_id):  # noqa: ANN001, ANN201
        return Recording()

    with patch("app.main._survey_client", recording):
        client.post(
            "/prestudy", json={"doc": hebrew_doc.model_dump(mode="json")}, headers={"X-Req2Ado-File-Id": "file-123"}
        )
    assert seen == ["file-123"] * 3


def test_reading_again_asks_the_model_afresh(hebrew_doc) -> None:
    seen: list[bool] = []

    class Recording(FakeStudyClient):
        study_fresh = False

        def study_file_rules_table(self, sample, user_id=None, vote=0, accept=None):  # noqa: ANN001, ANN201
            seen.append(self.study_fresh)
            return super().study_file_rules_table(sample, user_id, vote, accept)

    async def recording(model, user_id):  # noqa: ANN001, ANN201
        return Recording()

    with patch("app.main._survey_client", recording):
        client.post("/prestudy", json={"doc": hebrew_doc.model_dump(mode="json")})
        client.post("/prestudy", json={"doc": hebrew_doc.model_dump(mode="json"), "fresh": True})
    assert seen == [False] * 3 + [True] * 3


class _Cancelling(FakeStudyClient):
    """Honours the run's cancel token like the real client (a check before every model call), and cancels it during the first vote: what the
    wizard's Stop waiting or a changed file does to the request."""

    def study_file_rules_table(self, sample, user_id=None, vote=0, accept=None):  # noqa: ANN001, ANN201
        job_cancel.raise_if_cancelled()
        answer = super().study_file_rules_table(sample, user_id, vote, accept)
        job_cancel.current_token().cancel()
        return answer


def test_a_study_whose_caller_went_away_asks_no_further_vote_and_returns_nothing(hebrew_doc, monkeypatch) -> None:
    from app.study import model_rules

    monkeypatch.setattr(model_rules.settings, "prestudy_vote_concurrency", 1)
    study = _Cancelling()

    async def cancelling(model, user_id):  # noqa: ANN001, ANN201
        return study

    with patch("app.main._survey_client", cancelling):
        response = client.post("/prestudy", json={"doc": hebrew_doc.model_dump(mode="json")})
    assert response.status_code == 499 and "rulebook" not in response.json()
    assert study.calls == [("table", 0)]  # the vote in flight finished; votes 1 and 2 were never asked
    with patch("app.main._survey_client", _fake_client):
        assert client.post("/prestudy", json={"doc": hebrew_doc.model_dump(mode="json")}).status_code == 200  # the next study is unaffected


def test_a_disconnected_caller_cancels_the_study(hebrew_doc) -> None:
    async def gone(self) -> bool:  # noqa: ANN001
        return True

    with patch("app.main._survey_client", _fake_client), patch("starlette.requests.Request.is_disconnected", gone):
        response = client.post("/prestudy", json={"doc": hebrew_doc.model_dump(mode="json")})
    assert response.status_code == 499


def test_checking_a_users_edit_is_not_tied_to_the_caller(hebrew_doc) -> None:
    """No model is asked for an edit, so there is nothing to cancel: the check answers as before."""
    learned, _ = prestudy(hebrew_doc, FakeStudyClient(), votes=3)

    async def gone(self) -> bool:  # noqa: ANN001
        return True

    with patch("starlette.requests.Request.is_disconnected", gone):
        response = client.post("/prestudy", json={"doc": hebrew_doc.model_dump(mode="json"), "rulebook": rulebook_to_json(learned)})
    assert response.status_code == 200 and response.json()["source"] == "user"


def test_a_users_edit_is_checked_against_the_file_and_returned_as_theirs(hebrew_doc) -> None:
    learned, _ = prestudy(hebrew_doc, FakeStudyClient(), votes=3)
    raw = rulebook_to_json(learned)
    raw["tables"]["t0"]["type_map"]["באג"] = "Requirement"  # the user wants the bugs imported as Requirements
    response = client.post("/prestudy", json={"doc": hebrew_doc.model_dump(mode="json"), "rulebook": raw})
    body = response.json()
    assert response.status_code == 200 and body["source"] == "user"
    assert body["hash"] != learned.hash
    assert body["rulebook"]["tables"]["t0"]["origin"] == "user"


@pytest.mark.parametrize(
    "change",
    [
        lambda r: r["tables"]["t0"].update(title_col=99),
        lambda r: r["tables"].update(t7=r["tables"]["t0"]),
        lambda r: r["tables"]["t0"]["type_map"].update({k: "Requirement" for k in r["tables"]["t0"]["type_map"]}),
    ],
)
def test_an_edit_that_does_not_fit_the_file_is_refused_with_the_reason(change, hebrew_doc) -> None:
    learned, _ = prestudy(hebrew_doc, FakeStudyClient(), votes=3)
    raw = copy.deepcopy(rulebook_to_json(learned))
    change(raw)
    response = client.post("/prestudy", json={"doc": hebrew_doc.model_dump(mode="json"), "rulebook": raw})
    assert response.status_code == 422 and response.json()["detail"]


# --- a stored rulebook on /level ------------------------------------------------------------------------------------------------------------------


def _level(doc, rulebook: dict | None, mode: str = "baseline"):
    body = doc.model_dump(mode="json")
    body["rulebook"] = rulebook
    return client.post(f"/level?mode={mode}", json=body)


def test_level_builds_from_the_stored_rulebook(kind_doc) -> None:
    learned, _ = prestudy(kind_doc, FakeStudyClient(), votes=3)
    response = _level(kind_doc, rulebook_to_json(learned))
    assert response.status_code == 200
    tree = response.json()
    types = {t: sum(1 for n in tree["nodes"] if n["type"] == t) for t in ("Epic", "Feature", "Requirement")}
    assert types == {"Epic": 4, "Feature": 39, "Requirement": 235}
    assert not [w for w in tree["warnings"] if w["kind"] == "rulebook_mismatch"]


def test_level_without_a_rulebook_reads_only_what_the_code_recognises(kind_doc) -> None:
    tree = _level(kind_doc, None).json()
    assert len(tree["nodes"]) < 10  # the whole sheet is a few synthetic items: the file's own types were not read


def test_level_with_an_empty_rulebook_asks_no_one_and_reads_the_same_way(kind_doc) -> None:
    assert _level(kind_doc, {}).json()["nodes"] == _level(kind_doc, None).json()["nodes"]


def test_level_refuses_a_rulebook_that_does_not_parse(kind_doc) -> None:
    response = _level(kind_doc, {"version": 1, "tables": {"t0": {"nesting": "sideways"}}})
    assert response.status_code == 422 and "rulebook" in response.json()["detail"]


def test_the_stored_rulebook_is_checked_against_the_finished_tree(kind_doc) -> None:
    """A rulebook whose stated structure the builder cannot honour would be reported, not silently applied: build it, then break an item."""
    learned, _ = prestudy(kind_doc, FakeStudyClient(), votes=3)
    from app.leveling.rule_builder import verify_tree_against_rules as verify
    from app.leveling.tree_builder import build_baseline_tree
    from app.study.file_rules import study_tables

    tree = build_baseline_tree(kind_doc, learned)
    assert not score(tree, rich=False).problems()
    victim = next(n for n in tree.nodes if n.type.value == "Feature")
    victim.type = next(n for n in tree.nodes if n.type.value == "Requirement").type
    rules = {t: r for t, r in study_tables(kind_doc, learned).items() if t in learned.tables}
    assert [w.kind.value for w in verify(kind_doc, tree, rules)] == ["rulebook_mismatch"]


def _stale(learned: FileRulebook) -> dict:
    """A stored rulebook that parses and fits the grid, but that the document no longer passes (every value a Requirement): what a resubmit after an
    ingestion upgrade, or a study of a different parse, can send."""
    raw = rulebook_to_json(learned)
    raw["tables"]["t0"]["type_map"] = {"area": "Requirement", "group": "Requirement", "item": "Requirement", "check": None}
    return raw


def test_level_drops_a_stored_rulebook_the_document_no_longer_passes(kind_doc) -> None:
    learned, _ = prestudy(kind_doc, FakeStudyClient(), votes=3)
    response = _level(kind_doc, _stale(learned))
    assert response.status_code == 200
    tree = response.json()
    assert tree["nodes"] == _level(kind_doc, {}).json()["nodes"]  # built from the recognised conventions only
    rejected = [w for w in tree["warnings"] if w["kind"] == "prestudy_rejected"]
    assert len(rejected) == 1 and "Requirements" in rejected[0]["detail"]["reason"]


def test_level_keeps_a_stored_rulebook_that_still_fits(kind_doc) -> None:
    learned, _ = prestudy(kind_doc, FakeStudyClient(), votes=3)
    tree = _level(kind_doc, rulebook_to_json(learned)).json()
    assert not [w for w in tree["warnings"] if w["kind"] == "prestudy_rejected"]
    assert len(tree["nodes"]) > 200


@pytest.mark.parametrize("streamed", [False, True])
def test_survey_level_drops_a_stale_rulebook_too(kind_doc, monkeypatch, streamed: bool) -> None:
    import json

    from app.workitem.model import WorkItemTree

    learned, _ = prestudy(kind_doc, FakeStudyClient(), votes=3)
    seen: list = []

    def fake(doc, *args):  # noqa: ANN001, ANN002, ANN202
        seen.append(doc.rulebook)
        return WorkItemTree(nodes=[], warnings=[])

    monkeypatch.setattr("app.main._build_survey_tree_with_scoring", fake)
    monkeypatch.setattr("app.main._resolve_caps", lambda *a, **k: type("Caps", (), {"context_budget_tokens": 8000})())
    body = kind_doc.model_dump(mode="json")
    body["rulebook"] = _stale(learned)
    headers = {"Accept": "application/x-ndjson"} if streamed else {}
    response = client.post("/level?mode=survey&model=m", json=body, headers=headers)
    assert response.status_code == 200, response.text
    tree = [json.loads(line) for line in response.text.splitlines() if line.strip()][-1]["tree"] if streamed else response.json()
    assert seen and rulebook_from_json(seen[0]).is_empty()  # the run never saw it, and did not ask the model again either
    assert [w["kind"] for w in tree["warnings"]].count("prestudy_rejected") == 1


def test_an_empty_rulebook_object_is_a_rulebook() -> None:
    assert rulebook_from_json({}).is_empty() and isinstance(FileRulebook(), FileRulebook) and RuleSpec


def _unused(_: Path) -> None:  # keeps Path imported for type checkers reading fixtures above
    ...


# --- what a model changes when it "copies exactly" ----------------------------------------------------------------------------------------------


def test_fold_ignores_direction_marks_typographic_quotes_and_dashes() -> None:
    from app.study.rulebook import fold

    assert fold("‏מזהה‏") == fold("מזהה")
    assert fold("פיצ’ר") == fold("פיצ'ר") == fold("פיצ׳ר")
    assert fold("A – B") == fold("A - B") == fold("a  —  b")
    assert fold("Epic") != fold("Feature")


def test_a_model_that_wraps_hebrew_in_direction_marks_and_swaps_apostrophes_is_still_read(hebrew_doc) -> None:
    import copy

    from app.study.model_rules import validate_table_answer

    from .accuracy.fake_model import TABLE_ANSWERS

    answer = copy.deepcopy(TABLE_ANSWERS[("מזהה", "סוג פריט", "כותרת", "תיאור", "עדיפות")])
    for column in answer["columns"]:
        column["header"] = "‏" + column["header"] + "‏"
    for item in answer["type_values"]:
        item["value"] = item["value"].replace("'", "’")
    assert not isinstance(validate_table_answer(answer, hebrew_doc.tables[0]), str)


def test_a_refusal_for_a_wrong_heading_shows_both_headings(hebrew_doc) -> None:
    import copy

    from app.study.model_rules import validate_table_answer

    from .accuracy.fake_model import TABLE_ANSWERS

    answer = copy.deepcopy(TABLE_ANSWERS[("מזהה", "סוג פריט", "כותרת", "תיאור", "עדיפות")])
    answer["columns"][0]["header"] = "Identifier"
    reason = validate_table_answer(answer, hebrew_doc.tables[0])
    assert isinstance(reason, str) and "('Identifier')" in reason and "('מזהה')" in reason


def test_a_model_that_adds_an_english_gloss_to_hebrew_headings_and_values_is_still_read(hebrew_doc) -> None:
    """Seen live: the model returned the heading of column 0 as 'ID (מזהה)'. The column number is what the rules use, so a gloss around the real text is
    the right column; the type map is built from the file's own values, not from the model's spellings."""
    import copy

    from app.study.model_rules import validate_table_answer

    from .accuracy.fake_model import TABLE_ANSWERS

    answer = copy.deepcopy(TABLE_ANSWERS[("מזהה", "סוג פריט", "כותרת", "תיאור", "עדיפות")])
    glosses = {"מזהה": "ID (מזהה)", "סוג פריט": "Item type (סוג פריט)", "כותרת": "Title (כותרת)", "תיאור": "Description (תיאור)", "עדיפות": "Priority (עדיפות)"}
    for column in answer["columns"]:
        column["header"] = glosses[column["header"]]
    for item in answer["type_values"]:
        item["value"] = {"אפיק": "אפיק (Epic)", "דרישה": "דרישה (Requirement)", "באג": "באג (Bug)"}.get(item["value"], item["value"])
    spec = validate_table_answer(answer, hebrew_doc.tables[0])
    assert not isinstance(spec, str), spec
    assert set(spec.type_map) == {"אפיק", "פיצ'ר", "דרישה", "באג"}  # the file's own values
    assert spec.type_map["אפיק"] == "Epic" and spec.type_map["באג"] is None


def test_a_heading_that_does_not_contain_the_real_one_is_still_a_different_column(hebrew_doc) -> None:
    import copy

    from app.study.model_rules import validate_table_answer

    from .accuracy.fake_model import TABLE_ANSWERS

    answer = copy.deepcopy(TABLE_ANSWERS[("מזהה", "סוג פריט", "כותרת", "תיאור", "עדיפות")])
    answer["columns"][0]["header"] = "Item type (סוג פריט)"  # the heading of column 1, given for column 0
    assert isinstance(validate_table_answer(answer, hebrew_doc.tables[0]), str)


def test_a_heading_that_merely_contains_the_real_one_is_refused() -> None:
    """Review finding: for headings Kind | Name | Full Name, 'Full Name' given for column 1 (Name) contains 'Name' but is another column; every item
    would get the short code as its title."""
    from app.canonical.model import SourceRef, Table, TableCell
    from app.study.model_rules import validate_table_answer

    rows = [["Kind", "Name", "Full Name", "Notes"]]
    kinds = (["Group"] + ["Sub", "Item", "Item"] * 3) * 2
    rows += [[k, f"C{i}", f"The long title of row {i}", ""] for i, k in enumerate(kinds)]
    table = Table(
        id="t0",
        cells=[[TableCell(text=c) for c in r] for r in rows],
        source_ref=SourceRef(document_path="x.xlsx", start_offset=0, end_offset=0),
    )
    answer = {
        "sheet_kind": "work_items",
        "header_row": 0,
        "nesting": "row_order",
        "columns": [{"column": 0, "role": "type", "header": "Kind"}, {"column": 1, "role": "title", "header": "Full Name"}],
        "type_values": [
            {"value": "Group", "maps_to": "Epic"},
            {"value": "Sub", "maps_to": "Feature"},
            {"value": "Item", "maps_to": "Requirement"},
        ],
    }
    assert isinstance(validate_table_answer(answer, table), str)
    answer["columns"][1] = {"column": 2, "role": "title", "header": "Full Name"}
    assert not isinstance(validate_table_answer(answer, table), str)
    # A gloss that wraps another column's heading is that column, not this one.
    answer["columns"][1] = {"column": 1, "role": "title", "header": "Title (Full Name)"}
    assert isinstance(validate_table_answer(answer, table), str)
    answer["columns"][1] = {"column": 1, "role": "title", "header": "Short code (Name)"}
    assert not isinstance(validate_table_answer(answer, table), str)


def test_a_heading_given_with_a_leading_or_bracketed_gloss_is_the_column(hebrew_doc) -> None:
    import copy

    from app.study.model_rules import validate_table_answer

    from .accuracy.fake_model import TABLE_ANSWERS

    answer = copy.deepcopy(TABLE_ANSWERS[("מזהה", "סוג פריט", "כותרת", "תיאור", "עדיפות")])
    glosses = {"מזהה": "מזהה (ID)", "סוג פריט": "[Item type] סוג פריט", "כותרת": "כותרת [Title]", "תיאור": "Description（תיאור）", "עדיפות": "עדיפות"}
    for column in answer["columns"]:
        column["header"] = glosses[column["header"]]
    assert not isinstance(validate_table_answer(answer, hebrew_doc.tables[0]), str)


def test_a_value_that_two_glossed_entries_map_differently_is_refused(hebrew_doc) -> None:
    import copy

    from app.study.model_rules import validate_table_answer

    from .accuracy.fake_model import TABLE_ANSWERS

    answer = copy.deepcopy(TABLE_ANSWERS[("מזהה", "סוג פריט", "כותרת", "תיאור", "עדיפות")])
    answer["type_values"] = [item for item in answer["type_values"] if item["value"] != "דרישה"]
    answer["type_values"] += [
        {"value": "דרישה (Requirement)", "maps_to": "Requirement", "basis": "translation"},
        {"value": "דרישה (Epic?)", "maps_to": "Epic", "basis": "none"},
    ]
    assert "more than one way" in validate_table_answer(answer, hebrew_doc.tables[0])


def test_a_label_with_a_gloss_is_read_as_the_label() -> None:
    from app.study.model_rules import validate_document_answer

    headings = [
        {"i": i, "level": level, "depth": level - 1, "number": None, "text": text}
        for i, (level, text) in enumerate(
            [(1, "אפיק: א"), (2, "יכולת: ב"), (3, "דרישה: ג"), (3, "דרישה: ד"), (2, "יכולת: ה"), (3, "דרישה: ו"), (2, "יכולת: ז"), (3, "דרישה: ח")]
        )
    ]
    answer = {
        "type_source": "labels",
        "labels": [
            {"label": "יכולת (Feature)", "separator": ":", "maps_to": "Feature", "basis": "translation", "example_headings": [1]},
            {"label": "דרישה (Requirement)", "separator": ":", "maps_to": "Requirement", "basis": "translation", "example_headings": [2]},
        ],
        "depth_types": [],
        "evidence_headings": [1],
    }
    rules = validate_document_answer(answer, headings)
    assert not isinstance(rules, str) and {r.label for r in rules.labels} == {"יכולת", "דרישה"}


def test_a_refusal_for_a_table_the_model_called_something_else_says_what_it_answered(hebrew_doc) -> None:
    import copy

    from app.study.model_rules import validate_table_answer

    from .accuracy.fake_model import TABLE_ANSWERS

    answer = copy.deepcopy(TABLE_ANSWERS[("מזהה", "סוג פריט", "כותרת", "תיאור", "עדיפות")])
    answer["sheet_kind"] = "unknown"
    assert "(it answered 'unknown')" in validate_table_answer(answer, hebrew_doc.tables[0])


# --- what the rules make of the file (the wizard's breakdown) -----------------------------------------------------------------------------------


def test_prestudy_shows_the_counts_examples_and_rows_not_imported(hebrew_doc) -> None:
    with patch("app.main._survey_client", _fake_client):
        details = client.post("/prestudy", json={"doc": hebrew_doc.model_dump(mode="json")}).json()["details"]
    assert details["approximate"] is False and details["document"] is None
    [table] = details["tables"]
    assert table["typeCounts"] == {"Epic": 4, "Feature": 39, "Requirement": 235}
    assert all(len(rows) <= 3 for rows in table["samples"].values())
    assert table["samples"]["Epic"][0] == {"row": 2, "title": "Customer Software Requirements", "parent": None}
    assert table["samples"]["Feature"][0]["parent"] == "Customer Software Requirements"
    grid = hebrew_doc.tables[0].cells
    for sample in table["samples"]["Requirement"]:  # the row number is the sheet's: heading row = 1
        assert grid[sample["row"] - 1][2].text == sample["title"] and grid[sample["row"] - 1][1].text == "דרישה"
    skipped = table["skipped"]
    assert skipped["count"] == 68 and skipped["byReason"] == {"type:באג": 68}
    assert len(skipped["rows"]) == 20 and skipped["more"] == 48
    first = skipped["rows"][0]
    assert first["reason"] == "type:באג" and grid[first["row"] - 1][1].text == "באג" and grid[first["row"] - 1][2].text == first["text"]


def test_a_users_edit_comes_back_with_the_breakdown_it_gives(hebrew_doc) -> None:
    learned, _ = prestudy(hebrew_doc, FakeStudyClient(), votes=3)
    raw = rulebook_to_json(learned)
    raw["tables"]["t0"]["type_map"]["באג"] = "Requirement"
    details = client.post("/prestudy", json={"doc": hebrew_doc.model_dump(mode="json"), "rulebook": raw}).json()["details"]
    [table] = details["tables"]
    assert table["typeCounts"]["Requirement"] == 235 + 68 and table["skipped"]["count"] == 0 and table["skipped"]["rows"] == []


def test_a_table_read_by_its_recognised_headings_has_a_breakdown_too(tmp_path) -> None:
    from .accuracy.variants import build_csv

    path = build_csv(tmp_path)
    doc = dispatch_by_extension(path.name, str(path))
    response = client.post("/prestudy", json={"doc": doc.model_dump(mode="json"), "rulebook": {}})
    body = response.json()
    assert response.status_code == 200 and "(recognised headings)" in body["rules"][0]
    [table] = body["details"]["tables"]
    assert table["typeCounts"] == {"Epic": 4, "Feature": 39, "Requirement": 235} and table["skipped"]["byReason"] == {"type:Test Case": 68}


def test_a_documents_breakdown_is_approximate_and_lists_nothing_as_not_imported(tmp_path) -> None:
    from .accuracy.variants import build_docx_hebrew_labels

    path = build_docx_hebrew_labels(tmp_path)
    doc = dispatch_by_extension(path.name, str(path))
    with patch("app.main._survey_client", _fake_client):
        details = client.post("/prestudy", json={"doc": doc.model_dump(mode="json")}).json()["details"]
    assert details["approximate"] is True and details["tables"] == []
    document = details["document"]
    assert document["approximate"] is True and "skipped" not in document
    assert document["typeCounts"] == {"Epic": 4, "Feature": 39, "Requirement": 235}
    assert document["samples"]["Feature"][0]["parent"].startswith("אפיק:")


def test_a_file_the_rules_say_nothing_about_has_no_breakdown(hebrew_doc) -> None:
    async def failing(model, user_id):  # noqa: ANN001, ANN201
        return FakeStudyClient(fail=RuntimeError("down"))

    with patch("app.main._survey_client", failing):
        assert client.post("/prestudy", json={"doc": hebrew_doc.model_dump(mode="json")}).json()["details"] is None


def test_the_breakdown_is_not_part_of_how_a_file_is_studied(hebrew_doc) -> None:
    """Showing more of the rules must not make every stored rulebook stale (a paid re-study of every file)."""
    import inspect

    from app.study import model_rules

    source = inspect.getsource(model_rules.prestudy_version)
    # "4": the pre-study also learns front matter; "5": it also learns the document grammar; "6": it also learns the document profile
    # (each a deliberate re-study of stored model rulebooks).
    assert "details" not in source and model_rules._CODE_PASS_VERSION == "6"


def test_a_reading_for_a_job_names_the_step_on_the_jobs_live_screen(hebrew_doc) -> None:
    published: list = []

    class _Publisher:
        def __init__(self, _redis, job_id):  # noqa: ANN001
            self.job_id = job_id

        def publish(self, progress) -> None:  # noqa: ANN001
            published.append((self.job_id, progress.phase))

    with patch("app.main._survey_client", _fake_client), patch("app.main.NarrationPublisher", _Publisher):
        client.post("/prestudy?job_id=job-7", json={"doc": hebrew_doc.model_dump(mode="json")})
        client.post("/prestudy", json={"doc": hebrew_doc.model_dump(mode="json")})
    assert published == [("job-7", "learn_layout")]  # the wizard's reading (no job) publishes nothing
