"""Scores labelled TEXT pairs with an embedding model and reports how well the duplicate check separates them (see app/dedup/pair_scoring.py).

    .venv/bin/python scripts/dedup_score_pairs.py scripts/samples/dedup_pairs_draft.jsonl --env-file ../.env --threshold 0.90
    .venv/bin/python scripts/dedup_score_pairs.py pairs.jsonl --env-file ../.env --save scores.jsonl

Reads EMBED_BASE_URL, EMBED_PATH, EMBED_MODEL and LLM_API_KEY from the environment or --env-file (the key is never printed) and calls an
Ollama-shaped /api/embed endpoint, which is what local development uses. Production's OpenAI-style route is not covered here. The scores can be
saved and read again with scripts/dedup_eval.py.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.dedup.evaluation import LabelledPair, evaluate  # noqa: E402
from app.dedup.pair_scoring import load_text_pairs, ollama_embedder, score_pairs  # noqa: E402


def read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip() and not line.lstrip().startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip()
    return values


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("pairs", type=Path, help="JSON-lines file of labelled text pairs")
    parser.add_argument("--env-file", type=Path, help="a .env file with the EMBED_* settings and LLM_API_KEY")
    parser.add_argument("--threshold", type=float, default=0.90, help="the threshold in use today (default 0.90)")
    parser.add_argument("--save", type=Path, help="write the scored pairs here (JSON lines) for dedup_eval.py")
    args = parser.parse_args(argv)

    env = {**(read_env_file(args.env_file) if args.env_file else {}), **os.environ}
    missing = [key for key in ("EMBED_BASE_URL", "EMBED_MODEL") if not env.get(key)]
    if missing:
        print(f"error: {', '.join(missing)} not set (use --env-file or the environment)", file=sys.stderr)
        return 2

    try:
        rows = load_text_pairs(args.pairs)
        embed = ollama_embedder(env["EMBED_BASE_URL"], env.get("EMBED_PATH", "/api/embed"), env["EMBED_MODEL"], env.get("LLM_API_KEY"))
        scored = score_pairs(rows, embed)
        report = evaluate([LabelledPair(s["score"], s["label"], s["lang"], s["source"]) for s in scored], args.threshold)
    except (ValueError, OSError, RuntimeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    if args.save:
        args.save.write_text("".join(json.dumps(s, ensure_ascii=False) + "\n" for s in scored), encoding="utf-8")

    dups = sorted(s["score"] for s in scored if s["label"] == 1)
    nons = sorted(s["score"] for s in scored if s["label"] == 0)
    print(f"model {env['EMBED_MODEL']}: {report.positives} duplicate pairs, {report.negatives} non-duplicate pairs, average precision {report.average_precision:.3f}")
    print(f"duplicates score {dups[0]:.3f} to {dups[-1]:.3f} (median {dups[len(dups) // 2]:.3f}); near-misses score {nons[0]:.3f} to {nons[-1]:.3f} (highest {nons[-1]:.3f})")
    for label, row in (("In use today", report.at_current), ("Best by F0.5", report.best)):
        print(
            f"{label:<14} threshold {row.threshold:.3f}  precision {row.precision:.3f}  recall {row.recall:.3f}  F0.5 {row.f_half:.3f}  "
            f"(wrongly skipped {row.false_positive}, missed {row.false_negative})"
        )
    for lang, row in report.by_language.items():
        print(f"  {lang:<6} at {row.threshold:.2f}: precision {row.precision:.3f}  recall {row.recall:.3f}  (wrongly skipped {row.false_positive}, missed {row.false_negative})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
