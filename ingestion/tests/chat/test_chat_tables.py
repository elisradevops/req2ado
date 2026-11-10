"""Chat and tables: the model READS every table (as CSV, to understand the item) but never writes one. The stored HTML of each table,
with its styling, is put back by code in whatever proposal the model makes, byte for byte."""
import json

import pytest

from app.chat.chat_client import PROPOSAL_SENTINEL
from app.chat.chat_service import run_chat_turn
from app.leveling.description_text import restore_tables, split_tables
from tests.chat.test_chat_service import _FakePublisher

STYLED = '<table style="border:1px solid #333;width:100%"><colgroup><col style="width:30%"><col></colgroup><tr><th style="background:#eee">Rail</th><th>V</th></tr><tr><td colspan="1">VDD</td><td>3.3</td></tr></table>'
OTHER = "<table><tr><td>T</td><td>85</td></tr></table>"
DESCRIPTION = f"The receiver shall use these rails:\n\n{STYLED}\n\nand obey the limits:\n\n{OTHER}\n\nEnd."


def test_each_outermost_table_becomes_a_numbered_marker_and_is_kept_untouched() -> None:
    text, tables = split_tables(DESCRIPTION)
    assert text == "The receiver shall use these rails:\n\n[[TABLE 1]]\n\nand obey the limits:\n\n[[TABLE 2]]\n\nEnd."
    assert tables == [STYLED, OTHER]


def test_text_without_a_table_is_returned_as_it_is() -> None:
    assert split_tables("The receiver shall lock.") == ("The receiver shall lock.", [])
    assert split_tables("") == ("", [])
    assert split_tables("if x <10 and y> 5") == ("if x <10 and y> 5", [])


def test_a_nested_table_stays_inside_its_outer_table() -> None:
    nested = "<table><tr><td>a</td><td><table><tr><td>b</td></tr></table></td></tr></table>"
    text, tables = split_tables(f"x {nested} y")
    assert text == "x [[TABLE 1]] y" and tables == [nested]


def test_an_unclosed_table_is_left_in_the_text() -> None:
    assert split_tables("x <table><tr><td>a</td> y") == ("x <table><tr><td>a</td> y", [])


def test_restoring_an_unchanged_proposal_gives_the_original_byte_for_byte() -> None:
    text, tables = split_tables(DESCRIPTION)
    restored, counts = restore_tables(text, tables)
    assert restored == DESCRIPTION
    assert counts == {"restored": 2, "reattached": 0, "dropped_extra": 0, "csv_rows_removed": 0}


def test_the_model_rewrites_the_prose_and_the_tables_come_back_in_place() -> None:
    proposed = "The receiver shall use the rails below:\n\n[[TABLE 1]]\n\nThe receiver shall obey:\n\n[[TABLE 2]]"
    restored, _ = restore_tables(proposed, [STYLED, OTHER])
    assert restored == f"The receiver shall use the rails below:\n\n{STYLED}\n\nThe receiver shall obey:\n\n{OTHER}"


def test_an_edited_marker_still_matches() -> None:
    restored, counts = restore_tables("a [[table 1]] b [ [Table  2 ] ] c", [STYLED, OTHER])
    assert restored == f"a {STYLED} b {OTHER} c" and counts["restored"] == 2 and counts["reattached"] == 0


def test_a_marker_that_lost_one_bracket_matches_only_alone_on_its_line() -> None:
    restored, counts = restore_tables("Rails:\n  [Table 1]\nEnd.", [STYLED])
    assert restored == f"Rails:\n  {STYLED}\nEnd." and counts["restored"] == 1 and counts["reattached"] == 0


def test_author_prose_that_looks_like_a_single_bracket_marker_is_left_alone() -> None:
    restored, counts = restore_tables("As shown in [Table 1], the rail is 3.3 V.\n\n[[TABLE 1]]", [STYLED])
    assert restored == f"As shown in [Table 1], the rail is 3.3 V.\n\n{STYLED}"
    assert counts["restored"] == 1 and counts["dropped_extra"] == 0


def test_a_missing_marker_gets_its_table_appended_in_original_order() -> None:
    restored, counts = restore_tables("Only prose now.", [STYLED, OTHER])
    assert restored == f"Only prose now.\n\n{STYLED}\n\n{OTHER}"
    assert counts["reattached"] == 2 and counts["restored"] == 0


def test_a_duplicated_or_unknown_marker_is_dropped_and_the_table_appears_once() -> None:
    restored, counts = restore_tables("a [[TABLE 1]] b [[TABLE 1]] c [[TABLE 7]] d", [STYLED])
    assert restored == f"a {STYLED} b  c  d" and counts["dropped_extra"] == 2


def test_csv_the_model_echoed_into_the_prose_is_removed_but_the_restored_table_is_not_touched() -> None:
    proposed = "Rails:\n\nTable (CSV):\nRail,V\nVDD,3.3\n\n[[TABLE 1]]\n\nDone."
    restored, counts = restore_tables(proposed, [STYLED])
    assert "Table (CSV)" not in restored and "Rail,V" not in restored.replace(STYLED, "")
    assert STYLED in restored and counts["csv_rows_removed"] == 3


def test_a_single_cell_prose_line_is_not_mistaken_for_an_echoed_row() -> None:
    one_column = "<table><tr><td>VDD</td></tr></table>"
    restored, counts = restore_tables("VDD\n[[TABLE 1]]", [one_column])
    assert restored == f"VDD\n{one_column}" and counts["csv_rows_removed"] == 0


def test_backslashes_in_a_table_are_not_interpreted_when_restoring() -> None:
    table = r"<table><tr><td>C:\new\1</td></tr></table>"
    restored, _ = restore_tables("x [[TABLE 1]] y", [table])
    assert restored == f"x {table} y"


class _Recording:
    def __init__(self, deltas: list[str]) -> None:
        self.deltas, self.messages = deltas, []

    async def stream_reply(self, messages, model, user_id=None):  # noqa: ANN001, ARG002
        self.messages = messages
        for delta in self.deltas:
            yield delta, ""


def _item(description: str) -> dict:
    return {"type": "Requirement", "title": "T", "description": description, "childType": None, "qualityIssues": []}


async def _turn(description: str, deltas: list[str]):
    chat, publisher = _Recording(deltas), _FakePublisher()
    await run_chat_turn("job-1", "n0", _item(description), [], "rewrite it", None, None, None, None, chat, publisher)
    return chat.messages[0]["content"], publisher


@pytest.mark.asyncio
async def test_the_model_sees_markers_and_csv_never_the_table_markup() -> None:
    prompt, _ = await _turn(DESCRIPTION, ["ok"])
    assert "<table" not in prompt and "colgroup" not in prompt and "border:1px" not in prompt
    assert "[[TABLE 1]]" in prompt and "[[TABLE 2]]" in prompt
    assert "Rail,V\nVDD,3.3" in prompt and "T,85" in prompt
    assert "never write" in prompt.lower()


@pytest.mark.asyncio
async def test_a_proposal_is_published_with_the_original_tables_restored() -> None:
    proposal = json.dumps({"proposedTitle": None, "proposedDescription": "Better prose:\n\n[[TABLE 1]]\n\nMore:\n\n[[TABLE 2]]"})
    _, publisher = await _turn(DESCRIPTION, [f"Done.\n{PROPOSAL_SENTINEL}\n{proposal}"])
    assert publisher.done["proposedDescription"] == f"Better prose:\n\n{STYLED}\n\nMore:\n\n{OTHER}"


@pytest.mark.asyncio
async def test_a_marker_in_the_conversational_reply_reads_as_plain_words() -> None:
    _, publisher = await _turn(DESCRIPTION, ["I kept [[TABLE 1]] as it is."])
    assert publisher.done["message"] == "I kept table 1 as it is."


@pytest.mark.asyncio
async def test_a_description_without_a_table_gets_the_prompt_it_always_had() -> None:
    prompt, publisher = await _turn("The receiver shall lock.", [f"Ok\n{PROPOSAL_SENTINEL}\n" + json.dumps({"proposedTitle": None, "proposedDescription": "Better."})])
    assert "TABLE" not in prompt and "Item description: The receiver shall lock." in prompt
    assert publisher.done["proposedDescription"] == "Better."


@pytest.mark.asyncio
async def test_with_the_flag_off_the_prompt_is_the_raw_description(monkeypatch) -> None:
    monkeypatch.setattr("app.chat.chat_service.settings.chat_table_placeholders_enabled", False)
    prompt, _ = await _turn(DESCRIPTION, ["ok"])
    assert STYLED in prompt and "[[TABLE" not in prompt
