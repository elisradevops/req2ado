from app.config import Settings


def test_embed_model_defaults_to_the_shared_deployment_value(monkeypatch) -> None:
    # No EMBED_MODEL in the environment: the default must be the same value
    # k8s/01-configmap.yaml ships, so a deployment that never sets the var
    # explicitly still agrees with the orchestrator. The mechanical check
    # that those two strings stay equal lives in test_embed_model_drift.py.
    monkeypatch.delenv("EMBED_MODEL", raising=False)
    assert Settings().embed_model == "nomic-embed-text"


def test_embed_model_is_populated_from_the_EMBED_MODEL_env_var(monkeypatch) -> None:
    # The whole point of duplicating this value rather than adding it to the
    # /llm/embed response: ingestion reads the SAME env var name the
    # orchestrator does, so both services get the same value out of the same
    # shared .env / ConfigMap and cannot disagree at runtime.
    monkeypatch.setenv("EMBED_MODEL", "bge-m3")
    assert Settings().embed_model == "bge-m3"
