"""Measures how well the duplicate check separates real duplicates from near misses, on a labelled set of pairs.

The check skips an item when its similarity to an existing one reaches a threshold, so the cost of a mistake is lopsided: a wrong skip
silently loses a real requirement, a missed duplicate only creates one more item for a reviewer to merge. That is why the headline
number is F0.5 (precision counts more than recall), not F1, and why the report also shows where each language lands.

This module is pure: it works on scores (or recorded vectors) it is given and never calls a model, so it runs in CI. The set is a
JSON-lines file, one pair per line:

    {"score": 0.93, "label": 1, "lang": "he", "source": "review-2026-11"}
    {"vec_a": [...], "vec_b": [...], "label": 0, "lang": "en"}

`label` is 1 for a duplicate and 0 for a pair that is not. A row carries either the `score` the check produced or the two recorded
(already title/description-blended) vectors to take the cosine of.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class LabelledPair:
    score: float
    label: int
    lang: str = "unknown"
    source: str = ""


@dataclass(frozen=True)
class SweepRow:
    threshold: float
    true_positive: int
    false_positive: int
    false_negative: int
    precision: float
    recall: float
    f_half: float


@dataclass(frozen=True)
class Report:
    at_current: SweepRow
    best: SweepRow
    average_precision: float
    positives: int
    negatives: int
    by_language: dict[str, SweepRow]


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    return 0.0 if norm == 0 else dot / norm


def f_beta(precision: float, recall: float, beta: float) -> float:
    if precision == 0 and recall == 0:
        return 0.0
    squared = beta * beta
    return (1 + squared) * precision * recall / (squared * precision + recall)


def _row(pairs: list[LabelledPair], threshold: float) -> SweepRow:
    true_positive = sum(1 for p in pairs if p.score >= threshold and p.label == 1)
    false_positive = sum(1 for p in pairs if p.score >= threshold and p.label == 0)
    false_negative = sum(1 for p in pairs if p.score < threshold and p.label == 1)
    predicted = true_positive + false_positive
    actual = true_positive + false_negative
    precision = true_positive / predicted if predicted else 1.0 if actual == 0 else 0.0
    recall = true_positive / actual if actual else 0.0
    return SweepRow(threshold, true_positive, false_positive, false_negative, precision, recall, f_beta(precision, recall, 0.5))


def sweep(pairs: list[LabelledPair]) -> list[SweepRow]:
    """Precision, recall and F0.5 with the threshold at each distinct score, highest first."""
    return [_row(pairs, threshold) for threshold in sorted({p.score for p in pairs}, reverse=True)]


def average_precision(pairs: list[LabelledPair]) -> float:
    """Mean of the precision at each real duplicate, going down the pairs by score: 1.0 when every duplicate outranks every non-duplicate."""
    ranked = sorted(pairs, key=lambda p: p.score, reverse=True)
    positives = sum(1 for p in ranked if p.label == 1)
    if positives == 0:
        return 0.0
    found = 0
    total = 0.0
    for rank, pair in enumerate(ranked, start=1):
        if pair.label == 1:
            found += 1
            total += found / rank
    return total / positives


def evaluate(pairs: list[LabelledPair], current_threshold: float) -> Report:
    positives = sum(1 for p in pairs if p.label == 1)
    negatives = len(pairs) - positives
    if positives == 0 or negatives == 0:
        raise ValueError("the set needs both duplicate and non-duplicate pairs to measure anything")
    rows = sweep(pairs)
    # Ties go to the higher threshold: when two thresholds are equally good, skip less.
    best = max(rows, key=lambda row: (row.f_half, row.threshold))
    languages = sorted({p.lang for p in pairs})
    by_language = {lang: _row([p for p in pairs if p.lang == lang], current_threshold) for lang in languages}
    return Report(_row(pairs, current_threshold), best, average_precision(pairs), positives, negatives, by_language)


def load_pairs(path: Path) -> list[LabelledPair]:
    pairs: list[LabelledPair] = []
    for number, line in enumerate(Path(path).read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
            label = row["label"]
            if label not in (0, 1):
                raise ValueError("label must be 0 or 1")
            if "score" in row:
                score = float(row["score"])
            elif "vec_a" in row and "vec_b" in row:
                score = cosine(row["vec_a"], row["vec_b"])
            else:
                raise ValueError("needs a score, or vec_a and vec_b")
        except (ValueError, KeyError, TypeError) as exc:
            raise ValueError(f"line {number}: {exc}") from exc
        pairs.append(LabelledPair(score=score, label=int(label), lang=str(row.get("lang", "unknown")), source=str(row.get("source", ""))))
    return pairs
