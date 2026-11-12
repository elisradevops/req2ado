import json
import math

import pytest

from app.dedup.evaluation import (
    LabelledPair,
    average_precision,
    cosine,
    evaluate,
    f_beta,
    load_pairs,
    sweep,
)


def pair(score: float, label: int, lang: str = "en") -> LabelledPair:
    return LabelledPair(score=score, label=label, lang=lang, source="test")


def test_cosine_of_identical_vectors_is_one_and_of_orthogonal_ones_is_zero() -> None:
    assert cosine([1.0, 2.0], [1.0, 2.0]) == pytest.approx(1.0)
    assert cosine([1.0, 0.0], [0.0, 1.0]) == pytest.approx(0.0)


def test_cosine_with_a_zero_vector_is_zero_not_a_crash() -> None:
    assert cosine([0.0, 0.0], [1.0, 1.0]) == 0.0


def test_f_beta_weights_precision_more_when_beta_is_below_one() -> None:
    # Same average of precision and recall; the one with the higher precision scores higher at beta=0.5.
    assert f_beta(precision=0.9, recall=0.5, beta=0.5) > f_beta(precision=0.5, recall=0.9, beta=0.5)
    assert f_beta(precision=0.0, recall=0.0, beta=0.5) == 0.0
    assert f_beta(precision=1.0, recall=1.0, beta=0.5) == pytest.approx(1.0)


def test_average_precision_is_one_when_every_duplicate_outscores_every_non_duplicate() -> None:
    pairs = [pair(0.95, 1), pair(0.93, 1), pair(0.7, 0), pair(0.6, 0)]

    assert average_precision(pairs) == pytest.approx(1.0)


def test_average_precision_drops_when_a_non_duplicate_outscores_a_duplicate() -> None:
    # Ranked: dup, non-dup, dup  ->  AP = (1/1 + 2/3) / 2
    pairs = [pair(0.9, 1), pair(0.8, 0), pair(0.7, 1)]

    assert average_precision(pairs) == pytest.approx((1.0 + 2 / 3) / 2)


def test_sweep_reports_precision_recall_and_f_at_each_distinct_score() -> None:
    pairs = [pair(0.95, 1), pair(0.9, 0), pair(0.85, 1), pair(0.5, 0)]

    rows = {round(row.threshold, 2): row for row in sweep(pairs)}

    top = rows[0.95]
    assert (top.true_positive, top.false_positive, top.false_negative) == (1, 0, 1)
    assert top.precision == 1.0 and top.recall == 0.5
    mid = rows[0.85]
    assert (mid.true_positive, mid.false_positive, mid.false_negative) == (2, 1, 0)
    assert mid.precision == pytest.approx(2 / 3) and mid.recall == 1.0


def test_evaluate_finds_the_threshold_that_best_protects_against_a_wrong_skip() -> None:
    # Going lower catches the second duplicate but also skips a non-duplicate that scores above it; 0.97 skips nothing wrongly.
    pairs = [pair(0.97, 1), pair(0.82, 1), pair(0.85, 0), pair(0.4, 0)]

    report = evaluate(pairs, current_threshold=0.90)

    assert report.at_current.threshold == 0.90
    assert report.at_current.false_positive == 0 and report.at_current.false_negative == 1
    # F0.5 favours the threshold that never skips a real requirement
    assert report.best.threshold == pytest.approx(0.97)
    assert report.average_precision == pytest.approx(average_precision(pairs))
    assert report.positives == 2 and report.negatives == 2


def test_evaluate_breaks_the_result_down_by_language() -> None:
    pairs = [pair(0.95, 1, "en"), pair(0.2, 0, "en"), pair(0.6, 1, "he"), pair(0.5, 0, "he")]

    report = evaluate(pairs, current_threshold=0.90)

    assert set(report.by_language) == {"en", "he"}
    assert report.by_language["en"].false_negative == 0
    assert report.by_language["he"].false_negative == 1  # the Hebrew duplicate scored under the threshold


def test_evaluate_refuses_a_set_with_no_duplicates_or_no_non_duplicates() -> None:
    with pytest.raises(ValueError, match="both"):
        evaluate([pair(0.9, 1), pair(0.95, 1)], current_threshold=0.9)
    with pytest.raises(ValueError, match="both"):
        evaluate([pair(0.1, 0)], current_threshold=0.9)


def test_load_pairs_reads_recorded_scores_and_recorded_vectors(tmp_path) -> None:
    path = tmp_path / "pairs.jsonl"
    rows = [
        {"score": 0.93, "label": 1, "lang": "he", "source": "review-1"},
        {"vec_a": [1.0, 0.0], "vec_b": [1.0, 0.0], "label": 1, "lang": "en", "source": "review-2"},
        {"vec_a": [1.0, 0.0], "vec_b": [0.0, 1.0], "label": 0},
    ]
    path.write_text("\n".join(json.dumps(row) for row in rows) + "\n\n", encoding="utf-8")

    pairs = load_pairs(path)

    assert [(p.score, p.label, p.lang) for p in pairs] == [(0.93, 1, "he"), (pytest.approx(1.0), 1, "en"), (pytest.approx(0.0), 0, "unknown")]


def test_load_pairs_names_the_line_of_a_row_it_cannot_use(tmp_path) -> None:
    path = tmp_path / "pairs.jsonl"
    path.write_text(json.dumps({"label": 1, "score": 0.9}) + "\n" + json.dumps({"label": 2, "score": 0.9}) + "\n", encoding="utf-8")

    with pytest.raises(ValueError, match="line 2"):
        load_pairs(path)


def test_load_pairs_rejects_a_row_with_neither_a_score_nor_vectors(tmp_path) -> None:
    path = tmp_path / "pairs.jsonl"
    path.write_text(json.dumps({"label": 1}) + "\n", encoding="utf-8")

    with pytest.raises(ValueError, match="line 1"):
        load_pairs(path)


def test_scores_are_not_taken_from_nan() -> None:
    assert not math.isnan(cosine([1.0, 1.0], [1.0, 1.0]))
