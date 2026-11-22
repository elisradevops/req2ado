"""Runs the prompt evaluation against a real model route and writes a report.

    python -m tests.prompt_evals.run --base-url https://<orchestrator> --token <LLM_PROXY_BEARER> --user-id <user> --model <model> \
        --out report.json

--user-id is a req2ado user whose model connection is set in Settings: the orchestrator answers only for such a user. Run it from the ingestion directory on a network that reaches the route, once per production model family.

Inside a running ingestion container (the image ships this harness), --base-url and --token default to the container's own ORCHESTRATOR_URL
and LLM_PROXY_BEARER, so nobody handles the token:

    python -m tests.prompt_evals.run --user-id <user> --model <model> --repeat 2 --out /tmp/report.json

Every fixture is synthetic. The response cache is not used, so every case asks the model. Repeat with --repeat to see run-to-run variance: a case counts as passed only when
it passed every repeat."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from app.config import settings
from app.survey.orchestrator_llm_client import OrchestratorLlmClient

from .harness import BLOCKED, AsUser, run_all


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--base-url", default=None, help="default: this service's ORCHESTRATOR_URL")
    parser.add_argument("--token", default=None, help="default: this service's LLM_PROXY_BEARER")
    parser.add_argument("--user-id", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--family", action="append", help="only these prompt families (repeatable)")
    parser.add_argument("--repeat", type=int, default=1)
    args = parser.parse_args(argv)

    client = AsUser(
        OrchestratorLlmClient(
            base_url=args.base_url or settings.orchestrator_url,
            bearer_token=args.token or settings.llm_proxy_bearer,
            model=args.model,
        ),
        args.user_id,
    )
    runs = [
        run_all(client, set(args.family) if args.family else None)
        for _ in range(max(1, args.repeat))
    ]
    report = runs[0]
    for key, result in report["cases"].items():
        outcomes = [run["cases"][key]["passed"] for run in runs]
        result["passed"] = all(outcomes)
        result["passed_runs"] = f"{sum(outcomes)}/{len(outcomes)}"
        # A repeat the provider blocked measured nothing about the prompt: the case is reported as blocked, not failed.
        if any(run["cases"][key].get("outcome") == BLOCKED for run in runs):
            result["outcome"] = BLOCKED
    report["repeats"] = len(runs)
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    blocked = [key for key, result in report["cases"].items() if result.get("outcome") == BLOCKED]
    failed = [
        key
        for key, result in report["cases"].items()
        if not result["passed"] and key not in blocked
    ]
    print(
        f"{len(report['cases']) - len(failed) - len(blocked)}/{len(report['cases'])} cases passed, "
        f"{len(blocked)} blocked by the provider, on {args.model} -> {args.out}"
    )
    for key in blocked:
        print(
            f"  BLOCKED {key} [{report['cases'][key]['passed_runs']}]: the provider's content filter refused the call"
        )
    for key in failed:
        result = report["cases"][key]
        reasons = result.get("error") or "; ".join(
            f"{name}: {check['detail']}"
            for name, check in result["checks"].items()
            if not check["ok"]
        )
        print(f"  FAIL {key} [{result['passed_runs']}]: {reasons}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
