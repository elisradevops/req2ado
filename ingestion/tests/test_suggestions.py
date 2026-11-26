"""With AI review's suggestions (app.leveling.suggestions) on the TV twin: offered beside the document's words, never applied, and only
when code finds them safe -- a summary only for an Epic or Feature with no text of its own, a wording change only for a weak requirement."""

from __future__ import annotations

import sys
from functools import cache
from pathlib import Path

import pytest

from app.leveling import suggestions
from app.leveling.suggestions import checked_rewrite, write_suggestions
from app.leveling.tree_builder import build_baseline_tree
from app.loaders.pdf_loader import load_pdf
from app.study.rulebook import DocumentRules, FileRulebook

sys.path.insert(0, str(Path(__file__).parent / "fixtures" / "tv_twin"))
from build_tv_twin_pdf import build_twin_spec_pdf  # noqa: E402


@pytest.fixture(scope="module")
def tv_path(tmp_path_factory) -> str:
    return str(build_twin_spec_pdf(tmp_path_factory.mktemp("suggestions"))[0])


@cache
def _doc(path: str):
    return load_pdf(path)


def _tree(path: str):
    rules = DocumentRules(requirement_codes=("aud_1", "btn_2", "men_3", "tun_1"), empty_treatment="leave_out")
    return build_baseline_tree(_doc(path), FileRulebook(document=rules))


class _Client:
    """Summarises an item from its first requirement's own words; rewrites a requirement as the test says."""

    def __init__(self, rewrite=None, fail_first: bool = False) -> None:  # noqa: ANN001
        self.rewrite = rewrite or (lambda text: text.replace("The ", "Each ", 1))
        self.fail_first, self.summarised, self.rewritten = fail_first, [], []

    def summarize_parent_nodes(self, nodes_by_id: dict, user_id: str | None = None) -> dict:
        if self.fail_first and not self.summarised:
            self.summarised.append(None)
            raise RuntimeError("unreachable")
        self.summarised += list(nodes_by_id)
        return {k: {"title": v["title"], "description": v["requirement_descriptions"][0]} for k, v in nodes_by_id.items()}

    def synthesize_leaf_requirements(self, items_by_id: dict, user_id: str | None = None) -> dict:
        self.rewritten += list(items_by_id)
        return {k: {"title": "x", "text": self.rewrite(v["text"]), "tags": []} for k, v in items_by_id.items()}


def test_a_summary_is_offered_only_for_an_epic_or_feature_with_no_text_of_its_own(tv_path: str) -> None:
    tree = _tree(tv_path)
    descriptions = {n.local_id: n.description for n in tree.nodes}
    client = _Client()
    summaries, rewrites = write_suggestions(tree.nodes, client, [])
    by_id = {n.local_id: n for n in tree.nodes}
    asked = {by_id[i].title for i in client.summarised}
    assert "Requirements" not in asked  # the top Epic has the context chapter's text
    assert {"Audio", "Remote control", "Tuner and reception"} <= asked
    assert summaries == len(client.summarised) and rewrites == 0  # no requirement is scored weak yet
    assert all(n.description == descriptions[n.local_id] for n in tree.nodes)  # never applied
    assert by_id[client.summarised[0]].description_suggestion


def test_a_wording_change_is_offered_only_for_a_weak_requirement_and_keeps_its_trace(tv_path: str) -> None:
    tree = _tree(tv_path)
    by_cid = {n.customer_id: n for n in tree.nodes if n.customer_id}
    by_cid["tun_1"].quality_score = 30
    by_cid["aud_1"].quality_score = 90
    original = by_cid["tun_1"].description
    client = _Client()
    _summaries, rewrites = write_suggestions(tree.nodes, client, [])
    assert rewrites == 1 and client.rewritten == [by_cid["tun_1"].local_id]
    statement, trace = original.split("\n\n", 1)
    assert by_cid["tun_1"].description == original
    assert by_cid["tun_1"].description_suggestion == statement.replace("The ", "Each ", 1) + "\n\n" + trace
    assert by_cid["aud_1"].description_suggestion is None


STATEMENT = "The service life is 12 years."


@pytest.mark.parametrize(
    "rewrite",
    [
        "The service life shall be 12 years.",  # an obligation the requirement does not state
        "The service life is long.",  # the number lost
        STATEMENT,  # nothing to suggest
        "Deploy the cloud platform with redundant microservices.",  # not grounded
        "",
    ],
)
def test_an_unsafe_wording_change_is_never_offered(rewrite: str) -> None:
    assert checked_rewrite(rewrite, STATEMENT) is None


def test_a_failed_chunk_offers_nothing_and_the_others_still_land_on_their_own_items(tv_path: str, monkeypatch) -> None:
    monkeypatch.setattr(suggestions, "CHUNK_SIZE", 1)
    tree = _tree(tv_path)
    warnings: list = []
    client = _Client(fail_first=True)
    write_suggestions(tree.nodes, client, warnings)
    by_id = {n.local_id: n for n in tree.nodes}
    offered = [n for n in tree.nodes if n.description_suggestion]
    assert offered and len(offered) == len([i for i in client.summarised if i])
    for node in offered:  # each item's summary came from its own first requirement, never a neighbour's
        first = next(r for r in tree.nodes if r.type.value == "Requirement" and _under(r, node, by_id))
        assert node.description_suggestion == " ".join(first.description.split("\n\n", 1)[0].split())
    assert [w.detail["pass"] for w in warnings] == ["summary_suggestions"]


def _under(node, ancestor, by_id) -> bool:  # noqa: ANN001
    parent = by_id.get(node.parent_local_id or "")
    while parent is not None:
        if parent.local_id == ancestor.local_id:
            return True
        parent = by_id.get(parent.parent_local_id or "")
    return False


def test_with_ai_review_offers_suggestions_and_standard_does_not(tv_path: str) -> None:
    from unittest.mock import patch

    from fastapi.testclient import TestClient

    from app.main import app
    from app.request_identity import USER_ID_HEADER

    client = _Client()

    class _Both(_Client):
        def requirement_titles(self, texts_by_id: dict, user_id: str | None = None) -> dict:
            return {}

    both = _Both()

    async def fake_client(model, user_id):  # noqa: ANN001, ANN202
        return both

    def fake_survey(doc, *args, **kwargs):  # noqa: ANN001, ANN202
        return _tree(tv_path)

    payload = _doc(tv_path).model_dump(mode="json")
    with patch("app.main._survey_client", fake_client), patch("app.main._build_survey_tree_with_scoring", fake_survey):
        survey = TestClient(app).post("/level?mode=survey", json=payload, headers={USER_ID_HEADER: "user-1"})
        asked_in_survey = list(both.summarised)
        baseline = TestClient(app).post("/level?mode=baseline", json=payload, headers={USER_ID_HEADER: "user-1"})
    assert survey.status_code == 200 and baseline.status_code == 200
    assert asked_in_survey and both.summarised == asked_in_survey  # Standard asked for no suggestion
    assert not client.summarised
