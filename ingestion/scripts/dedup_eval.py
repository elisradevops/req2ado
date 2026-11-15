"""Reports how well the duplicate check separates duplicates from near misses, on a labelled set of pairs (see app/dedup/evaluation.py).

    .venv/bin/python scripts/dedup_eval.py pairs.jsonl --threshold 0.90

Runs offline on recorded scores or vectors; it never calls a model.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.dedup.evaluation import SweepRow, evaluate, load_pairs  # noqa: E402


def _line(label: str, row: SweepRow) -> str:
    return (
        f"{label:<22} threshold {row.threshold:.3f}  precision {row.precision:.3f}  recall {row.recall:.3f}  F0.5 {row.f_half:.3f}  "
        f"(wrongly skipped {row.false_positive}, missed {row.false_negative})"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("pairs", type=Path, help="JSON-lines file of labelled pairs")
    parser.add_argument("--threshold", type=float, default=0.90, help="the threshold in use today (default 0.90)")
    args = parser.parse_args(argv)

    try:
        report = evaluate(load_pairs(args.pairs), args.threshold)
    except (ValueError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    print(f"{report.positives} duplicate pairs, {report.negatives} non-duplicate pairs, average precision {report.average_precision:.3f}")
    print(_line("In use today", report.at_current))
    print(_line("Best by F0.5", report.best))
    for lang, row in report.by_language.items():
        print(_line(f"  {lang} (in use)", row))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
