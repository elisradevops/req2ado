"""Short requirement titles (app.leveling.requirement_titles): a model writes them, code keeps only grounded ones, the description never
changes, a failure keeps the extracted titles, and the client asks the model only for requirements it has not answered before."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from app.leveling.requirement_titles import checked_title, statement_of, write_requirement_titles
from app.survey.llm_cache import LlmResponseCache
from app.survey.orchestrator_llm_client import OrchestratorLlmClient
from app.workitem.model import WorkItemType
from tests.test_orchestrator_llm_client import _CountingFakeRedis

GOLD = json.loads((Path(__file__).parent / "fixtures" / "tv_twin" / "tv_gold_tree.json").read_text(encoding="utf-8"))["nodes"]
GOLD_REQUIREMENTS = [n for n in GOLD if n["type"] == "Requirement"]


@pytest.mark.parametrize("gold", GOLD_REQUIREMENTS, ids=lambda n: n["customer_id"] or "uncoded")
def test_every_hand_written_title_of_the_tv_twin_is_grounded_in_its_requirement(gold: dict) -> None:
    assert checked_title(gold["title"], gold["description"].split("\n\n", 1)[0]) == gold["title"]


STATEMENT = "The terrestrial tuner shall receive DVB-T2 broadcasts in the 470 MHz to 694 MHz band."


@pytest.mark.parametrize(
    "title",
    [
        "Smart tuner streams DVB-T2 broadcasts",  # "smart", "streams": words the requirement does not state
        "Tuner shall receive DVB-T2 broadcasts",  # an obligation word
        "tun_1 Terrestrial tuner",  # a code
        "Terrestrial tuner receives DVB-T2 broadcasts in the 470 MHz to 694 MHz band in every case",  # not short
        "",
        None,
    ],
)
def test_a_title_that_is_not_short_clean_and_grounded_is_refused(title: object) -> None:
    assert checked_title(title, STATEMENT) is None


def test_a_full_stop_is_dropped_and_another_form_of_a_word_is_grounded() -> None:
    assert checked_title("Terrestrial tuner receives DVB-T2 broadcasts.", STATEMENT) == "Terrestrial tuner receives DVB-T2 broadcasts"


def _requirements():
    from app.canonical.model import SourceRef
    from app.workitem.model import WorkItemMode, WorkItemNode

    def node(local_id: str, text: str):
        return WorkItemNode(
            local_id=local_id,
            type=WorkItemType.REQUIREMENT,
            parent_local_id="f1",
            title=text[:40],
            description=f"{text}\n\nSatisfies:\nSYS_1",
            source_ref=SourceRef(document_path="d.pdf", start_offset=0, end_offset=1),
            fidelity_hash="x",
            identity_hash="y",
            mode=WorkItemMode.BASELINE,
            verbatim=True,
        )

    return [
        node("r1", STATEMENT),
        node("r2", "The remote shall weigh less than 120 g including batteries."),
    ]


class _Titles:
    def __init__(self, answer: dict[str, str] | Exception) -> None:
        self.answer, self.asked = answer, []

    def requirement_titles(self, texts_by_id: dict[str, str], user_id: str | None = None) -> dict[str, dict]:
        self.asked.append(dict(texts_by_id))
        if isinstance(self.answer, Exception):
            raise self.answer
        return {k: {"title": v} for k, v in self.answer.items()}


def test_grounded_titles_are_written_and_an_ungrounded_one_keeps_the_extracted_title() -> None:
    nodes = _requirements()
    before = {n.local_id: (n.title, n.description) for n in nodes}
    client = _Titles({"r1": "Terrestrial tuner receives DVB-T2 broadcasts", "r2": "Lightweight ergonomic remote"})
    warnings: list = []
    assert write_requirement_titles(nodes, client, warnings) == 1
    assert client.asked == [{n.local_id: statement_of(n) for n in nodes}]  # the requirement's text, never its trace
    by_id = {n.local_id: n for n in nodes}
    assert by_id["r1"].title == "Terrestrial tuner receives DVB-T2 broadcasts"
    assert by_id["r2"].title == before["r2"][0]
    assert all(n.description == before[n.local_id][1] for n in nodes)  # the document's words never change
    assert not warnings


def test_a_failed_call_keeps_every_extracted_title_and_says_so() -> None:
    nodes = _requirements()
    titles = [n.title for n in nodes]
    warnings: list = []
    assert write_requirement_titles(nodes, _Titles(RuntimeError("unreachable")), warnings) == 0
    assert [n.title for n in nodes] == titles
    assert [w.kind.value for w in warnings] == ["enhancement_call_failed"]


def test_only_grammar_requirements_get_titles() -> None:
    nodes = _requirements()
    nodes[1].verbatim = False  # built by another path: its title is that path's
    client = _Titles({"r1": "Terrestrial tuner receives DVB-T2 broadcasts"})
    write_requirement_titles(nodes, client, [])
    assert list(client.asked[0]) == ["r1"]


def test_the_client_asks_only_for_requirements_it_has_not_answered() -> None:
    sent: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        prompt = "\n".join(m["content"] for m in body["messages"])
        sent.append(prompt)
        titles = {"r1": "Terrestrial tuner receives DVB-T2 broadcasts", "r2": "Remote weighs less than 120 g", "r3": "Menu opens quickly"}
        return httpx.Response(200, json={"content": json.dumps({k: {"title": v} for k, v in titles.items() if f'"{k}"' in prompt})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="t", cache=LlmResponseCache(_CountingFakeRedis()))
    client._transport = httpx.MockTransport(handler)
    first = client.requirement_titles({"r1": STATEMENT, "r2": "The remote shall weigh less than 120 g."}, user_id="u1")
    second = client.requirement_titles({"r1": STATEMENT, "r3": "The on-screen menu shall open within 300 ms."}, user_id="u1")
    assert first["r1"]["title"] == second["r1"]["title"] == "Terrestrial tuner receives DVB-T2 broadcasts"
    assert second["r3"]["title"] == "Menu opens quickly"
    sources = [json.loads(p.rsplit("<source>", 1)[1].split("</source>", 1)[0]) for p in sent]
    assert sources == [{"r1": STATEMENT, "r2": "The remote shall weigh less than 120 g."}, {"r3": "The on-screen menu shall open within 300 ms."}]
    assert "shall" in sent[0] and "never translate" in sent[0]  # the prompt's rules travel with the call


# --- /level: both modes write titles for a job; the wizard's preview (no user) does not ------------------------------------------------


@pytest.fixture(scope="module")
def tv_doc(tmp_path_factory):
    import sys

    from app.dispatch import dispatch_by_extension

    sys.path.insert(0, str(Path(__file__).parent / "fixtures" / "tv_twin"))
    from build_tv_twin_pdf import build_twin_spec_pdf

    path, _truth = build_twin_spec_pdf(tmp_path_factory.mktemp("level_titles"))
    return dispatch_by_extension(path.name, str(path))


class _OneTitle:
    """Titles one requirement (tun_1) by its text, as a model would; records who asked."""

    def __init__(self) -> None:
        self.users: list[str | None] = []

    def requirement_titles(self, texts_by_id: dict[str, str], user_id: str | None = None) -> dict[str, dict]:
        self.users.append(user_id)
        return {k: {"title": "Terrestrial tuner receives DVB-T2 broadcasts"} for k, v in texts_by_id.items() if v.startswith(STATEMENT[:40])}


def _level(doc, user: str | None, titles: _OneTitle) -> dict:
    from unittest.mock import patch

    from fastapi.testclient import TestClient

    from app.main import app
    from app.request_identity import USER_ID_HEADER

    async def fake_client(model, user_id):  # noqa: ANN001, ANN202
        return titles

    headers = {USER_ID_HEADER: user} if user else {}
    with patch("app.main._survey_client", fake_client):
        response = TestClient(app).post("/level?mode=baseline", json=doc.model_dump(mode="json"), headers=headers)
    assert response.status_code == 200, response.text
    return {n["customer_id"]: n for n in response.json()["nodes"] if n.get("customer_id")}


def test_a_baseline_job_gets_short_titles(tv_doc) -> None:
    titles = _OneTitle()
    nodes = _level(tv_doc, "user-1", titles)
    assert nodes["tun_1"]["title"] == "Terrestrial tuner receives DVB-T2 broadcasts"
    assert titles.users and set(titles.users) == {"user-1"}


def test_the_wizards_preview_without_a_user_asks_no_model(tv_doc) -> None:
    titles = _OneTitle()
    nodes = _level(tv_doc, None, titles)
    assert not titles.users
    assert nodes["tun_1"]["title"].startswith("The terrestrial tuner shall receive")


def test_a_file_whose_requirements_carry_their_own_titles_keeps_them(tv_doc) -> None:
    from app.study.rulebook import DocumentRules, FileRulebook, rulebook_to_json

    doc = tv_doc.model_copy(deep=True)
    doc.rulebook = rulebook_to_json(FileRulebook(document=DocumentRules(requirement_codes=("aud_1", "btn_2", "men_3"), title_policy="extract")))
    titles = _OneTitle()
    nodes = _level(doc, "user-1", titles)
    assert not titles.users and nodes["tun_1"]["title"].startswith("The terrestrial tuner shall receive")
