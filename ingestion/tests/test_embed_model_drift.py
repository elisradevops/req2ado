from __future__ import annotations

import re
from pathlib import Path

from app.config import Settings

# Cross-LANGUAGE drift guard for the intentional duplication documented in
# Settings.embed_model's own comment: ingestion keeps its own copy of the
# orchestrator's EMBED_MODEL value because the /llm/embed response body
# carries only raw vectors, and adding a model identifier to it would be a
# cross-service HTTP contract change.
#
# Mirrors mcp-ado-server/test/timingSafeEqualBearer.test.ts's mechanical
# drift-guard pattern -- this repo's established precedent for deliberate
# cross-deployable duplication -- in the only shape that is feasible for a
# TypeScript/Python pair:
#
#   * The guard is hosted on the DUPLICATING side (pytest), exactly as the
#     precedent hosts its guard on mcp-ado-server, the duplicating side
#     there. It reads the other side's source as raw text rather than
#     importing it: this repo has no cross-language test runner, and the
#     orchestrator's zod config cannot be constructed without a dozen
#     unrelated env vars.
#   * The precedent compares two function BODIES because both copies are the
#     same code. There is no analogue here: the orchestrator's field is
#     `EMBED_MODEL: z.string().min(1)` -- required, with NO source-level
#     default -- so there is no TS default string to compare against. The
#     name half is therefore checked against the TS source, and the value
#     half against k8s/01-configmap.yaml, the one file where a concrete
#     shared value is written and which BOTH deployments consume via
#     `envFrom: configMapRef: req2ado-config`.
#   * No YAML parser: pyyaml is not a declared ingestion dependency, and the
#     precedent is raw-text-plus-regex anyway.

_REPO_ROOT = Path(__file__).resolve().parents[2]
_ORCHESTRATOR_SCHEMA = _REPO_ROOT / "orchestrator/src/config/config.schema.ts"
_K8S_CONFIGMAP = _REPO_ROOT / "k8s/01-configmap.yaml"
_K8S_INGESTION = _REPO_ROOT / "k8s/24-ingestion.yaml"
_COMPOSE = _REPO_ROOT / "docker-compose.yml"
_ENV_TEMPLATE = _REPO_ROOT / ".env.template"

_ENV_VAR_NAME = "EMBED_MODEL"


def test_the_orchestrator_still_declares_the_env_var_this_side_duplicates() -> None:
    # The dangerous drift: if the orchestrator renames EMBED_MODEL, ingestion
    # silently keeps reading a dead env var and falls back to its own
    # default, which may not be the model actually producing the vectors --
    # exactly the bug the collection-key pin exists to prevent.
    source = _ORCHESTRATOR_SCHEMA.read_text(encoding="utf-8")
    assert re.search(rf"^\s*{_ENV_VAR_NAME}:\s*z\.", source, re.MULTILINE), (
        f"{_ENV_VAR_NAME} is no longer declared in {_ORCHESTRATOR_SCHEMA.name}. "
        "ingestion/app/config.py's embed_model duplicates that env var by name; "
        "if it was renamed there, rename it here too (and in .env.template, "
        "k8s/01-configmap.yaml, and the .env of every deployment)."
    )


def test_ingestion_reads_that_exact_env_var_name() -> None:
    # The other half of the name check: not just that the orchestrator still
    # declares EMBED_MODEL, but that ingestion is genuinely wired to the same
    # name (pydantic-settings resolves it case-insensitively from the field
    # name, which is easy to break by renaming the Python field).
    import os

    previous = os.environ.get(_ENV_VAR_NAME)
    os.environ[_ENV_VAR_NAME] = "drift-guard-probe-model"
    try:
        assert Settings().embed_model == "drift-guard-probe-model", (
            f"Settings.embed_model is no longer populated from ${_ENV_VAR_NAME}. "
            "Both services must read the same env var name -- that is what "
            "makes the duplicated config value safe at runtime."
        )
    finally:
        if previous is None:
            del os.environ[_ENV_VAR_NAME]
        else:
            os.environ[_ENV_VAR_NAME] = previous


def test_ingestions_default_matches_the_shared_k8s_configmap_value(monkeypatch) -> None:
    # The orchestrator's zod field is required with no default, so the
    # ConfigMap is the only place a concrete shared value is written -- and
    # both deployments consume that same ConfigMap. If these two drift, a
    # deployment that never sets EMBED_MODEL explicitly runs the two services
    # on two different embed models.
    configmap = _K8S_CONFIGMAP.read_text(encoding="utf-8")
    match = re.search(rf'^\s*{_ENV_VAR_NAME}:\s*"([^"]+)"', configmap, re.MULTILINE)
    assert match, f"{_ENV_VAR_NAME} is no longer set in {_K8S_CONFIGMAP.name}"

    monkeypatch.delenv(_ENV_VAR_NAME, raising=False)
    assert Settings().embed_model == match.group(1), (
        "ingestion/app/config.py's embed_model default has drifted from "
        f"{_K8S_CONFIGMAP.name}'s {_ENV_VAR_NAME} value. Update both, or a "
        "deployment without an explicit override runs two different models."
    )


def test_both_deployment_paths_still_deliver_the_var_to_ingestion() -> None:
    # The duplicated value is only safe because both services read it out of
    # the SAME shared environment. Assert that plumbing still exists, so the
    # pin can't be quietly defeated by a compose/k8s edit that gives the var
    # to the orchestrator only.
    env_template = _ENV_TEMPLATE.read_text(encoding="utf-8")
    assert re.search(rf"^{_ENV_VAR_NAME}=", env_template, re.MULTILINE), (
        f"{_ENV_VAR_NAME} is no longer declared in .env.template, which is the "
        "operator-facing source of the .env that docker-compose feeds to BOTH "
        "the orchestrator and ingestion."
    )

    compose = _COMPOSE.read_text(encoding="utf-8")
    ingestion_block = compose.split("\n  ingestion:\n", 1)
    assert len(ingestion_block) == 2, "no `ingestion:` service block in docker-compose.yml"
    # Slice to the next top-level (2-space-indented) service key.
    body = re.split(r"\n  [a-z0-9_-]+:\n", ingestion_block[1], maxsplit=1)[0]
    # Exact-line match, not substring: "env_file: .env" is a substring of
    # "env_file: .env.unused" too, which would silently defeat this guard on
    # exactly the drift it exists to catch (a rename to a DIFFERENT env file
    # that no longer carries EMBED_MODEL for the orchestrator).
    assert re.search(r"^\s*env_file:\s*\.env\s*$", body, re.MULTILINE), (
        "docker-compose.yml's ingestion service no longer loads .env, so it no "
        f"longer receives ${_ENV_VAR_NAME} -- its embed_model would silently "
        "fall back to the Python default while the orchestrator uses the .env value."
    )

    k8s_ingestion = _K8S_INGESTION.read_text(encoding="utf-8")
    assert "configMapRef" in k8s_ingestion and "req2ado-config" in k8s_ingestion, (
        f"{_K8S_INGESTION.name} no longer pulls the req2ado-config ConfigMap, so it "
        f"no longer receives ${_ENV_VAR_NAME}."
    )
