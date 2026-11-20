"""The file-conventions pre-study's model calls: how a reply is read, which answers are kept for reuse, and how the votes are asked."""

from __future__ import annotations

import json
import threading

import httpx
import pytest

from app.job_cancel import JobCancelled
from app.leveling.document_study import StudyLengthCutoff
from app.study import model_rules
from app.study.model_rules import _ask
from app.survey.orchestrator_llm_client import (
    OrchestratorLlmClient,
    _parse_json_object,
    _strip_json_fence,
)

TABLE_ANSWER = {"sheet_kind": "work_items", "header_row": 0, "columns": [], "nesting": "row_order"}


class DictCache:
    def __init__(self) -> None:
        self.values: dict[str, object] = {}

    def get(self, key: str) -> object | None:
        return self.values.get(key)

    def set(self, key: str, value: object) -> None:
        self.values[key] = value


def _client(replies: list[dict], sent: list[dict] | None = None, cache: DictCache | None = None) -> OrchestratorLlmClient:
    client = OrchestratorLlmClient("http://orchestrator.internal", "test-bearer", cache=cache)  # type: ignore[arg-type]
    queue = list(replies)

    def handler(request: httpx.Request) -> httpx.Response:
        if sent is not None:
            sent.append(json.loads(request.content))
        return httpx.Response(200, json=queue.pop(0))

    client._transport = httpx.MockTransport(handler)
    return client


# --- reading the reply -------------------------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "reply",
    [
        '<think>The columns look like {a, b}; maybe {"x": 1}.</think>\n{"sheet_kind": "work_items"}',
        '<details type="reasoning" done="true">\n<summary>Thought</summary>\n> {draft}\n</details>\n```json\n{"sheet_kind": "work_items"}\n```',
        '<think>first</think><think>{second}</think> {"sheet_kind": "work_items"}',
    ],
)
def test_leading_reasoning_is_dropped_before_the_json_is_read(reply: str) -> None:
    assert _parse_json_object(_strip_json_fence(reply)) == {"sheet_kind": "work_items"}


def test_a_tag_inside_the_json_itself_is_left_alone() -> None:
    reply = '{"text": "<think>quoted</think>"}'
    assert _parse_json_object(_strip_json_fence(reply)) == {"text": "<think>quoted</think>"}


def test_an_answer_wrapped_in_one_outer_key_is_unwrapped() -> None:
    client = _client([{"content": json.dumps({"result": TABLE_ANSWER}), "finishReason": "stop"}])
    assert client.study_file_rules_table({"rows": []}) == TABLE_ANSWER
    document = {"type_source": "labels", "labels": [], "depth_types": [], "evidence_headings": []}
    client = _client([{"content": json.dumps({"answer": document}), "finishReason": "stop"}])
    assert client.study_file_rules_document({"headings": []}) == document


def test_a_single_key_that_is_not_a_wrapper_is_returned_as_it_is() -> None:
    client = _client([{"content": json.dumps({"sheet_kind": "not_work_items"}), "finishReason": "stop"}])
    assert client.study_file_rules_table({"rows": []}) == {"sheet_kind": "not_work_items"}


def test_the_ask_is_a_study_call_and_a_cut_off_answer_fails_the_vote() -> None:
    sent: list[dict] = []
    client = _client([{"content": '{"sheet_kind": "wo', "finishReason": "length"}], sent)
    with pytest.raises(StudyLengthCutoff):
        client.study_file_rules_table({"rows": []})
    assert sent[0]["budgetKind"] == "study" and sent[0]["deadlineMs"] > 0
    assert sent[0]["think"] is False


# --- which answers are kept ----------------------------------------------------------------------------------------------------------------------


def test_only_an_accepted_answer_is_kept_and_reused() -> None:
    cache = DictCache()
    refused = {**TABLE_ANSWER, "sheet_kind": "unknown"}
    sent: list[dict] = []
    client = _client(
        [{"content": json.dumps(refused), "finishReason": "stop"}, {"content": json.dumps(TABLE_ANSWER), "finishReason": "stop"}],
        sent,
        cache,
    )
    client.study_fresh = False
    accept = lambda raw: raw.get("sheet_kind") == "work_items"  # noqa: E731
    assert client.study_file_rules_table({"rows": []}, user_id="u1", accept=accept) == refused
    assert cache.values == {}  # a refused answer is never replayed
    assert client.study_file_rules_table({"rows": []}, user_id="u1", accept=accept) == TABLE_ANSWER
    assert list(cache.values.values()) == [TABLE_ANSWER]
    assert client.study_file_rules_table({"rows": []}, user_id="u1", accept=accept) == TABLE_ANSWER
    assert len(sent) == 2  # the third ask was answered from the kept answer


def test_a_kept_answer_that_no_longer_passes_is_asked_again() -> None:
    cache = DictCache()
    sent: list[dict] = []
    client = _client([{"content": json.dumps(TABLE_ANSWER), "finishReason": "stop"}] * 2, sent, cache)
    client.study_file_rules_table({"rows": []}, user_id="u1", accept=lambda raw: True)
    client.study_file_rules_table({"rows": []}, user_id="u1", accept=lambda raw: False)
    assert len(sent) == 2


def test_reading_again_asks_the_model_afresh_and_keeps_the_new_answer() -> None:
    cache = DictCache()
    sent: list[dict] = []
    client = _client([{"content": json.dumps(TABLE_ANSWER), "finishReason": "stop"}] * 2, sent, cache)
    client.study_file_rules_table({"rows": []}, user_id="u1", accept=lambda raw: True)
    client.study_fresh = True
    client.study_file_rules_table({"rows": []}, user_id="u1", accept=lambda raw: True)
    assert len(sent) == 2 and len(cache.values) == 1


# --- the votes ---------------------------------------------------------------------------------------------------------------------------------


def _validate(raw: dict) -> object:
    return raw["vote"] if raw.get("ok") else f"refused {raw['vote']}"


def test_the_votes_are_asked_at_once_and_read_in_vote_order(monkeypatch) -> None:
    monkeypatch.setattr(model_rules.settings, "prestudy_vote_concurrency", 3)
    barrier = threading.Barrier(3, timeout=5)  # only passes when all three asks are in flight together

    def ask(vote: int, accept) -> dict:  # noqa: ANN001
        barrier.wait()
        return {"vote": vote, "ok": vote != 1}

    answers, reason = _ask(ask, _validate, 3, "table t0")
    assert answers == [0, 2] and reason is None


def test_one_at_a_time_when_configured(monkeypatch) -> None:
    monkeypatch.setattr(model_rules.settings, "prestudy_vote_concurrency", 1)
    order: list[int] = []

    def ask(vote: int, accept) -> dict:  # noqa: ANN001
        order.append(vote)
        return {"vote": vote, "ok": True}

    assert _ask(ask, _validate, 3, "table t0") == ([0, 1, 2], None)
    assert order == [0, 1, 2]


def test_the_first_reason_in_vote_order_is_reported_and_a_failed_ask_is_one_answer_short(monkeypatch) -> None:
    monkeypatch.setattr(model_rules.settings, "prestudy_vote_concurrency", 3)

    def ask(vote: int, accept) -> dict:  # noqa: ANN001
        if vote == 2:
            raise RuntimeError("down")
        return {"vote": vote, "ok": False}

    answers, reason = _ask(ask, _validate, 3, "table t0")
    assert answers == [] and reason == "refused 0 (0 of 3 answers usable)"


def test_a_cancelled_run_propagates_from_a_concurrent_vote(monkeypatch) -> None:
    monkeypatch.setattr(model_rules.settings, "prestudy_vote_concurrency", 3)

    def ask(vote: int, accept) -> dict:  # noqa: ANN001
        if vote == 1:
            raise JobCancelled()
        return {"vote": vote, "ok": True}

    with pytest.raises(JobCancelled):
        _ask(ask, _validate, 3, "table t0")


def test_the_check_is_offered_to_the_client_so_only_usable_answers_are_kept(monkeypatch) -> None:
    monkeypatch.setattr(model_rules.settings, "prestudy_vote_concurrency", 1)
    verdicts: list[bool] = []

    def ask(vote: int, accept) -> dict:  # noqa: ANN001
        raw = {"vote": vote, "ok": vote == 0}
        verdicts.append(accept(raw))
        return raw

    _ask(ask, _validate, 2, "table t0")
    assert verdicts == [True, False]
