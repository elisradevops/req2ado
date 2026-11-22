"""What an organization's standard requires beyond the built-in scoring categories (app.kb.profile.find_standard_requires): asked once per
profile build, kept only with a quote the standard really contains, and read by scoring through the client (owner decision, 2026-11-22)."""

import json

import httpx

import app.kb.profile as profile_module
from app.kb.profile import (
    Category,
    KbProfile,
    Rule,
    build_version,
    find_standard_requires,
    standard_requires,
)
from app.survey.orchestrator_llm_client import OrchestratorLlmClient

RULE = "כל דרישה תנוסח בקול פעיל ותציין מי מבצע אותה."


def _profile() -> KbProfile:
    return KbProfile(
        version="v",
        built_with="m",
        rules=[Rule(text=RULE, sources=["std.docx"])],
        categories=[
            Category(name="Verifiable", pass_condition="has a test method", sources=["std.docx"])
        ],
    )


class _Finder:
    def __init__(self, answer: object) -> None:
        self.answer = answer
        self.asked: list[tuple] = []

    def find_standard_requirements(self, rules, categories, user_id=None):  # noqa: ANN001, ANN201
        self.asked.append((rules, categories))
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer


def test_a_requirement_counts_only_with_a_quote_the_standard_contains() -> None:
    finder = _Finder(
        {"active_voice": "  בקול   פעיל ", "rationale": "every requirement shall state why"}
    )
    found, answered = find_standard_requires(_profile(), finder)
    assert answered and [(r.name, r.quote) for r in found] == [("active_voice", "  בקול   פעיל ")]
    assert finder.asked == [
        ([RULE], [{"name": "Verifiable", "pass_condition": "has a test method"}])
    ]
    assert standard_requires(KbProfile(version="v", built_with="m", standard_requires=found)) == {
        "active_voice"
    }


def test_no_standard_requires_nothing_and_a_failed_question_is_not_answered() -> None:
    assert standard_requires(None) == frozenset()
    empty = KbProfile(version="v", built_with="m")
    assert find_standard_requires(empty, _Finder({"rationale": "x"})) == (
        [],
        True,
    )  # nothing to ask about
    assert find_standard_requires(_profile(), object()) == (
        [],
        True,
    )  # a client without the question
    assert find_standard_requires(_profile(), _Finder(ValueError("no answer"))) == ([], False)


def test_the_question_is_part_of_how_a_profile_is_built(monkeypatch) -> None:  # noqa: ANN001
    # A change to the prompt makes every stored profile stale, so each KB rebuilds once.
    before = build_version()
    real = profile_module.load_prompt
    monkeypatch.setattr(
        profile_module,
        "load_prompt",
        lambda name, *a, **k: (
            "changed" if name == "find_standard_requirements" else real(name, *a, **k)
        ),
    )
    assert build_version() != before


def _client(answer: object) -> tuple[OrchestratorLlmClient, list[dict]]:
    bodies: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json={"content": json.dumps(answer)})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="t")
    client._transport = httpx.MockTransport(handler)
    return client, bodies


def test_the_client_returns_only_what_is_required_with_a_quote() -> None:
    client, bodies = _client(
        {
            "active_voice": {"required": True, "quote": " in the  active voice "},
            "rationale": {"required": True, "quote": ""},
        }
    )
    assert client.find_standard_requirements([RULE], []) == {"active_voice": "in the active voice"}
    assert bodies[0]["responseSchema"]["name"] == "standard_requirements"


def test_scoring_judges_what_the_client_s_standard_requires() -> None:
    client, bodies = _client({})
    client.score_requirements_for_document({"n1": "The unit shall do X."})
    assert "- style (" not in bodies[0]["messages"][0]["content"]
    client.standard_requires = frozenset({"active_voice"})
    client.score_requirements_for_document({"n1": "The unit shall do X."})
    system = bodies[-1]["messages"][0]["content"]
    assert "- style (" in system and "- rationale (" not in system and "passive_voice" in system
