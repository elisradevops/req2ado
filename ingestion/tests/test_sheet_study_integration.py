"""A spreadsheet through the deterministic-subtree detector: every row of a studied sheet becomes an item, and nothing else changes."""

from openpyxl import Workbook

from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef
from app.leveling.llm_leveling import _detect_deterministic_subtrees
from app.loaders.xlsx_loader import load_xlsx
from app.workitem.model import WarningKind


class TitleTags:
    def title_and_tags_for_rows(self, texts, user_id=None):  # noqa: ANN001, ANN201
        return {k: {"title": f"T {k}", "tags": []} for k in texts}


class Synthesis:
    def synthesize_leaf_requirements(self, items, user_id=None):  # noqa: ANN001, ANN201
        return {k: {"title": "S", "text": v["text"], "tags": []} for k, v in items.items()}


class Parents:
    def summarize_parent_nodes(self, nodes, user_id=None):  # noqa: ANN001, ANN201
        return {k: {"title": "P", "description": "summary"} for k in nodes}


ANSWER = {
    "kind": "requirements_list",
    "summary": "A requirements list.",
    "header_rows": 1,
    "id_column": 0,
    "title_column": 2,
    "text_columns": [3],
    "group_columns": [1],
}


class Studier:
    def __init__(self, answer=ANSWER, error=None):
        self.answer, self.error, self.calls = answer, error, 0

    def study_spreadsheet(self, sample, user_id=None):  # noqa: ANN001, ANN201
        self.calls += 1
        if self.error:
            raise self.error
        return self.answer


def workbook(tmp_path, rows):
    book = Workbook()
    sheet = book.active
    sheet.title = "Reqs"
    for row in rows:
        sheet.append(row)
    path = tmp_path / "book.xlsx"
    book.save(path)
    return load_xlsx(str(path))


def rows(n):
    return [["ID", "Section", "Requirement", "Priority"]] + [
        [f"R{i:04d}", f"Section {i % 5}", f"The unit shall do thing {i}.", "High"] for i in range(n)
    ]


def detect(doc, studier):
    return _detect_deterministic_subtrees(doc, TitleTags(), Synthesis(), Parents(), sheet_study_client=studier)


def test_a_2000_row_sheet_becomes_2000_items_from_one_model_call(tmp_path) -> None:
    doc = workbook(tmp_path, rows(2000))
    studier = Studier()

    nodes, warnings, rest = detect(doc, studier)

    requirements = [n for n in nodes if n.type == "Requirement"]
    assert len(requirements) == 2000
    assert studier.calls == 1
    assert requirements[1999].description == "The unit shall do thing 1999.\nPriority: High"
    assert requirements[1999].customer_id == "R1999"
    # The table is fully represented by its items: nothing is left for the model-driven path to read (or truncate).
    assert rest.tables == []


def test_the_items_form_a_valid_tree_with_the_sheet_on_top_and_its_sections_between(tmp_path) -> None:
    nodes, _w, _rest = detect(workbook(tmp_path, rows(50)), Studier())

    by_id = {n.local_id: n for n in nodes}
    roots = [n for n in nodes if n.parent_local_id is None]
    assert [(n.type, n.title) for n in roots] == [("Epic", "P")]
    sections = [n for n in nodes if n.type == "Feature"]
    assert len(sections) == 5 and all(by_id[n.parent_local_id].type == "Epic" for n in sections)
    assert all(by_id[n.parent_local_id].type == "Feature" for n in nodes if n.type == "Requirement")


def test_no_node_carries_the_whole_sheet_in_its_description(tmp_path) -> None:
    nodes, _w, _rest = detect(workbook(tmp_path, rows(200)), Studier())

    assert all("<table" not in n.description for n in nodes)
    assert all(n.table_ids == [] for n in nodes)
    assert max(len(n.description) for n in nodes) < 200


def test_the_reviewer_is_told_which_columns_the_model_chose(tmp_path) -> None:
    nodes, warnings, _rest = detect(workbook(tmp_path, rows(10)), Studier())

    (mapped,) = [w for w in warnings if w.kind == WarningKind.SPREADSHEET_MAPPED]
    assert mapped.node_ids == [nodes[0].local_id]
    assert mapped.detail["rows"] == 10 and mapped.detail["id"] == "ID" and mapped.detail["title"] == "Requirement"
    assert mapped.detail["text"] == ["Priority"] and mapped.detail["sections"] == ["Section"]
    assert "10 rows became items" in mapped.raw and "Check them against the sheet" in mapped.raw


def test_a_sheet_the_model_will_not_map_stays_where_it_was_with_a_warning(tmp_path) -> None:
    doc = workbook(tmp_path, rows(20))

    nodes, warnings, rest = detect(doc, Studier(answer={**ANSWER, "kind": "other"}))

    assert nodes == [] and len(rest.tables) == 1
    (not_mapped,) = [w for w in warnings if w.kind == WarningKind.SPREADSHEET_NOT_MAPPED]
    assert "something other than a list of requirements" in not_mapped.raw
    assert not_mapped.detail["sheet"] == "Reqs"


def test_a_failing_model_leaves_the_sheet_on_the_model_driven_path_with_a_warning(tmp_path) -> None:
    nodes, warnings, rest = detect(workbook(tmp_path, rows(20)), Studier(error=RuntimeError("model down")))

    assert nodes == [] and len(rest.tables) == 1
    assert [w.kind for w in warnings] == [WarningKind.SPREADSHEET_NOT_MAPPED]


def test_without_a_study_client_a_spreadsheet_is_exactly_as_before(tmp_path) -> None:
    doc = workbook(tmp_path, rows(20))

    nodes, warnings, rest = _detect_deterministic_subtrees(doc, TitleTags(), Synthesis(), Parents())

    assert nodes == [] and warnings == [] and len(rest.tables) == 1


def test_only_spreadsheets_are_studied(tmp_path) -> None:
    doc = CanonicalDoc(
        document=Document(path="x.docx", format=DocumentFormat.DOCX, sha256="x"),
        blocks=[
            Block(id="p0", kind=BlockKind.PARAGRAPH, text="The unit shall run.", source_ref=SourceRef(document_path="x.docx", start_offset=0, end_offset=1))
        ],
    )
    studier = Studier()

    detect(doc, studier)

    assert studier.calls == 0


def test_a_sheet_the_id_convention_already_reads_is_not_sent_to_the_model(tmp_path) -> None:
    book = [["ID", "Text"], ["1", "Power"], ["1.1", "The unit shall start."], ["1.2", "The unit shall stop."]]
    studier = Studier()

    nodes, _w, _rest = detect(workbook(tmp_path, book), studier)

    assert nodes and studier.calls == 0


def test_build_survey_tree_maps_every_row_of_a_sheet_without_a_structure_call(tmp_path) -> None:
    from app.leveling.llm_leveling import build_survey_tree
    from tests.test_llm_leveling import FakeSectionAnalysisClient

    class SheetAwareClient(FakeSectionAnalysisClient):
        calls_to_study = 0

        def study_spreadsheet(self, sample, user_id=None):  # noqa: ANN001, ANN201
            type(self).calls_to_study += 1
            return ANSWER

    client = SheetAwareClient()

    tree = build_survey_tree(workbook(tmp_path, rows(2000)), client)

    requirements = [n for n in tree.nodes if n.type == "Requirement"]
    assert len(requirements) == 2000
    assert SheetAwareClient.calls_to_study == 1
    # The model-driven structure call never ran: the sheet was fully represented before it.
    assert client.calls == [] and client.agentic_calls == []
    assert any(w.kind == WarningKind.SPREADSHEET_MAPPED for w in tree.warnings)
    assert not any(w.kind == WarningKind.OUTPUT_TRUNCATED for w in tree.warnings)
