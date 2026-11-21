from app.canonical.model import SourceRef, Table, TableCell


def _sr(path: str = "x.docx") -> SourceRef:
    return SourceRef(document_path=path, start_offset=0, end_offset=10)


def _table(rows: list[list[str]], table_id: str = "t0") -> Table:
    return Table(
        id=table_id,
        cells=[[TableCell(text=cell) for cell in row] for row in rows],
        source_ref=_sr(),
    )


# --- repeated_customer_code_in_table ---------------------------------------


def test_atomizable_rows_carry_code_and_the_other_cells_in_column_order() -> None:
    from app.leveling.requirement_rows import AtomicRow, atomizable_requirement_rows

    table = _table(
        [
            ["#", "Parameter", "Requirement / Value"],
            [
                "P-SENSOR-001#",
                "Time sync source",
                "The system shall synchronize to Standard-XX within N ms.",
            ],
            ["P-SENSOR-002#", "", "Timing accuracy shall be better than X µs."],
        ]
    )
    assert atomizable_requirement_rows(table) == [
        AtomicRow(
            code="P-SENSOR-001#",
            cells=("Time sync source", "The system shall synchronize to Standard-XX within N ms."),
        ),
        AtomicRow(code="P-SENSOR-002#", cells=("Timing accuracy shall be better than X µs.",)),
    ]


def test_atomizable_rows_is_none_for_a_values_table_without_ids() -> None:
    from app.leveling.requirement_rows import atomizable_requirement_rows

    table = _table([["SRU module", "QTY"], ["Power supply", "1"], ["Fan", "2"]])
    assert atomizable_requirement_rows(table) is None


def test_atomizable_rows_is_none_when_a_non_header_row_has_no_code() -> None:
    # Splitting would drop that row's text, so the whole table must stay folded instead.
    from app.leveling.requirement_rows import atomizable_requirement_rows

    table = _table(
        [
            ["#", "Parameter", "Value"],
            ["P-A-001#", "One", "The system shall do one."],
            ["P-A-002#", "Two", "The system shall do two."],
            ["", "Note", "A free-text remark with no id."],
        ]
    )
    assert atomizable_requirement_rows(table) is None


def test_atomizable_rows_tolerates_none_and_blank_tables() -> None:
    from app.leveling.requirement_rows import atomizable_requirement_rows

    assert atomizable_requirement_rows(None) is None
    assert atomizable_requirement_rows(_table([[""]])) is None


def test_atomizable_rows_is_none_when_the_leading_row_is_a_spanning_title_not_a_header() -> None:
    from app.leveling.requirement_rows import atomizable_requirement_rows

    table = _table(
        [
            ["", "Sensor requirements", ""],
            ["P-A-001#", "One", "The system shall do one."],
            ["P-A-002#", "Two", "The system shall do two."],
        ]
    )
    assert atomizable_requirement_rows(table) is None
