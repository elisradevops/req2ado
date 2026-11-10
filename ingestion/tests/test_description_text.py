"""description_for_model: the text a model reads for a work item's description.

The stored description is rich HTML (the ADO System.Description field, with tables as <table> markup, or pasted from Word/Excel). A model
graded the markup together with the content, so what it is sent is plain text with every table as CSV: all rows, one line each."""
from app.canonical.model import SourceRef, Table, TableCell
from app.leveling.description_text import description_for_model
from app.leveling.tree_builder import _table_to_html


def test_text_without_html_is_returned_unchanged() -> None:
    for text in ("", "The receiver shall lock within 2 s.", "# Title\n\n- one\n- two\n\n**bold** and `code`", "if x <10 and y> 5 then lock"):
        assert description_for_model(text) == text


def test_an_unknown_tag_like_text_is_kept() -> None:
    assert description_for_model("The <value> shall be reported.") == "The <value> shall be reported."


def test_a_table_becomes_csv_with_its_header_and_every_row() -> None:
    html = "<table><thead><tr><th>Rail</th><th>Voltage</th></tr></thead><tbody><tr><td>VDD</td><td>3.3</td></tr><tr><td>VIO</td><td>1.8</td></tr></tbody></table>"
    assert description_for_model(html) == "Table (CSV):\nRail,Voltage\nVDD,3.3\nVIO,1.8"


def test_a_table_without_a_header_row_gets_no_invented_header() -> None:
    assert description_for_model("<table><tr><td>VDD</td><td>3.3</td></tr><tr><td>VIO</td><td>1.8</td></tr></table>") == "Table (CSV):\nVDD,3.3\nVIO,1.8"


def test_the_caption_is_kept_and_cells_are_quoted_when_needed() -> None:
    html = '<table><caption>Power rails</caption><tr><th>Name</th><th>Note</th></tr><tr><td>VDD, core</td><td>said "ok"<br>twice</td></tr></table>'
    assert description_for_model(html) == 'Table (CSV): Power rails\nName,Note\n"VDD, core","said ""ok"" twice"'


def test_colspan_and_rowspan_repeat_the_owning_cell_so_every_row_stands_alone() -> None:
    html = (
        "<table><tr><th>Group</th><th>Item</th><th>Value</th></tr>"
        '<tr><td rowspan="2">Power</td><td>VDD</td><td>3.3</td></tr><tr><td>VIO</td><td>1.8</td></tr>'
        '<tr><td colspan="2">Total</td><td>5.1</td></tr></table>'
    )
    assert description_for_model(html) == "Table (CSV):\nGroup,Item,Value\nPower,VDD,3.3\nPower,VIO,1.8\nTotal,Total,5.1"


def test_several_header_rows_become_one_label_per_column() -> None:
    html = (
        '<table><thead><tr><th colspan="2">Supply</th><th>Limit</th></tr><tr><th>Name</th><th>Typ</th><th>Max</th></tr></thead>'
        "<tbody><tr><td>VDD</td><td>3.3</td><td>3.6</td></tr></tbody></table>"
    )
    assert description_for_model(html) == "Table (CSV):\nSupply / Name,Supply / Typ,Limit / Max\nVDD,3.3,3.6"


def test_a_blank_spacer_row_is_dropped_but_a_gap_inside_a_row_is_kept() -> None:
    html = "<table><tr><td>a</td><td></td></tr><tr><td></td><td></td></tr><tr><td>b</td><td>c</td></tr></table>"
    assert description_for_model(html) == "Table (CSV):\na,\nb,c"


def test_no_row_is_ever_dropped_for_size() -> None:
    rows = "".join(f"<tr><td>R{i}</td><td>{i}</td></tr>" for i in range(500))
    lines = description_for_model(f"<table>{rows}</table>").split("\n")
    assert lines[0] == "Table (CSV):" and len(lines) == 501 and lines[-1] == "R499,499"


def test_the_table_the_pipeline_itself_renders_is_converted() -> None:
    table = Table(
        id="t0", caption="Rails", cells=[[TableCell(text="Rail", is_header=True), TableCell(text="V", is_header=True)], [TableCell(text="VDD"), TableCell(text="3.3")]],
        source_ref=SourceRef(document_path="x.docx", start_offset=0, end_offset=1),
    )
    assert description_for_model(_table_to_html(table)) == "Table (CSV): Rails\nRail,V\nVDD,3.3"


def test_prose_around_tables_is_kept_and_each_table_is_converted() -> None:
    html = "The rails are:\n\n<table><tr><td>VDD</td><td>3.3</td></tr></table>\n\nand the limits:\n\n<table><tr><td>T</td><td>85</td></tr></table>\n\nEnd."
    assert description_for_model(html) == "The rails are:\n\nTable (CSV):\nVDD,3.3\n\nand the limits:\n\nTable (CSV):\nT,85\n\nEnd."


def test_a_nested_table_is_flattened_into_its_cell() -> None:
    html = "<table><tr><td>Outer</td><td><table><tr><td>in1</td><td>in2</td></tr></table></td></tr></table>"
    assert description_for_model(html) == "Table (CSV):\nOuter,in1 in2"


def test_rich_text_from_ado_becomes_plain_text() -> None:
    html = "<div><p>The <strong>receiver</strong> shall:</p><ul><li>lock &amp; report</li><li>recover</li></ul><p>Done<br>now</p></div><script>x()</script>"
    assert description_for_model(html) == "The receiver shall:\n\n- lock & report\n- recover\n\nDone\nnow"


def test_word_and_excel_paste_markup_is_dropped() -> None:
    html = (
        '<!--[if gte mso 9]><xml>x</xml><![endif]--><table class=MsoTableGrid style="mso-table-lspace:9pt">'
        '<tr><td style="mso-border-alt:solid"><p class=MsoNormal><span style="font-size:10pt">Lock<o:p></o:p></span></p></td><td><font color="red">2 s</font></td></tr></table>'
    )
    assert description_for_model(html) == "Table (CSV):\nLock,2 s"


def test_the_result_is_deterministic_and_converting_it_again_changes_nothing() -> None:
    html = "<p>x</p><table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>"
    once = description_for_model(html)
    assert description_for_model(html) == once and description_for_model(once) == once


TABLE_DESCRIPTION = "Use:\n\n<table><tr><th>Rail</th><th>V</th></tr><tr><td>VDD</td><td>3.3</td></tr></table>"
AS_TEXT = "Use:\n\nTable (CSV):\nRail,V\nVDD,3.3"


def test_with_the_flag_off_a_description_is_sent_as_it_is(monkeypatch) -> None:
    monkeypatch.setattr("app.leveling.description_text.settings.description_text_for_model_enabled", False)
    assert description_for_model(TABLE_DESCRIPTION) == TABLE_DESCRIPTION


def test_the_chat_table_listing_is_csv_even_with_the_flag_off(monkeypatch) -> None:
    from app.leveling.description_text import table_context

    monkeypatch.setattr("app.leveling.description_text.settings.description_text_for_model_enabled", False)
    assert "Table (CSV):\nRail,V" in table_context(["<table><tr><th>Rail</th><th>V</th></tr></table>"])


def test_the_cache_scope_changes_when_the_flag_is_off(monkeypatch) -> None:
    # Results built from raw HTML and results built from the text form must never be served for one another.
    from importlib import metadata

    from fastapi.testclient import TestClient

    from app.main import app

    version = metadata.version("req2ado-ingestion")
    client = TestClient(app)
    assert client.get("/cache-scope").json()["ingestion"] == version
    monkeypatch.setattr("app.leveling.description_text.settings.description_text_for_model_enabled", False)
    assert client.get("/cache-scope").json()["ingestion"] == f"{version}+html"


def test_the_criteria_retrieval_of_scoring_reads_the_text_form() -> None:
    from app.leveling.scoring import _build_criteria_context, score_texts_together
    from tests.test_scoring import _requirement_node

    seen: list[str] = []

    class Retriever:
        def retrieve(self, text):  # noqa: ANN001, ANN202
            seen.append(text)
            return []

    _build_criteria_context(Retriever(), [_requirement_node("r1", TABLE_DESCRIPTION)])  # type: ignore[arg-type]

    class Client:
        def score_requirements_for_document(self, descriptions, *a, **k):  # noqa: ANN001, ANN002, ANN003, ANN202
            return {key: {"score": 50, "issues": [], "categoryScores": {}} for key in descriptions}

    score_texts_together({"adhoc": TABLE_DESCRIPTION}, Client(), Retriever(), None, None)  # type: ignore[arg-type]
    assert seen == [AS_TEXT, AS_TEXT]


def test_the_kb_retrieval_of_a_rescore_reads_the_text_form(monkeypatch) -> None:
    import asyncio

    from app import main

    seen: list[str] = []
    monkeypatch.setattr(main, "_stored_profile_or_none", lambda user_id: None)
    monkeypatch.setattr(main, "retrieve_context", lambda user_id, text, embed, store: (seen.append(text), ("ctx", []))[1])
    assert asyncio.run(main._rescoring_kb_context("u1", TABLE_DESCRIPTION)) == "ctx"
    assert seen == [AS_TEXT]
