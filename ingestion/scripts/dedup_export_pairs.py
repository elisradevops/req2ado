"""Turns an export of the duplicate decision log into labelled text pairs for scripts/dedup_score_pairs.py.

    curl -s -b <session cookie> 'http://localhost:4082/api/dedup/decisions?outcome=kept_skipped&limit=1000' > skipped.json
    .venv/bin/python scripts/dedup_export_pairs.py skipped.json created.json --out pairs.jsonl

A skip the reviewer left alone becomes a duplicate pair (label 1); an item they created anyway becomes a non-duplicate pair (label 0). Rows the
reviewer has not decided yet are counted and left out. Export CSV (format=csv) works too. See docs/dedup-evaluation.md.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.dedup.pair_scoring import load_decision_export, pairs_from_decisions  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("exports", nargs="+", type=Path, help="one or more exports of GET /dedup/decisions (.json or .csv)")
    parser.add_argument("--out", type=Path, required=True, help="where to write the pairs (JSON lines)")
    args = parser.parse_args(argv)

    rows: list[dict] = []
    try:
        for path in args.exports:
            rows.extend(load_decision_export(path))
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    pairs, undecided = pairs_from_decisions(rows)
    args.out.write_text("".join(json.dumps(pair, ensure_ascii=False) + "\n" for pair in pairs), encoding="utf-8")
    duplicates = sum(1 for pair in pairs if pair["label"] == 1)
    hebrew = sum(1 for pair in pairs if pair["lang"] != "en")
    print(f"{len(pairs)} pairs written to {args.out}: {duplicates} duplicates, {len(pairs) - duplicates} not duplicates, {hebrew} with Hebrew")
    print(f"{undecided} rows left out because the reviewer has not decided them")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
