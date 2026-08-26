from app.canonical.model import SourceRef, Table, TableCell
from app.leveling.requirement_rows import RequirementRowInfo, qualifying_requirement_rows, repeated_customer_code_in_table


def _sr(path: str = "x.docx") -> SourceRef:
    return SourceRef(document_path=path, start_offset=0, end_offset=10)


def _table(rows: list[list[str]], table_id: str = "t0") -> Table:
    return Table(id=table_id, cells=[[TableCell(text=cell) for cell in row] for row in rows], source_ref=_sr())


def test_mock_prd_shape_yields_one_row_per_id() -> None:
    table = _table([
        ["#", "Parameter", "Requirement / Value"],
        ["P-SENSOR-001#", "Time sync source", "The system shall synchronize to Standard-XX within N ms."],
        ["P-SENSOR-002#", "Sync accuracy", "Timing accuracy shall be better than X µs."],
        ["P-SENSOR-003#", "Sync interval", "Re-synchronization shall occur every N seconds."],
    ])
    result = qualifying_requirement_rows([table])
    assert result == [
        RequirementRowInfo(table_id="t0", code="P-SENSOR-001#", label="The system shall synchronize to Standard-XX within N ms."),
        RequirementRowInfo(table_id="t0", code="P-SENSOR-002#", label="Timing accuracy shall be better than X µs."),
        RequirementRowInfo(table_id="t0", code="P-SENSOR-003#", label="Re-synchronization shall occur every N seconds."),
    ]


def test_airpro_style_supplementary_values_table_yields_nothing() -> None:
    # Real reference document (AirPro_BP_ICD_Revision_0.3.docx) shape: a
    # power-budget table with no per-row identifier at all -- must stay
    # exactly as-is (folded into its one surrounding requirement).
    table = _table([
        ["SRU module", "QTY", "Unit Power [Watt]", "Total power"],
        ["Power supply Efficiency", "1", "63", "0.87"],
        ["Receiver Module", "2", "12", "24"],
        ["Transmitter Module", "1", "45", "45"],
    ])
    assert qualifying_requirement_rows([table]) == []


def test_header_row_excluded_by_shape_not_wording() -> None:
    table = _table([
        ["Req ID", "Description"],
        ["REQ-001", "The system shall do X."],
        ["REQ-002", "The system shall do Y."],
    ])
    result = qualifying_requirement_rows([table])
    assert [r.code for r in result] == ["REQ-001", "REQ-002"]


def test_a_code_shaped_substring_inside_a_prose_cell_does_not_qualify_the_row() -> None:
    # Whole-cell match only -- a real standard reference embedded in prose
    # ("per MIL-STD-1553") must never be read as this row's own id.
    table = _table([
        ["#", "Requirement"],
        ["REQ-001", "The bus shall comply per MIL-STD-1553."],
        ["REQ-002", "The system shall boot within 5 seconds."],
    ])
    result = qualifying_requirement_rows([table])
    assert [r.code for r in result] == ["REQ-001", "REQ-002"]


def test_min_id_row_fraction_floor_rejects_a_single_stray_code_in_a_values_table() -> None:
    # A single code-shaped cell in an otherwise ordinary 10-row values
    # table must never reclassify the whole table.
    rows = [["Parameter", "Value"]]
    rows.append(["REQ-001", "5V"])
    for i in range(9):
        rows.append([f"Voltage rail {i}", "3.3V"])
    table = _table(rows)
    assert qualifying_requirement_rows([table]) == []


def test_min_id_rows_floor_rejects_a_table_with_only_one_id_row() -> None:
    table = _table([
        ["#", "Requirement"],
        ["REQ-001", "The system shall do X."],
        ["", "No id here, just prose."],
    ])
    assert qualifying_requirement_rows([table]) == []


def test_id_column_need_not_be_first() -> None:
    table = _table([
        ["Parameter", "#", "Requirement"],
        ["Time sync source", "P-SENSOR-001#", "The system shall synchronize to Standard-XX within N ms."],
        ["Sync accuracy", "P-SENSOR-002#", "Timing accuracy shall be better than X µs."],
    ])
    result = qualifying_requirement_rows([table])
    assert [r.code for r in result] == ["P-SENSOR-001#", "P-SENSOR-002#"]


def test_single_column_table_of_codes_has_no_obligation_text_and_does_not_qualify() -> None:
    table = _table([["#"], ["REQ-001"], ["REQ-002"], ["REQ-003"]])
    assert qualifying_requirement_rows([table]) == []


def test_a_row_with_an_empty_label_cell_still_qualifies() -> None:
    # Mock_PRD_Sensor.docx's own "P-SENSOR-009#" row has a blank Parameter
    # cell -- the id column alone is the discriminator, not the label.
    table = _table([
        ["#", "Parameter", "Requirement / Value"],
        ["P-SENSOR-007#", "Data fields", "Each report shall include position, velocity and TBD."],
        ["P-SENSOR-008#", "", "The system shall track up to N targets simultaneously."],
    ])
    result = qualifying_requirement_rows([table])
    assert result[1] == RequirementRowInfo(
        table_id="t0", code="P-SENSOR-008#", label="The system shall track up to N targets simultaneously."
    )


def test_none_and_empty_and_blank_only_tables_never_raise() -> None:
    assert qualifying_requirement_rows(None) == []
    assert qualifying_requirement_rows([]) == []
    blank_table = _table([["", ""], ["", ""]])
    assert qualifying_requirement_rows([blank_table]) == []


def test_two_tables_are_judged_independently() -> None:
    requirements_table = _table(
        [["#", "Requirement"], ["REQ-001", "The system shall do X."], ["REQ-002", "The system shall do Y."]],
        table_id="t0",
    )
    values_table = _table(
        [["Parameter", "Value"], ["Voltage", "3.3V"], ["Current", "500mA"]],
        table_id="t1",
    )
    result = qualifying_requirement_rows([values_table, requirements_table])
    assert [r.table_id for r in result] == ["t0", "t0"]


# --- repeated_customer_code_in_table ---------------------------------------


def test_repeated_customer_code_in_table_rejects_a_lone_category_label() -> None:
    # Confirmed real bug, live (cubeadcs_icd.pdf): a genuinely supplementary
    # 3-row "Variant" column has exactly ONE code-shaped cell ("PC104") --
    # a category label, not a repeating id column. One match can never
    # reach the MIN_ID_ROWS floor.
    table = _table([
        ["Variant", "Description"],
        ["PC104", "PC104 stack variant"],
        ["Backplane", "Backplane variant"],
        ["Demo Model", "Demo model variant"],
    ])
    assert repeated_customer_code_in_table(table) is None


def test_repeated_customer_code_in_table_accepts_two_repeats_below_the_qualifying_fraction() -> None:
    # Deliberately below qualifying_requirement_rows's own 50%-of-rows
    # gate (2 of 5 rows = 40%) -- this is the narrower, floor-only check:
    # a genuinely supplementary table (never pre-split at stage 1) can
    # still carry a real, repeated id in one of its own columns.
    table = _table([
        ["ID", "Value"],
        ["REQ-001", "5V"],
        ["Other One", "x"],
        ["Other Two", "y"],
        ["REQ-002", "3.3V"],
    ])
    assert repeated_customer_code_in_table(table) == "REQ-001"  # first match, in document order


def test_repeated_customer_code_in_table_returns_none_below_two_rows_total() -> None:
    table = _table([["ID", "Value"], ["REQ-001", "5V"]])
    assert repeated_customer_code_in_table(table) is None


def test_repeated_customer_code_in_table_never_raises_on_none_or_empty() -> None:
    assert repeated_customer_code_in_table(_table([])) is None
    assert repeated_customer_code_in_table(_table([["", ""], ["", ""]])) is None
