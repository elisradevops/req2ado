"""The output-language policy (app.language_policy): code reads the script and checks the answer; the obligation form is the organization's
or the document's own words, and reaches a prompt only as data."""

from __future__ import annotations

import json
from types import SimpleNamespace

import httpx

from app.job_cancel import JobCancelled
from app.kb.profile import _empty, _union, merge_document_profiles
from app.language_policy import (
    LanguagePolicy,
    checked_obligation_forms,
    dominant_script,
    obligation_sample,
    policy_for_document,
    writes_in_script,
)
from app.prompts.assembly import block_text
from app.survey.keyed_calls import run_keyed
from app.survey.keyed_specs import PARENT_SUMMARY_SPEC
from app.survey.orchestrator_llm_client import OrchestratorLlmClient

HEBREW_REQUIREMENT = "היחידה תעבור בדיקת סביבה לפי MIL-STD-810 ותספק 28 VDC למערכת"
ENGLISH_REQUIREMENT = "The unit shall pass environmental testing per MIL-STD-810."


def test_the_script_is_read_from_words_and_acronyms_and_numbers_do_not_count() -> None:
    assert dominant_script(HEBREW_REQUIREMENT) == "HEBREW"
    assert dominant_script(ENGLISH_REQUIREMENT) == "LATIN"
    # Latin identifiers, units and acronyms in a Hebrew sentence are not words of its language.
    assert dominant_script("המתח TBD VDC PSU 28V לא יעלה") == "HEBREW"
    assert dominant_script("28 VDC, TBD, 5%") is None
    assert dominant_script("") is None


def test_a_hebrew_source_accepts_hebrew_output_and_refuses_a_translation() -> None:
    assert writes_in_script("היחידה תעבור בדיקת סביבה ותספק מתח", HEBREW_REQUIREMENT)
    assert not writes_in_script(
        "The unit shall pass environmental testing and supply 28 VDC.", HEBREW_REQUIREMENT
    )
    assert not writes_in_script("היחידה תעבור בדיקה", ENGLISH_REQUIREMENT)


def test_only_the_words_the_output_adds_decide_its_script() -> None:
    source = "מתג Power Supply ראשי לכל יחידה"
    # The English name is copied from the source; the added words are Hebrew.
    assert writes_in_script("Power Supply ראשי יותקן בכל יחידה", source)
    # Nothing to judge by: no added words, or a source without words.
    assert writes_in_script("Power Supply", source)
    assert writes_in_script("anything at all", "28 VDC 5%")


def test_obligation_forms_must_be_copied_from_the_text() -> None:
    text = "היחידה תעבור בדיקה. על המערכת לספק מתח."
    raw = ["על המערכת ל", "shall", "  היחידה   תעבור ", 7, "על המערכת ל", "x" * 200]
    assert checked_obligation_forms(raw, text) == ["על המערכת ל", "היחידה תעבור"]
    assert checked_obligation_forms("shall", text) == []


def test_the_sample_is_body_sentences_in_order_and_bounded() -> None:
    texts = ["Scope", "The unit shall supply power to the bus.", "short line", "x " * 3000]
    assert obligation_sample(texts) == "The unit shall supply power to the bus."


def _doc(*blocks: tuple[str, str]) -> SimpleNamespace:
    return SimpleNamespace(blocks=[SimpleNamespace(kind=k, text=t) for k, t in blocks])


HEBREW_DOC = _doc(
    ("heading", "דרישות כלליות"),
    ("paragraph", HEBREW_REQUIREMENT),
    ("table", "Voltage Current Power Rating Notes Limits"),
)


def test_the_organizations_form_wins_and_the_document_is_not_asked() -> None:
    asked: list[str] = []
    policy = policy_for_document(HEBREW_DOC, ["יש ל"], lambda s: asked.append(s) or ["x"])
    assert policy == LanguagePolicy("HEBREW", ("יש ל",), "kb")
    assert asked == []


def test_without_an_organization_form_the_document_states_its_own() -> None:
    asked: list[str] = []

    def find(sample: str) -> list[str]:
        asked.append(sample)
        return ["היחידה תעבור"]

    policy = policy_for_document(HEBREW_DOC, [], find)
    assert policy == LanguagePolicy("HEBREW", ("היחידה תעבור",), "document")
    assert asked == [HEBREW_REQUIREMENT]  # body sentences only: no heading, no table text


def test_a_failed_read_leaves_the_form_unknown_but_a_cancel_propagates() -> None:
    def broken(_sample: str) -> list[str]:
        raise RuntimeError("proxy down")

    assert policy_for_document(HEBREW_DOC, [], broken) == LanguagePolicy("HEBREW")
    assert policy_for_document(HEBREW_DOC, [], lambda _s: []) == LanguagePolicy("HEBREW")

    def cancelled(_sample: str) -> list[str]:
        raise JobCancelled("cancelled")

    try:
        policy_for_document(HEBREW_DOC, [], cancelled)
    except JobCancelled:
        pass
    else:
        raise AssertionError("a cancelled job must not be swallowed")


def test_kb_obligation_forms_are_pooled_and_ranked_by_documents() -> None:
    a, b = _empty(), _empty()
    _union(a, {"obligation_forms": ["shall", " shall ", "must"]})
    _union(b, {"obligation_forms": ["must"]})
    assert a["obligation_forms"] == ["shall", "must"]
    profile = merge_document_profiles({"a.docx": a, "b.docx": b}, "m", "v")
    assert [(f.text, f.sources) for f in profile.obligation_forms] == [
        ("must", ["a.docx", "b.docx"]),
        ("shall", ["a.docx"]),
    ]


def _client(answers: list[object]) -> tuple[OrchestratorLlmClient, list[dict]]:
    bodies: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json={"content": json.dumps(answers[len(bodies) - 1])})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="t")
    client._transport = httpx.MockTransport(handler)
    return client, bodies


def _array(entries: dict[str, dict]) -> dict:
    return {"items": [{"id": k, **v} for k, v in entries.items()]}


def test_the_obligation_form_reaches_the_model_only_as_data_with_its_authority() -> None:
    answer = _array({"r1": {"title": "בדיקת סביבה", "text": "היחידה תעבור בדיקה", "tags": []}})
    client, bodies = _client([answer, answer])
    client.language_policy = LanguagePolicy("HEBREW", ("על המערכת ל",), "kb")
    client.synthesize_leaf_requirements({"r1": {"text": HEBREW_REQUIREMENT, "context": "כללי"}})
    system, user = (m["content"] for m in bodies[0]["messages"])
    assert "על המערכת ל" not in system
    assert "Hebrew script" in system and "<obligation_forms> block" in system
    assert block_text(user, "obligation_forms") == "על המערכת ל"
    assert "- <obligation_forms>: the organization's authoring standard" in system

    client, bodies = _client([answer])
    client.language_policy = LanguagePolicy("HEBREW", ("היחידה תעבור",), "document")
    client.synthesize_leaf_requirements({"r1": {"text": HEBREW_REQUIREMENT, "context": "כללי"}})
    system = bodies[0]["messages"][0]["content"]
    assert "- <obligation_forms>: the material to work on" in system
    assert "this document's own usage" in system


def test_a_prompt_that_writes_no_requirement_gets_the_language_but_no_form() -> None:
    client, bodies = _client([_array({"p1": {"title": "אספקת מתח", "description": "תיאור"}})])
    client.language_policy = LanguagePolicy(None, ("shall",), "kb")
    client.summarize_parent_nodes({"p1": {"title": "מתח", "requirement_titles": ["דרישה"]}})
    system, user = (m["content"] for m in bodies[0]["messages"])
    assert "Language: write every text" in system and "main language" not in system
    assert "obligation_forms" not in system and block_text(user, "obligation_forms") is None


def test_an_answer_in_another_script_is_asked_again_then_left_out() -> None:
    english = _array({"p1": {"title": "Power supply", "description": "Supplies the power"}})
    client, bodies = _client([english, english])
    result = client.summarize_parent_nodes({"p1": {"title": "אספקת מתח", "requirement_titles": []}})
    assert len(bodies) == 2  # the one retry of an omitted id
    assert dict(result) == {} and result.missing == ["p1"]  # the caller keeps its own title

    hebrew = _array({"p1": {"title": "אספקת מתח ליחידה", "description": "מספקת מתח"}})
    client, bodies = _client([english, hebrew])
    result = client.summarize_parent_nodes({"p1": {"title": "אספקת מתח", "requirement_titles": []}})
    assert result["p1"]["title"] == "אספקת מתח ליחידה"


def test_run_keyed_counts_a_refused_entry_as_omitted() -> None:
    calls: list[dict] = []

    def send(payload: dict, _mode: str) -> object:
        calls.append(payload)
        return {k: {"title": f"t{len(calls)}", "description": "d"} for k in payload}

    result = run_keyed(
        send,
        {"a": 1, "b": 2},
        PARENT_SUMMARY_SPEC,
        accept=lambda node_id, entry: node_id == "a" or entry["title"] != "t1",
    )
    assert result == {
        "a": {"title": "t1", "description": "d"},
        "b": {"title": "t2", "description": "d"},
    }
    assert calls[1] == {"b": 2}


def test_the_document_obligation_form_call_keeps_only_what_the_sample_contains() -> None:
    client, bodies = _client([{"obligation_forms": ["היחידה תעבור", "shall"]}])
    assert client.find_obligation_forms(HEBREW_REQUIREMENT) == ["היחידה תעבור"]
    assert block_text(bodies[0]["messages"][1]["content"]) == HEBREW_REQUIREMENT
