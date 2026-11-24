"""The gate: compares a new report with the baseline for the same model and fails when anything got worse.

    python -m tests.prompt_evals.compare baseline.json new.json

A regression is a case that passed in the baseline and fails now, or a check that passed and fails now. A case whose prompt did not change is
still compared: a change outside the prompt file (assembly, data placement) can move it too. A case the provider's content filter blocked
now is not a regression: the prompt was never answered. It is listed as BLOCKED. A case the route failed (UPSTREAM_ERROR: an HTTP error or a
dropped connection, with every other repeat passing) measured nothing about the prompt either; it is listed as UPSTREAM."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from .harness import BLOCKED, UPSTREAM_ERROR


def regressions(baseline: dict, new: dict) -> list[str]:
    found = []
    for key, before in baseline["cases"].items():
        after = new["cases"].get(key)
        if after is None:
            found.append(f"{key}: missing from the new report")
            continue
        if after.get("outcome") in (BLOCKED, UPSTREAM_ERROR):
            continue
        for name, check in before.get("checks", {}).items():
            if check["ok"] and not after.get("checks", {}).get(name, {}).get("ok", False):
                detail = after.get("checks", {}).get(name, {}).get("detail") or after.get(
                    "error", ""
                )
                found.append(f"{key}/{name}: passed before, fails now ({detail})")
        if (
            before["passed"]
            and not after["passed"]
            and not any(f.startswith(f"{key}/") for f in found)
        ):
            found.append(f"{key}: passed before, fails now ({after.get('error', '')})")
    return found


def improvements(baseline: dict, new: dict) -> list[str]:
    return [
        key
        for key, after in new["cases"].items()
        if after["passed"] and not baseline["cases"].get(key, {}).get("passed", False)
    ]


def blocked(new: dict) -> list[str]:
    return [key for key, after in new["cases"].items() if after.get("outcome") == BLOCKED]


def upstream(new: dict) -> list[str]:
    return [key for key, after in new["cases"].items() if after.get("outcome") == UPSTREAM_ERROR]


def main(argv: list[str] | None = None) -> int:
    base_path, new_path = (argv or sys.argv[1:])[:2]
    baseline = json.loads(Path(base_path).read_text(encoding="utf-8"))
    new = json.loads(Path(new_path).read_text(encoding="utf-8"))
    if baseline.get("model") != new.get("model"):
        print(f"different models: {baseline.get('model')} vs {new.get('model')}")
        return 2
    worse = regressions(baseline, new)
    for line in improvements(baseline, new):
        print(f"  BETTER {line}")
    for line in blocked(new):
        print(f"  BLOCKED {line} (the provider's content filter; not compared)")
    for line in upstream(new):
        print(f"  UPSTREAM {line} (the route failed the call: {new['cases'][line].get('error', '')}; not compared)")
    for line in worse:
        print(f"  WORSE  {line}")
    print("REGRESSION" if worse else "OK: no regression")
    return 1 if worse else 0


if __name__ == "__main__":
    sys.exit(main())
