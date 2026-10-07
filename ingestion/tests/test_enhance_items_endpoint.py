import json

import httpx
from fastapi.testclient import TestClient

from app.leveling.id_tree_builder import synthesis_updates, title_tag_updates
from app.main import app
from app.survey.orchestrator_llm_client import OrchestratorLlmClient
from app.workitem.model import WorkItemType

client = TestClient(app)


def _patch_llm(monkeypatch, handler) -> None:
    original_init = OrchestratorLlmClient.__init__

    def patched_init(self, base_url, bearer_token, model=None, num_ctx=None, top_k=None, min_p=None, cache=None):
        original_init(self, base_url, bearer_token, model=model)
        self._transport = httpx.MockTransport(handler)

    monkeypatch.setattr(OrchestratorLlmClient, "__init__", patched_init)
    monkeypatch.setattr("app.main.settings.llm_proxy_bearer", "test-bearer")


def _reply(payload: dict):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"content": json.dumps(payload)})

    return handler


def _item(item_id: str, text: str = "Size: 3U", type_: str = "Requirement", context: str = "Power > Chassis") -> dict:
    return {"id": item_id, "text": text, "type": type_, "context": context}


def test_title_tag_returns_title_and_tags_per_id(monkeypatch) -> None:
    _patch_llm(monkeypatch, _reply({"a": {"title": "Chassis size", "tags": ["functional"]}}))

    response = client.post("/enhance-items", json={"enhancement_pass": "title_tag", "items": [_item("a")]})

    assert response.status_code == 200
    body = response.json()
    assert body["omitted"] == []
    assert body["results"]["a"]["title"] == "Chassis size"
    assert body["results"]["a"]["tags"] == ["functional"]
    # title_tag never touches the description.
    assert body["results"]["a"]["description"] is None


def test_synthesis_returns_description_with_recomputed_hash_and_grounding(monkeypatch) -> None:
    _patch_llm(
        monkeypatch,
        _reply({"a": {"title": "Chassis", "text": "The chassis shall be 3U.", "tags": ["functional"]}}),
    )

    response = client.post(
        "/enhance-items", json={"enhancement_pass": "synthesis", "items": [_item("a", text="Size: 3U")]},
    )

    result = response.json()["results"]["a"]
    assert result["description"] == "The chassis shall be 3U."
    assert len(result["fidelity_hash"]) == 64
    # Judged against the ORIGINAL verbatim text, not the new one.
    assert 0.0 <= result["grounding_score"] <= 1.0
    assert result["tags"] == ["functional"]


def test_synthesis_drops_tags_for_a_non_requirement(monkeypatch) -> None:
    _patch_llm(monkeypatch, _reply({"a": {"title": "T", "text": "The X shall Y.", "tags": ["functional"]}}))

    response = client.post(
        "/enhance-items", json={"enhancement_pass": "synthesis", "items": [_item("a", type_="Feature")]},
    )

    assert response.json()["results"]["a"]["tags"] is None


def test_ids_the_model_skipped_or_returned_nothing_usable_for_are_omitted(monkeypatch) -> None:
    _patch_llm(monkeypatch, _reply({"a": {"title": "Only A"}, "c": {"title": "   "}}))

    response = client.post(
        "/enhance-items",
        json={"enhancement_pass": "title_tag", "items": [_item("a"), _item("b"), _item("c")]},
    )

    body = response.json()
    assert list(body["results"]) == ["a"]
    assert sorted(body["omitted"]) == ["b", "c"]


def test_blank_text_is_omitted_without_spending_a_call(monkeypatch) -> None:
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(200, json={"content": "{}"})

    _patch_llm(monkeypatch, handler)

    response = client.post(
        "/enhance-items", json={"enhancement_pass": "title_tag", "items": [_item("a", text="   ")]},
    )

    assert response.status_code == 200
    assert response.json() == {"results": {}, "omitted": ["a"]}
    assert calls == []


def test_a_failing_llm_call_is_a_502_not_a_partial_result(monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": "boom"})

    _patch_llm(monkeypatch, handler)

    response = client.post("/enhance-items", json={"enhancement_pass": "title_tag", "items": [_item("a")]})

    assert response.status_code == 502
    assert "enhancement call failed" in response.json()["detail"]


def test_rejects_an_unknown_pass_an_empty_list_an_oversized_batch_and_an_unknown_type() -> None:
    unknown_pass = client.post("/enhance-items", json={"enhancement_pass": "scoring", "items": [_item("a")]})
    empty = client.post("/enhance-items", json={"enhancement_pass": "title_tag", "items": []})
    too_many = client.post(
        "/enhance-items",
        json={"enhancement_pass": "title_tag", "items": [_item(f"n{i}") for i in range(151)]},
    )
    bad_type = client.post(
        "/enhance-items", json={"enhancement_pass": "title_tag", "items": [_item("a", type_="Task")]},
    )

    assert unknown_pass.status_code == 422
    assert empty.status_code == 400
    assert too_many.status_code == 400
    assert bad_type.status_code == 400


def test_the_retry_uses_the_exact_merge_rules_of_the_pipeline_passes() -> None:
    # Guards the drift this refactor exists to prevent: the first-run passes
    # and the retry endpoint both go through these two functions.
    assert title_tag_updates({"title": "  ", "tags": "nope"}) == {}
    assert title_tag_updates({"title": "Chassis size", "tags": ["functional", "bogus"]})["tags"][0].value == "functional"
    assert len(title_tag_updates({"tags": ["functional", "bogus"]})["tags"]) == 1
    # Tags are not type-gated for title_tag (original behaviour), but are for synthesis.
    assert "tags" in title_tag_updates({"tags": ["functional"]})
    assert "tags" not in synthesis_updates({"tags": ["functional"]}, "x", WorkItemType.FEATURE)
    assert "tags" in synthesis_updates({"tags": ["functional"]}, "x", WorkItemType.REQUIREMENT)
    assert synthesis_updates({"text": "   "}, "x", WorkItemType.REQUIREMENT) == {}


def _parent(item_id: str, title: str = "Power", type_: str = "Feature", *, requirement_titles=None, requirement_descriptions=None, child_titles=None) -> dict:
    return {
        "id": item_id,
        "text": title,  # for parent_summary `text` is the node's current title
        "type": type_,
        "requirement_titles": requirement_titles if requirement_titles is not None else ["Overcurrent shutdown"],
        "requirement_descriptions": requirement_descriptions
        if requirement_descriptions is not None
        else ["The unit shall shut down on overcurrent."],
        "child_titles": child_titles if child_titles is not None else [],
    }


def test_parent_summary_returns_a_distinct_title_a_description_and_a_grounding_score(monkeypatch) -> None:
    _patch_llm(
        monkeypatch,
        _reply({"p": {"title": "Overcurrent protection capability", "description": "Shuts the unit down on overcurrent."}}),
    )

    response = client.post("/enhance-items", json={"enhancement_pass": "parent_summary", "items": [_parent("p")]})

    assert response.status_code == 200
    body = response.json()
    assert body["omitted"] == []
    result = body["results"]["p"]
    assert result["title"] == "Overcurrent protection capability"
    assert result["title_collision"] is False
    assert result["description"] == "Shuts the unit down on overcurrent."
    assert 0.0 <= result["grounding_score"] <= 1.0
    assert result["fidelity_hash"]
    assert result["tags"] is None


def test_parent_summary_keeps_the_heading_when_the_proposed_title_matches_a_title_under_it(monkeypatch) -> None:
    _patch_llm(
        monkeypatch,
        _reply({"p": {"title": "overcurrent shutdown.", "description": "Shuts the unit down on overcurrent."}}),
    )

    response = client.post("/enhance-items", json={"enhancement_pass": "parent_summary", "items": [_parent("p")]})

    result = response.json()["results"]["p"]
    assert result["title"] is None  # nothing to change: the heading stays
    assert result["title_collision"] is True
    assert result["description"] == "Shuts the unit down on overcurrent."  # the summary is still taken


def test_parent_summary_reports_ids_the_model_left_out(monkeypatch) -> None:
    _patch_llm(monkeypatch, _reply({"p1": {"title": "A distinct capability", "description": "Summary."}}))

    response = client.post(
        "/enhance-items", json={"enhancement_pass": "parent_summary", "items": [_parent("p1"), _parent("p2")]},
    )

    body = response.json()
    assert list(body["results"]) == ["p1"]
    assert body["omitted"] == ["p2"]


def test_parent_summary_only_applies_to_epics_and_features(monkeypatch) -> None:
    _patch_llm(monkeypatch, _reply({}))

    response = client.post(
        "/enhance-items", json={"enhancement_pass": "parent_summary", "items": [_parent("r", type_="Requirement")]},
    )

    assert response.status_code == 400
    assert "Epic and Feature" in response.json()["detail"]


def test_parent_summary_requests_are_capped_far_below_the_leaf_passes(monkeypatch) -> None:
    _patch_llm(monkeypatch, _reply({}))

    response = client.post(
        "/enhance-items",
        json={"enhancement_pass": "parent_summary", "items": [_parent(f"p{i}") for i in range(26)]},
    )

    assert response.status_code == 400
    assert "at most 25" in response.json()["detail"]


def test_parent_summary_sends_the_descendants_text_to_the_model(monkeypatch) -> None:
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(json.loads(request.content)["messages"][1]["content"]))
        return httpx.Response(200, json={"content": json.dumps({"p": {"title": "Brand new title", "description": "D."}})})

    _patch_llm(monkeypatch, handler)
    client.post("/enhance-items", json={"enhancement_pass": "parent_summary", "items": [_parent("p")]})

    assert seen[0]["p"] == {
        "title": "Power",
        "requirement_titles": ["Overcurrent shutdown"],
        "requirement_descriptions": ["The unit shall shut down on overcurrent."],
    }
