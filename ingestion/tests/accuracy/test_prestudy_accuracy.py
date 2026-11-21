"""The model-assisted pre-study on files whose conventions the code's own header detectors do not know (Hebrew headings, a Level column, Key/Parent with
Kind=Group/Item, an outline number, Hebrew heading labels): the model names the conventions, code validates them against the whole file and builds
the items, and the same file gives the same tree every time."""

from __future__ import annotations

import copy

import pytest

from app.dispatch import dispatch_by_extension
from app.leveling.llm_leveling import build_survey_tree
from app.leveling.tree_builder import build_baseline_tree
from app.study.file_rules import study_tables
from app.study.model_rules import prestudy, validate_document_answer, validate_table_answer
from app.workitem.model import WarningKind

from ..test_structure_contract import SimulatedGrouper, StructureRefusingClient, TitleHashEmbedder
from .fake_model import TABLE_ANSWERS, FakeStudyClient
from .scorecard import score
from .variants import UNKNOWN_VARIANTS


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    out = tmp_path_factory.mktemp("unknown_variants")
    return {v.name: v.build(out) for v in UNKNOWN_VARIANTS}


def _doc(built, name):
    path = built[name]
    return dispatch_by_extension(path.name, str(path))


def _shape(tree):
    return [(n.local_id, n.type.value, n.parent_local_id, n.title, n.description, n.customer_id) for n in tree.nodes]


@pytest.mark.parametrize("variant", UNKNOWN_VARIANTS, ids=lambda v: v.name)
def test_without_the_model_the_code_cannot_read_these_conventions(variant, built) -> None:
    """The gap the pre-study closes: the file is not read by its own rules."""
    doc = _doc(built, variant.name)
    result = score(build_baseline_tree(doc), rich=False)
    assert result.problems() or result.produced != result.expected


@pytest.mark.parametrize("variant", UNKNOWN_VARIANTS, ids=lambda v: v.name)
def test_with_the_models_rulebook_every_item_has_the_type_and_parent_the_file_states(variant, built) -> None:
    doc = _doc(built, variant.name)
    rulebook, warnings = prestudy(doc, FakeStudyClient(), votes=3)
    assert not rulebook.is_empty()
    assert [w.kind for w in warnings] == [WarningKind.PRESTUDY_APPLIED]
    result = score(build_baseline_tree(doc, rulebook), rich=False)
    assert not result.problems(), result.summary()
    assert result.produced == result.expected, result.summary()


@pytest.mark.parametrize("variant", UNKNOWN_VARIANTS, ids=lambda v: v.name)
def test_the_same_file_gives_the_same_rulebook_and_tree_whatever_the_model_varies(variant, built) -> None:
    """A noisy model reorders columns and values, changes the spacing and case of copied headings and says "unknown" where "not_imported" means the same."""
    doc = _doc(built, variant.name)
    reference_rulebook, _ = prestudy(doc, FakeStudyClient(), votes=3)
    reference = _shape(build_baseline_tree(doc, reference_rulebook))
    for seed in range(6):
        rulebook, _ = prestudy(doc, FakeStudyClient(noisy=True, seed=seed), votes=3)
        assert rulebook.hash == reference_rulebook.hash
        assert _shape(build_baseline_tree(doc, rulebook)) == reference


@pytest.mark.parametrize("variant", [v for v in UNKNOWN_VARIANTS if not v.document], ids=lambda v: v.name)
def test_survey_builds_the_stated_structure_and_says_what_the_model_learned(variant, built) -> None:
    class Client(FakeStudyClient, StructureRefusingClient):
        pass

    doc = _doc(built, variant.name)
    tree = build_survey_tree(
        doc,
        Client(),
        grouping_client=SimulatedGrouper(1),
        embed_client=TitleHashEmbedder(),
    )
    result = score(tree, rich=False)
    assert not result.problems(), result.summary()
    assert result.produced == result.expected, result.summary()
    kinds = [w.kind for w in tree.warnings]
    assert WarningKind.PRESTUDY_APPLIED in kinds and WarningKind.RULEBOOK_MISMATCH not in kinds


def test_survey_reads_a_document_by_the_labels_the_model_found(built) -> None:
    class Client(FakeStudyClient, StructureRefusingClient):
        pass

    tree = build_survey_tree(
        _doc(built, "docx_hebrew_labels"),
        Client(),
        grouping_client=SimulatedGrouper(1),
        embed_client=TitleHashEmbedder(),
    )
    result = score(tree, rich=False)
    assert not result.problems(), result.summary()
    assert result.produced == result.expected, result.summary()


# --- voting ------------------------------------------------------------------------------------------------------------------------------------


def _with_check_as_requirement(answer: dict) -> dict:
    answer = copy.deepcopy(answer)
    for item in answer["type_values"]:
        if item["value"] == "Check":
            item["maps_to"] = "Requirement"
    return answer


def _group_as_requirement(answer: dict) -> dict:
    answer = copy.deepcopy(answer)
    for item in answer["type_values"]:
        item["maps_to"] = "Requirement" if item["value"] == "Group" else item["maps_to"]
    return answer


def test_one_valid_answer_that_disagrees_is_outvoted(built) -> None:
    doc = _doc(built, "xlsx_kind_parent")
    reference, _ = prestudy(doc, FakeStudyClient(), votes=3)
    outvoted, _ = prestudy(doc, FakeStudyClient(dissent={2: _with_check_as_requirement}), votes=3)
    assert outvoted.hash == reference.hash


def test_an_answer_that_inverts_the_ladder_is_refused_and_the_other_two_decide(built) -> None:
    doc = _doc(built, "xlsx_kind_parent")
    reference, _ = prestudy(doc, FakeStudyClient(), votes=3)
    rulebook, warnings = prestudy(doc, FakeStudyClient(dissent={1: _group_as_requirement}), votes=3)
    assert rulebook.hash == reference.hash
    assert [w.kind for w in warnings] == [WarningKind.PRESTUDY_APPLIED]


def test_two_answers_that_are_unusable_leave_the_file_on_the_deterministic_path(built) -> None:
    doc = _doc(built, "xlsx_kind_parent")
    client = FakeStudyClient(dissent={0: _group_as_requirement, 1: _group_as_requirement})
    rulebook, warnings = prestudy(doc, client, votes=3)
    assert rulebook.is_empty()
    assert [w.kind for w in warnings] == [WarningKind.PRESTUDY_REJECTED]
    assert _shape(build_baseline_tree(doc, rulebook)) == _shape(build_baseline_tree(doc))


def test_a_model_that_fails_costs_a_warning_and_never_a_different_tree(built) -> None:
    doc = _doc(built, "xlsx_hebrew")
    rulebook, warnings = prestudy(doc, FakeStudyClient(fail=RuntimeError("proxy down")), votes=3)
    assert rulebook.is_empty()
    assert [w.kind for w in warnings] == [WarningKind.PRESTUDY_REJECTED]
    assert _shape(build_baseline_tree(doc, rulebook)) == _shape(build_baseline_tree(doc))


# --- answers that must be refused -----------------------------------------------------------------------------------------------------------------


def _kind_table(built):
    doc = _doc(built, "xlsx_kind_parent")
    return doc.tables[0], TABLE_ANSWERS[("Key", "Parent", "Summary", "Kind", "Text")]


def _mutated(built, change):
    table, answer = _kind_table(built)
    answer = copy.deepcopy(answer)
    change(answer)
    return validate_table_answer(answer, table)


@pytest.mark.parametrize(
    "name,change",
    [
        ("a column that is not in the table", lambda a: a["columns"][2].update(column=99)),
        ("a heading that is not the column's", lambda a: a["columns"][2].update(header="Invented")),
        ("a type value left unmapped", lambda a: a["type_values"].pop(1)),
        ("a table that is not work items", lambda a: a.update(sheet_kind="not_work_items")),
        ("no header row", lambda a: a.update(header_row=None)),
        ("two roles for one column", lambda a: a["columns"].append(dict(a["columns"][0]))),
        ("parent links without a parent column", lambda a: a["columns"].pop(1)),
        ("a nesting the columns cannot give", lambda a: a.update(nesting="level_columns")),
        ("every type inverted", lambda a: [i.update(maps_to="Requirement") for i in a["type_values"][:3]]),
        ("a type mapped two ways", lambda a: a["type_values"].append({"value": "item", "maps_to": "Epic", "basis": "none"})),
    ],
)
def test_an_answer_that_does_not_fit_the_table_is_refused(name, change, built) -> None:
    assert isinstance(_mutated(built, change), str), name


def test_the_correct_answer_is_accepted(built) -> None:
    table, answer = _kind_table(built)
    assert not isinstance(validate_table_answer(answer, table), str)


def _headings():
    return [
        {"i": i, "level": level, "depth": level - 1, "number": None, "text": text}
        for i, (level, text) in enumerate(
            [(1, "אפיק: א"), (2, "יכולת: ב"), (3, "דרישה: ג"), (3, "דרישה: ד"), (2, "יכולת: ה"), (3, "דרישה: ו"), (2, "יכולת: ז"), (3, "דרישה: ח")]
        )
    ]


def _label(label, maps_to, separator=":"):
    return {"label": label, "separator": separator, "maps_to": maps_to, "basis": "translation", "example_headings": [0]}


def _doc_answer(**changes):
    answer = {"type_source": "labels", "labels": [_label("יכולת", "Feature"), _label("דרישה", "Requirement")], "depth_types": [], "evidence_headings": [0]}
    answer.update(changes)
    return answer


def test_a_label_the_model_names_must_begin_at_least_three_headings() -> None:
    rules = validate_document_answer(_doc_answer(labels=[_label("יכולת", "Feature"), _label("דרישה", "Requirement"), _label("אפיק", "Epic")]), _headings())
    assert not isinstance(rules, str)
    assert {r.label for r in rules.labels} == {"יכולת", "דרישה"}  # "אפיק" begins one heading only: not a convention


def test_labels_that_contradict_the_nesting_are_refused() -> None:
    swapped = _doc_answer(labels=[_label("יכולת", "Requirement"), _label("דרישה", "Feature")])
    assert isinstance(validate_document_answer(swapped, _headings()), str)


def test_depth_types_must_go_down_the_ladder_and_name_real_depths() -> None:
    inverted = _doc_answer(labels=[], depth_types=[{"depth": 0, "maps_to": "Requirement"}, {"depth": 1, "maps_to": "Epic"}])
    assert isinstance(validate_document_answer(inverted, _headings()), str)
    absent = _doc_answer(labels=[], depth_types=[{"depth": 7, "maps_to": "Requirement"}])
    assert isinstance(validate_document_answer(absent, _headings()), str)


def test_table_conventions_the_code_recognises_are_not_asked_of_the_model(built, tmp_path) -> None:
    from tests.accuracy.variants import build_csv

    path = build_csv(tmp_path)
    doc = dispatch_by_extension(path.name, str(path))
    assert study_tables(doc)
    client = FakeStudyClient()
    rulebook, warnings = prestudy(doc, client, votes=3)
    assert client.calls == [] and rulebook.is_empty() and warnings == []
