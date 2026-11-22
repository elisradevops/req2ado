"""Runs cases and builds the report that baselines and the gate compare."""

from __future__ import annotations

import functools
import hashlib
import traceback

from app.prompts import _PROMPTS_DIR, _latest_version
from app.survey.content_filter import is_content_filtered
from app.survey.orchestrator_llm_client import OrchestratorLlmClient

from . import labels
from .cases import CASES, Case


def prompt_identity(family: str) -> dict:
    """Which prompt text a case measured: its name, version and a hash of the file."""
    version = _latest_version(family)
    text = (_PROMPTS_DIR / f"{family}.v{version}.txt").read_bytes()
    return {"name": family, "version": version, "sha": hashlib.sha256(text).hexdigest()[:12]}


BLOCKED = "blocked_by_provider"


def evaluate(case: Case, client: OrchestratorLlmClient) -> dict:
    """One case's outcome: every check's result, or the error that kept the call from answering (an error fails the case). A call the
    provider's content filter blocked is its own outcome, BLOCKED: the prompt was never answered, so it is neither a pass nor an error,
    and the gate does not count it as a regression."""
    try:
        checks = case.check(case.run(client))
    except Exception as exc:  # noqa: BLE001 - a failing call is a measured outcome, not a crash of the run
        if is_content_filtered(exc):
            return {"passed": False, "outcome": BLOCKED, "checks": {}}
        return {
            "passed": False,
            "error": f"{type(exc).__name__}: {exc}",
            "trace": traceback.format_exc(limit=3),
            "checks": {},
        }
    return {
        "passed": all(ok for ok, _ in checks.values()),
        "checks": {
            name: {"ok": ok, **({} if ok else {"detail": detail})}
            for name, (ok, detail) in checks.items()
        },
    }


class AsUser:
    """The client with `user_id` passed to every call, as the pipeline does: the orchestrator answers a call only for a user whose model
    connection it knows."""

    def __init__(self, client: OrchestratorLlmClient, user_id: str) -> None:
        self._client = client
        self._user_id = user_id

    @property
    def model(self) -> str | None:
        return self._client.model

    def __getattr__(self, name: str):
        method = getattr(self._client, name)
        return functools.partial(method, user_id=self._user_id) if callable(method) else method


def run_all(
    client: OrchestratorLlmClient | AsUser,
    families: set[str] | None = None,
    cases: list[Case] = CASES,
) -> dict:
    results = {}
    for case in cases:
        if families and case.family not in families:
            continue
        results[f"{case.family}/{case.name}"] = {
            "family": case.family,
            "tags": sorted(case.tags),
            "prompt": prompt_identity(case.family),
            **evaluate(case, client),
        }
    return {"model": client.model, "labels_confirmed": labels.CONFIRMED, "cases": results}
