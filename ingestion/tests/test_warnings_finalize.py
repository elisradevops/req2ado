from app.leveling.warnings_finalize import finalize_warnings
from app.workitem.model import IntegrityWarning, WarningKind, WarningSeverity


def _reparented(node_id: str, target: str) -> IntegrityWarning:
    return IntegrityWarning.make(
        WarningKind.REPARENTED_TO_FEATURE,
        f'"Requirement {node_id}" had no parent -- re-parented under Feature "{target} Feature" '
        "to keep the Epic -> Feature -> Requirement chain intact.",
        node_ids=[node_id],
        detail={"targetFeatureId": target, "targetFeatureTitle": f"{target} Feature", "originalParent": "no parent"},
    )


def test_finalize_warnings_passes_a_single_occurrence_through_unchanged() -> None:
    warning = _reparented("n0", "f0")
    result = finalize_warnings([warning])
    assert result == [warning]


def test_finalize_warnings_merges_multiple_reparenting_occurrences_sharing_a_target() -> None:
    warnings = [_reparented("n0", "f0"), _reparented("n1", "f0"), _reparented("n2", "f0")]
    result = finalize_warnings(warnings)
    assert len(result) == 1
    merged = result[0]
    assert merged.kind == WarningKind.REPARENTED_TO_FEATURE
    assert merged.severity == WarningSeverity.AUTO_FIXED
    assert merged.node_ids == ["n0", "n1", "n2"]
    assert merged.detail["mergedCount"] == 3
    assert "3 Requirement(s)" in merged.raw
    assert 'Feature "f0 Feature"' in merged.raw


def test_finalize_warnings_keeps_separate_targets_as_separate_groups() -> None:
    warnings = [_reparented("n0", "f0"), _reparented("n1", "f1")]
    result = finalize_warnings(warnings)
    assert len(result) == 2
    targets = {w.detail["targetFeatureId"] for w in result}
    assert targets == {"f0", "f1"}


def test_finalize_warnings_preserves_first_occurrence_position() -> None:
    other = IntegrityWarning.make(WarningKind.NEAR_DUPLICATE_CONFLICT, "Near-duplicate items ...")
    warnings = [_reparented("n0", "f0"), other, _reparented("n1", "f0")]
    result = finalize_warnings(warnings)
    assert len(result) == 2
    assert result[0].kind == WarningKind.REPARENTED_TO_FEATURE
    assert result[0].node_ids == ["n0", "n1"]
    assert result[1] is other


def test_finalize_warnings_leaves_an_already_batched_kind_untouched() -> None:
    # NEAR_DUPLICATE_CONFLICT already emits one record per cluster at its
    # own emission site -- not in _GROUP_KEY_FIELD, so two occurrences (two
    # distinct clusters) must never collapse into one.
    warnings = [
        IntegrityWarning.make(WarningKind.NEAR_DUPLICATE_CONFLICT, "cluster A"),
        IntegrityWarning.make(WarningKind.NEAR_DUPLICATE_CONFLICT, "cluster B"),
    ]
    result = finalize_warnings(warnings)
    assert result == warnings


def test_finalize_warnings_groups_a_none_key_kind_across_the_whole_list() -> None:
    # LOW_GROUNDING has no meaningful sub-key -- every occurrence in the
    # tree collapses into one bucket regardless of which node it came from.
    warnings = [
        IntegrityWarning.make(WarningKind.LOW_GROUNDING, "Node n0 has low grounding", node_ids=["n0"]),
        IntegrityWarning.make(WarningKind.LOW_GROUNDING, "Node n1 has low grounding", node_ids=["n1"]),
    ]
    result = finalize_warnings(warnings)
    assert len(result) == 1
    assert result[0].node_ids == ["n0", "n1"]
    assert result[0].detail["mergedCount"] == 2


def test_finalize_warnings_groups_unsupported_content_note_across_the_whole_list() -> None:
    # UNSUPPORTED_CONTENT_NOTE (a loader diagnostic placeholder, e.g.
    # pdf_loader.py's multi-column false-positive note) is also a flat/None
    # group key -- a page-heavy document with many false-positive
    # occurrences must collapse into one summary record, not spam the
    # warnings panel with one entry per occurrence.
    warnings = [
        IntegrityWarning.make(
            WarningKind.UNSUPPORTED_CONTENT_NOTE,
            'The "Intro" section contained a loader diagnostic note (\'[UNSUPPORTED: page 1 ...]\')',
            detail={"section": "Intro", "text": "[UNSUPPORTED: page 1 appears multi-column]"},
        ),
        IntegrityWarning.make(
            WarningKind.UNSUPPORTED_CONTENT_NOTE,
            'The "Specs" section contained a loader diagnostic note (\'[UNSUPPORTED: page 9 ...]\')',
            detail={"section": "Specs", "text": "[UNSUPPORTED: page 9 appears multi-column]"},
        ),
    ]
    result = finalize_warnings(warnings)
    assert len(result) == 1
    assert result[0].kind == WarningKind.UNSUPPORTED_CONTENT_NOTE
    assert result[0].detail["mergedCount"] == 2
    assert "2 loader diagnostic note(s)" in result[0].raw


def test_finalize_warnings_groups_ocr_recovered_table_text_across_the_whole_list() -> None:
    # Real gap this closes: OCR_RECOVERED_TABLE_TEXT was previously absent
    # from this module entirely -- a scanned PDF with many OCR-recovered
    # tables spammed one warning row per table instead of one flat bucket.
    warnings = [
        IntegrityWarning.make(
            WarningKind.OCR_RECOVERED_TABLE_TEXT,
            "Table t0 had 3 cell(s) whose text could not be extracted directly and was recovered via OCR.",
            node_ids=["n0"],
            detail={"tableId": "t0", "recoveredCellCount": 3},
        ),
        IntegrityWarning.make(
            WarningKind.OCR_RECOVERED_TABLE_TEXT,
            "Table t1 had 5 cell(s) whose text could not be extracted directly and was recovered via OCR.",
            node_ids=["n1"],
            detail={"tableId": "t1", "recoveredCellCount": 5},
        ),
    ]
    result = finalize_warnings(warnings)
    assert len(result) == 1
    assert result[0].kind == WarningKind.OCR_RECOVERED_TABLE_TEXT
    assert result[0].detail["mergedCount"] == 2
    assert result[0].node_ids == ["n0", "n1"]
    assert "2 table(s) had 8 cell(s) total" in result[0].raw


def test_finalize_warnings_groups_external_reference_across_the_whole_list() -> None:
    # Real gap this closes: EXTERNAL_REFERENCE was previously absent from
    # this module entirely -- a document referencing many un-ingested
    # external artifacts spammed one warning row per reference instead of
    # one flat bucket.
    warnings = [
        IntegrityWarning.make(
            WarningKind.EXTERNAL_REFERENCE,
            'The "Intro" section references an external artifact (\'see Appendix A\').',
            detail={"section": "Intro", "phrase": "see Appendix A"},
        ),
        IntegrityWarning.make(
            WarningKind.EXTERNAL_REFERENCE,
            'The "Specs" section references an external artifact (\'see ICD-001\').',
            detail={"section": "Specs", "phrase": "see ICD-001"},
        ),
    ]
    result = finalize_warnings(warnings)
    assert len(result) == 1
    assert result[0].kind == WarningKind.EXTERNAL_REFERENCE
    assert result[0].detail["mergedCount"] == 2
    assert "2 external artifact reference(s)" in result[0].raw


def test_finalize_warnings_groups_empty_table_content_across_the_whole_list() -> None:
    # EMPTY_TABLE_CONTENT (drifted from Task 1's own UNSUPPORTED_CONTENT_NOTE
    # convention -- final whole-branch review finding) is also a flat/None
    # group key -- a table-dense document with many blank tables must
    # collapse into one summary record, not one warnings-panel row per blank
    # table.
    warnings = [
        IntegrityWarning.make(
            WarningKind.EMPTY_TABLE_CONTENT,
            '"Section A" referenced table t0, but it had no extractable content -- worth checking '
            "the source table manually.",
            node_ids=["n0"],
            detail={"tableId": "t0"},
        ),
        IntegrityWarning.make(
            WarningKind.EMPTY_TABLE_CONTENT,
            '"Section B" referenced table t1, but it had no extractable content -- worth checking '
            "the source table manually.",
            node_ids=["n1"],
            detail={"tableId": "t1"},
        ),
    ]
    result = finalize_warnings(warnings)
    assert len(result) == 1
    assert result[0].kind == WarningKind.EMPTY_TABLE_CONTENT
    assert result[0].node_ids == ["n0", "n1"]
    assert result[0].detail["mergedCount"] == 2
    assert "2 table(s)" in result[0].raw
