"""Which prompt produced a work item (owner decision, 2026-11-22): the client tags each answer entry with the prompt of the call that
produced it, and the code that applies an answer records that prompt on the node (WorkItemNode.prompts). Stored only."""

import json

import httpx

from app.canonical.model import SourceRef
from app.language_policy import LanguagePolicy
from app.leveling.scoring import _apply_quality_scores
from app.survey.orchestrator_llm_client import OrchestratorLlmClient
from app.workitem.model import (
    PROMPT_KEY,
    PromptRef,
    WorkItemMode,
    WorkItemNode,
    WorkItemType,
    record_prompt,
)

TAG = {"name": "score_requirements_for_document", "version": 5, "sha256": "abc"}


def _node(local_id: str = "n1") -> WorkItemNode:
    return WorkItemNode(
        local_id=local_id,
        parent_local_id=None,
        type=WorkItemType.REQUIREMENT,
        title=local_id,
        description="The unit shall do X.",
        source_ref=SourceRef(document_path="x.docx", start_offset=0, end_offset=1),
        mode=WorkItemMode.SURVEY,
    )


def test_a_prompt_is_recorded_once_and_an_untagged_or_malformed_answer_records_nothing() -> None:
    node = _node()
    record_prompt(node, {"title": "T", PROMPT_KEY: TAG})
    record_prompt(node, {"title": "T2", PROMPT_KEY: TAG})
    record_prompt(node, {"title": "T3"})
    record_prompt(node, {PROMPT_KEY: {"name": "x"}})
    record_prompt(node, None)
    assert node.prompts == [PromptRef(**TAG)]
    assert node.model_dump()["prompts"] == [{**TAG, "model": None}]  # no model named: the orchestrator's default answered
    assert _node().prompts == []


def _client(answers: list[object]) -> OrchestratorLlmClient:
    count = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        count["n"] += 1
        return httpx.Response(200, json={"content": json.dumps(answers[count["n"] - 1])})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="t")
    client._transport = httpx.MockTransport(handler)
    return client


def test_each_answer_is_tagged_with_the_prompt_of_its_own_call() -> None:
    client = _client(
        [
            {"items": [{"id": "he", "title": "אספקת חשמל ליחידה", "description": "מספקת מתח"}]},
            {"items": [{"id": "en", "title": "Environment", "description": "Covers the tests"}]},
        ]
    )
    client.language_policy = LanguagePolicy("LATIN", (), "document")
    result = client.summarize_parent_nodes(
        {
            "he": {"title": "אספקת מתח", "requirement_titles": []},
            "en": {"title": "Environment", "requirement_titles": []},
        }
    )
    tags = {node_id: entry[PROMPT_KEY] for node_id, entry in result.items()}
    assert {t["name"] for t in tags.values()} == {"summarize_parent_nodes"}
    assert all(isinstance(t["version"], int) and len(t["sha256"]) == 64 for t in tags.values())

    criteria = _client(
        [
            {
                "items": [
                    {
                        "id": "r1",
                        "criteria": [],
                        "assumptions": [],
                        "needs_author_input": True,
                        "missing": ["TBD"],
                    }
                ]
            }
        ]
    ).propose_acceptance_criteria({"r1": {"text": "The unit shall operate at TBD V."}})
    assert criteria["r1"][PROMPT_KEY]["name"] == "propose_acceptance_criteria"


def test_a_score_records_the_scoring_prompt_on_its_node() -> None:
    levels = [
        {"name": n, "level": 4, "evidence": ""}
        for n in ("clarity", "testability", "atomicity", "completeness_as_requirement")
    ]
    answer = {"n1": {"categories": levels, "findings": []}}
    client = _client([answer, answer])
    node = _node()
    _apply_quality_scores([node], client, [], node_id_prefix="")
    assert node.quality_score == 100
    assert [p.name for p in node.prompts] == ["score_requirements_for_document"]
