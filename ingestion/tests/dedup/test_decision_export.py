import json

from app.dedup.pair_scoring import detect_lang, load_decision_export, pairs_from_decisions

ROW = {
    "jobId": "0123456789abcdef", "candidateTitle": "T", "candidateText": "The unit shall survive a drop.", "matchedText": "The unit must survive being dropped.",
    "similarity": 0.95, "decision": "skipped", "judgeVerdict": "redundant", "reviewerOutcome": "kept_skipped", "createdAt": "2026-11-12T10:00:00.000Z",
}


def test_a_skip_the_reviewer_left_alone_is_a_duplicate_pair() -> None:
    pairs, undecided = pairs_from_decisions([ROW])

    assert undecided == 0
    assert pairs == [
        {"a": ROW["candidateText"], "b": ROW["matchedText"], "label": 1, "lang": "en", "source": "decision-log 2026-11-12 job 01234567"}
    ]


def test_an_item_created_anyway_is_a_pair_that_is_not_a_duplicate() -> None:
    pairs, _ = pairs_from_decisions([{**ROW, "reviewerOutcome": "created_anyway"}])

    assert pairs[0]["label"] == 0


def test_rows_the_reviewer_has_not_decided_are_counted_and_left_out() -> None:
    pairs, undecided = pairs_from_decisions([{**ROW, "reviewerOutcome": None}, {**ROW, "reviewerOutcome": ""}, ROW])

    assert len(pairs) == 1
    assert undecided == 2


def test_a_row_without_both_texts_is_left_out_and_not_counted_as_undecided() -> None:
    pairs, undecided = pairs_from_decisions([{**ROW, "matchedText": None}, {**ROW, "candidateText": ""}])

    assert pairs == []
    assert undecided == 0


def test_titles_are_not_used_because_the_log_keeps_no_title_for_the_matched_item() -> None:
    pairs, _ = pairs_from_decisions([ROW])

    assert "title_a" not in pairs[0] and "title_b" not in pairs[0]


def test_language_is_read_from_the_letters() -> None:
    assert detect_lang("The unit shall survive.", "The unit must survive.") == "en"
    assert detect_lang("היחידה תשרוד נפילה.", "היחידה תעמוד בנפילה.") == "he"
    assert detect_lang("היחידה תשרוד נפילה.", "The unit shall survive a drop.") == "he-en"
    assert detect_lang("Ping 123", "Ping 124") == "en"


def test_the_export_is_read_from_json_or_csv(tmp_path) -> None:
    as_json = tmp_path / "decisions.json"
    as_json.write_text(json.dumps([ROW], ensure_ascii=False), encoding="utf-8")
    as_csv = tmp_path / "decisions.csv"
    as_csv.write_text(
        "id,jobId,localId,candidateTitle,candidateText,matchedText,similarity,decision,judgeVerdict,reviewerOutcome,createdAt\r\n"
        '1,0123456789abcdef,n1,T,"שלום, ""עולם""\nשורה שנייה",matched,0.95,skipped,redundant,created_anyway,2026-11-12T10:00:00.000Z\r\n',
        encoding="utf-8",
    )

    from_json = load_decision_export(as_json)
    from_csv = load_decision_export(as_csv)

    assert from_json == [ROW]
    assert from_csv[0]["candidateText"] == 'שלום, "עולם"\nשורה שנייה'
    assert from_csv[0]["reviewerOutcome"] == "created_anyway"
    assert from_csv[0]["similarity"] == 0.95


def test_a_file_that_is_not_an_export_is_refused_with_a_reason(tmp_path) -> None:
    bad = tmp_path / "decisions.json"
    bad.write_text('{"not": "a list"}', encoding="utf-8")

    try:
        load_decision_export(bad)
    except ValueError as exc:
        assert "list" in str(exc)
    else:
        raise AssertionError("expected ValueError")


def test_the_cli_writes_the_pairs_and_says_what_it_left_out(tmp_path, capsys) -> None:
    import importlib.util
    from pathlib import Path

    spec = importlib.util.spec_from_file_location("dedup_export_pairs", Path(__file__).resolve().parents[2] / "scripts" / "dedup_export_pairs.py")
    cli = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cli)
    export = tmp_path / "decisions.json"
    export.write_text(json.dumps([ROW, {**ROW, "reviewerOutcome": "created_anyway", "candidateText": "היחידה תשרוד.", "matchedText": "היחידה תעמוד."}, {**ROW, "reviewerOutcome": None}], ensure_ascii=False), encoding="utf-8")
    out = tmp_path / "pairs.jsonl"

    assert cli.main([str(export), "--out", str(out)]) == 0

    written = [json.loads(line) for line in out.read_text(encoding="utf-8").splitlines()]
    assert [p["label"] for p in written] == [1, 0]
    text = capsys.readouterr().out
    assert "2 pairs written" in text and "1 duplicates, 1 not duplicates, 1 with Hebrew" in text
    assert "1 rows left out" in text


def test_the_cli_refuses_a_bad_file_with_a_message_and_a_failing_exit_code(tmp_path, capsys) -> None:
    import importlib.util
    from pathlib import Path

    spec = importlib.util.spec_from_file_location("dedup_export_pairs", Path(__file__).resolve().parents[2] / "scripts" / "dedup_export_pairs.py")
    cli = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cli)
    bad = tmp_path / "bad.json"
    bad.write_text("{", encoding="utf-8")

    assert cli.main([str(bad), "--out", str(tmp_path / "pairs.jsonl")]) == 2
    assert capsys.readouterr().err.startswith("error:")
