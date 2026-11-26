"""The document grammar: the requirement-code shape is learned from the document (never assumed), the pre-study's answer is checked
against the document part by part and voted, and the rulebook keeps it (with the hash of a rulebook stored before it unchanged)."""

from __future__ import annotations

import sys
from functools import cache
from pathlib import Path

import pytest

from app.leveling.code_shape import CodeShape, learn_code_shape, token_shape
from app.leveling.document_grammar import learn_grammar
from app.leveling.tree_builder import build_baseline_tree
from app.loaders.pdf_loader import load_pdf
from app.study.model_rules import (
    document_headings,
    document_sample,
    validate_document_answer,
    vote_documents,
)
from app.study.rulebook import DocumentRules, FileRulebook, rulebook_from_json, rulebook_to_json

sys.path.insert(0, str(Path(__file__).parent / "fixtures"))
from build_twin_spec_fixture import build_twin_spec_pdf  # noqa: E402

# --- code shape -------------------------------------------------------------------------------------------------------------------------


def test_token_shapes() -> None:
    assert token_shape("abc_12") == "a_9"
    assert token_shape("REQ-001") == "A-9"
    assert token_shape("SYS_12.1") == "A_9.9"


def test_the_shape_is_induced_from_examples_and_read_only_at_the_start() -> None:
    shape = CodeShape.from_examples(["gen_2", "pwr_14", "bat_3"])
    assert shape is not None and shape.shape == "a_9"
    assert shape.leading("pwr_104 The unit shall start.") == ("pwr_104", "The unit shall start.")
    assert shape.leading("REQ-001: The unit shall start.") is None
    assert shape.leading("The unit uses gen_2 when idle.") is None
    assert CodeShape.from_examples(["gen_2", "REQ-001"]) is None  # two shapes are not one code


def test_the_dominant_leading_shape_is_learned_and_tokens_inside_text_or_trace_lists_are_not() -> None:
    texts = [f"cfm_{n} The unit shall heat the water to KLX{4400 + n} grade within {n} s." for n in range(1, 9)]
    texts += ["SYS_12 SYS_13", "GCS_4", "Z1: +5 to +40 C"]
    shape = learn_code_shape(texts)
    assert shape is not None and shape.shape == "a_9"
    assert learn_code_shape(["The unit shall start.", "The unit shall stop."]) is None


def test_a_separator_style_code_is_learned_too() -> None:
    shape = learn_code_shape([f"REQ-{n:03d}: The PDU shall do thing number {n}." for n in range(1, 7)])
    assert shape is not None and shape.opens("REQ-120: The PDU shall stop.")


# --- the pre-study's answer, checked and voted -------------------------------------------------------------------------------------------


@pytest.fixture(scope="module")
def twin(tmp_path_factory):
    path, _truth = build_twin_spec_pdf(tmp_path_factory.mktemp("grammar"))
    return _load(str(path))


@cache
def _load(path: str):
    return load_pdf(path)


def _i(headings: list[dict], number: str) -> int:
    return next(h["i"] for h in headings if h["number"] == number)


def _answer(**grammar) -> dict:
    return {
        "type_source": "none",
        "labels": [],
        "depth_types": [],
        "evidence_headings": [],
        "front_matter_headings": [],
        "requirement_codes": [],
        "leaf_convention": "unknown",
        "empty_sections": "unknown",
        "context_headings": [],
        "back_matter_headings": [],
        **grammar,
    }


def test_the_sample_shows_the_code_candidates_and_what_each_section_holds(twin) -> None:
    sample = document_sample(twin)
    assert sample["codeCandidates"][0]["shape"] == "a_9"
    by_number = {h["number"]: h for h in sample["headings"]}
    assert by_number["2.2.1.5"]["marker"] == "None."
    assert by_number["2.2.1.1"]["coded"] == 2


def test_each_grammar_part_is_checked_against_the_document(twin) -> None:
    headings = document_headings(twin)
    good = validate_document_answer(
        _answer(
            requirement_codes=["gen_2", "enc_1", "mec_3"],
            leaf_convention="heading_is_requirement",
            empty_sections="leave_out",
            context_headings=[_i(headings, "1.1"), _i(headings, "2.1.1")],  # 2.1.1 holds a coded requirement: refused
            back_matter_headings=[_i(headings, "3"), _i(headings, "2.4")],  # 2.4 holds requirements: refused
        ),
        headings,
        twin,
    )
    assert isinstance(good, DocumentRules)
    assert good.requirement_codes == ("enc_1", "gen_2", "mec_3")
    assert good.leaf_convention == "heading_is_requirement" and good.empty_treatment == "leave_out"
    ids = {h["i"]: h["block_id"] for h in headings}
    assert good.context_headings == (ids[_i(headings, "1.1")],)
    assert good.back_matter_headings == (ids[_i(headings, "3")],)

    parent_codes = validate_document_answer(_answer(requirement_codes=["GCS_9", "SYS_45"]), headings, twin)
    assert isinstance(parent_codes, str)  # codes that never open a requirement are not the code, and nothing else was named


def test_the_grammar_is_voted_part_by_part() -> None:
    a = DocumentRules(requirement_codes=("gen_2", "enc_1"), leaf_convention="feature_and_requirement", context_headings=("b1",))
    b = DocumentRules(requirement_codes=("mec_3", "enc_1"), leaf_convention="feature_and_requirement", context_headings=("b1", "b9"))
    c = DocumentRules(requirement_codes=("GCS_9", "SYS_4"), leaf_convention="heading_is_requirement")
    voted = vote_documents([a, b, c])
    assert voted.requirement_codes == ("enc_1", "gen_2", "mec_3")
    assert voted.leaf_convention == "feature_and_requirement"
    assert voted.context_headings == ("b1",)


def test_the_rulebook_keeps_the_grammar_and_an_older_rulebook_keeps_its_hash() -> None:
    plain = FileRulebook(document=DocumentRules(depth_types=((0, "Epic"),)))
    assert "grammar" not in plain.canonical()["document"]
    rich = FileRulebook(document=DocumentRules(requirement_codes=("gen_2", "enc_1"), empty_treatment="leave_out", back_matter_headings=("b9",)))
    again = rulebook_from_json(rulebook_to_json(rich))
    assert again.document == rich.document and again.hash == rich.hash
    with pytest.raises(ValueError):
        rulebook_from_json({"document": {"grammar": {"leaf_convention": "sideways"}}})


def test_a_learned_convention_changes_the_tree(twin) -> None:
    rulebook = FileRulebook(document=DocumentRules(requirement_codes=("gen_2", "enc_1", "mec_3"), leaf_convention="heading_is_requirement"))
    grammar = learn_grammar(twin, rulebook)
    assert grammar is not None and grammar.source == "model"
    nodes = build_baseline_tree(twin, rulebook).nodes
    product_family = next(n for n in nodes if n.title.startswith("2.1.1"))
    assert product_family.type.value == "Requirement" and product_family.customer_id == "gen_2"


def test_a_file_whose_headings_state_their_types_keeps_them(twin) -> None:
    from app.study.rulebook import LabelRule

    rulebook = FileRulebook(document=DocumentRules(labels=(LabelRule("Feature", ":", "Feature"),)))
    assert learn_grammar(twin, rulebook) is None


def test_a_rewrite_never_adds_an_obligation_to_a_statement_without_one() -> None:
    from app.leveling.content_authoring import value_problems
    from app.leveling.document_grammar import invents_obligation

    assert invents_obligation("The service life shall be 12 years.", "The service life is 12 years.")
    assert invents_obligation("The system shall support interchangeability.", "None.")
    assert not invents_obligation("The unit shall run a power-up test.", "Power-up test")  # a heading may be synthesized
    assert not invents_obligation("The unit shall start in 2 s.", "The unit will start within 2 s.")
    assert "added obligation" in value_problems("The life shall be 12 years.", "The life is 12 years.", ["The life is 12 years."], keep=True)


def test_grammar_items_are_never_rewritten(twin) -> None:
    from app.leveling.content_authoring import _authorable

    nodes = build_baseline_tree(twin).nodes
    assert nodes and all(n.verbatim and not _authorable(n) for n in nodes)


def test_the_vote_does_not_depend_on_the_order_the_answers_arrive_in() -> None:
    from itertools import permutations

    answers = [
        DocumentRules(requirement_codes=("gen_2", "enc_1"), empty_treatment="leave_out", back_matter_headings=("b9",)),
        DocumentRules(requirement_codes=("mec_3",), empty_treatment="empty_feature", back_matter_headings=("b9",)),
        DocumentRules(requirement_codes=("enc_1", "bat_3"), empty_treatment="leave_out", context_headings=("b2",)),
    ]
    results = {FileRulebook(document=vote_documents(list(order))).hash for order in permutations(answers)}
    assert len(results) == 1


# --- what the grammar must never do to other documents (review findings) ---------------------------------------------------------------


def _md(tmp_path: Path, text: str):
    from app.loaders.text_loader import load_markdown

    path = tmp_path / "spec.md"
    path.write_text(text, encoding="utf-8")
    return load_markdown(str(path))


def _spec(extra: str = "", intro: str = "") -> str:
    reqs = "\n\n".join(f"REQ-{n:03d}: The unit shall perform function number {n} within {n} s." for n in range(1, 7))
    return f"# 1 Introduction\n\nThis document is about the unit.\n\n# 2 Requirements\n\n## 2.1 Power\n\n{intro}{reqs}\n\n## 2.2 Data\n\nREQ-007: The unit shall log every event.\n{extra}"


def _by_title(nodes, prefix: str):
    return [n for n in nodes if n.title.startswith(prefix)]


def test_an_unnumbered_appendix_is_its_own_section_not_part_of_the_last_requirement(tmp_path: Path) -> None:
    nodes = build_baseline_tree(_md(tmp_path, _spec("\n# Appendix A Glossary\n\nA unit is a box.\n"))).nodes
    last = next(n for n in nodes if n.customer_id == "REQ-007")
    assert "Glossary" not in last.description and "A unit is a box." not in last.description


def test_a_mostly_unnumbered_document_is_built_as_before(tmp_path: Path) -> None:
    text = "# 1 Scope\n\nx\n\n# Power\n\n## Supply\n\n## Rails\n\n## Test\n\n# Data\n\n" + "\n\n".join(
        f"REQ-{n:03d}: The unit shall do {n} things now." for n in range(1, 7)
    )
    assert learn_grammar(_md(tmp_path, text)) is None


def test_an_intro_sentence_and_a_list_continuation_are_never_requirements_of_their_own(tmp_path: Path) -> None:
    text = _spec(intro="The following requirements shall apply to every unit built.\n\n") + (
        "\n\n## 2.3 Output\n\nREQ-008: The unit shall support the rails below:\n\n- 5 V rail\n\nThe output shall be isolated from ground.\n"
    )
    nodes = build_baseline_tree(_md(tmp_path, text)).nodes
    requirements = [n for n in nodes if n.type.value == "Requirement"]
    assert all(n.customer_id for n in requirements), [n.title for n in requirements if not n.customer_id]
    assert "isolated from ground" in next(n for n in requirements if n.customer_id == "REQ-008").description


def test_a_listing_that_repeats_the_codes_is_back_matter_not_a_second_copy(tmp_path: Path) -> None:
    listing = "\n# 3 Traceability\n\n" + "\n\n".join(f"REQ-{n:03d} Function number {n} of the unit" for n in range(1, 8))
    nodes = build_baseline_tree(_md(tmp_path, _spec(listing))).nodes
    ids = [n.customer_id for n in nodes if n.customer_id]
    assert len(ids) == len(set(ids)) == 7
    assert not _by_title(nodes, "3 Traceability")


def test_values_with_units_are_never_a_code_shape() -> None:
    lines = [f"{v}V rail shall supply the load within its limits." for v in (5, 12, 24, 28, 48, 3)]
    assert learn_code_shape(lines) is None


def test_depth_types_from_the_pre_study_keep_their_types(twin) -> None:
    rulebook = FileRulebook(document=DocumentRules(depth_types=((0, "Epic"), (1, "Feature"))))
    assert learn_grammar(twin, rulebook) is None


def test_only_markers_are_guarded_against_an_added_obligation() -> None:
    from app.leveling.document_grammar import invents_obligation

    assert not invents_obligation("The system shall provide a mounting bracket.", "Provide a mounting bracket for the unit.")
    assert invents_obligation("The system shall be interchangeable.", "Not applicable.")


def test_form_labels_repeated_on_every_page_are_not_furniture() -> None:
    from app.loaders.pdf_loader import _furniture_candidate

    assert not _furniture_candidate({"text": "Rationale:", "top": 400, "bottom": 410}, 792)
    assert not _furniture_candidate({"text": "Verification text line", "top": 400, "bottom": 410}, 792)  # mid-page
    assert _furniture_candidate({"text": "NOT EXPORT CONTROLLED", "top": 120, "bottom": 128}, 792)


def test_left_out_parts_from_the_pre_study_and_the_grammar_are_merged_in_document_order() -> None:
    from app.leveling.document_layout import FrontMatter, with_left_out_sections

    front = FrontMatter(parts=[("COVER", 1, 1), ("1.3 REVISION HISTORY", 3, 3), ("1.5 ABBREVIATIONS", 3, 5)])
    merged = with_left_out_sections(front, [("1.4 REFERENCES", 3, 3), ("3 IDENTITIES", 28, 31)])
    assert [p[0] for p in merged.parts] == ["COVER", "1.3 REVISION HISTORY", "1.4 REFERENCES", "1.5 ABBREVIATIONS", "3 IDENTITIES"]
