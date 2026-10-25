"""Other places a description reaches a model or an embedding: they read the text form, never the stored HTML."""
from app.chat.context_pack import render_context_pack
from app.kb.conformance import conformance_report
from app.kb.profile import KbProfile, Rule
from app.leveling.conflict_detection import _detect_conflicting_duplicates
from tests.test_llm_leveling import _req_node

STYLED = '<table style="width:120px;border:1px solid #333"><tr><th style="width:120px">Rail</th><th>V</th></tr><tr><td>VDD</td><td>3.3</td></tr></table>'
PROSE = "The receiver shall use the rails"


def test_a_parent_description_in_the_context_pack_is_text_not_markup() -> None:
    pack = render_context_pack({"parents": [{"type": "Feature", "title": "Rails", "description": f"{PROSE}\n\n{STYLED}"}]})
    assert pack is not None and "<" not in pack and "style" not in pack
    assert PROSE in pack and "Rail,V" in pack


def test_the_context_pack_clip_can_no_longer_cut_a_tag_in_half() -> None:
    long_table = "<table>" + "".join(f'<tr><td style="color:#{i:06d}">cell {i}</td></tr>' for i in range(200)) + "</table>"
    pack = render_context_pack({"parents": [{"type": "Feature", "title": "Rails", "description": long_table}]})
    assert pack is not None and "<" not in pack and "style=" not in pack


class _Embed:
    def __init__(self) -> None:
        self.texts: list[str] = []

    def embed(self, texts, user_id=None):  # noqa: ANN001, ANN201
        self.texts += texts
        return [[1.0, 0.0] for _ in texts]


class _Judge:
    def __init__(self) -> None:
        self.seen: list[dict] = []

    def judge_duplicate_cluster(self, texts_by_id, user_id=None):  # noqa: ANN001, ANN201
        self.seen.append(texts_by_id)
        return {"verdict": "redundant", "conflicting_values": []}


def test_duplicate_clusters_are_embedded_and_judged_on_the_text_form() -> None:
    nodes = [_req_node("n0", f"{PROSE}\n\n{STYLED}", title=""), _req_node("n1", f"{PROSE} twice\n\n{STYLED}", title="")]
    embed, judge = _Embed(), _Judge()
    _detect_conflicting_duplicates(nodes, embed, judge, [])
    assert embed.texts and all("<" not in t for t in embed.texts)
    assert judge.seen and all("<" not in text for text in judge.seen[0].values())
    assert nodes[0].description == f"{PROSE}\n\n{STYLED}"  # what is stored is left alone


def test_style_values_in_a_table_do_not_count_as_a_measurable_value() -> None:
    profile = KbProfile(version="v", built_with="m", categories=[], rules=[Rule(text="A requirement states a measurable value with a unit", sources=["d"])])
    items = [
        {"localId": "n1", "type": "Requirement", "title": "t", "description": f"The receiver shall lock quickly.\n\n{STYLED}"},
        {"localId": "n2", "type": "Requirement", "title": "t", "description": f"The receiver shall lock within 5 ms.\n\n{STYLED}"},
    ]
    report = conformance_report(items, profile, judge=None)
    assert report["rules"][0]["failed_ids"] == ["n1"]
