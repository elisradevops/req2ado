"""What the new-job page reads off a studied file (app.study.reading): the verdict, the decisions by name, the automatic fixes, what was left
out, and the Epics and Features the job will build -- on the TV twin with its study answer, and in the study response the wizard receives."""

from __future__ import annotations

from app.study.reading import file_reading, heading_id_of
from app.study.rulebook import DocumentRules, FileRulebook
from tests.test_tv_twin_formats import _doc, _study


def test_the_reading_gives_the_verdict_the_decisions_the_fixes_and_the_outline(tmp_path) -> None:
    doc = _doc("pdf", str(tmp_path))
    reading = file_reading(doc, _study(doc))
    assert reading is not None
    assert (reading["kind"], reading["requirements"], reading["withIds"], reading["epics"], reading["features"]) == (
        "requirements_export", 121, 120, 10, 25
    )
    assert reading["coverTitle"] == "[220.3] Vireo Television Set (VTS)"
    assert [(d["action"], d["title"], d["newTitle"], d["decision"]) for d in reading["decisions"]] == [
        ("rename", "Requirements", "Vireo Television Set (VTS)", None),
        ("drop_wrapper", "General", None, None),
        ("rename", "Design and construction", "Environment and safety", None),
    ]
    assert [(f["from"], f["to"]) for f in reading["fixes"]] == [("Enclousure", "Enclosure")]
    assert [e["customerId"] for e in reading["examples"]] == ["gen_1", "gen_2", "men_3.a"]
    # A sub-requirement sits under its requirement, named by its code: before the job's short titles, its title is still a whole sentence.
    assert reading["examples"][2]["under"] == "men_3"
    assert any("REQUIREMENT IDENTITIES" in part["text"] for part in reading["leftOut"])
    roots = [o for o in reading["outline"] if o["parent"] is None]
    assert [(r["type"], r["title"], r["requirements"]) for r in roots] == [("Epic", "Requirements", 121)]
    general = next(o for o in reading["outline"] if o["title"] == "General")
    assert general["headingId"] == reading["decisions"][1]["headingId"]  # the page applies a decision to its own outline item


def test_the_outline_is_the_files_original_whatever_was_decided(tmp_path) -> None:
    doc = _doc("pdf", str(tmp_path))
    study = _study(doc)
    general = next(p.block_id for p in study.document.proposals if p.action == "drop_wrapper")
    decided = FileRulebook(document=DocumentRules(**{**study.document.__dict__, "proposal_decisions": ((general, "accept"),)}))
    reading = file_reading(doc, decided)
    assert any(o["title"] == "General" for o in reading["outline"])  # the page shows the effect; the outline stays the original
    assert reading["decisions"][1]["decision"] == "accept"


def test_only_grammar_items_name_their_heading() -> None:
    assert heading_id_of("g_b42") == "b42" and heading_id_of("g_epic") is None and heading_id_of("bl_7") is None


def test_the_study_response_carries_the_reading(tmp_path) -> None:
    from app.main import _prestudy_response

    doc = _doc("pdf", str(tmp_path))
    response = _prestudy_response(doc, _study(doc), "model", [])
    assert response.details is not None and response.details["reading"]["requirements"] == 121
