# ingestion/app/config.py
from __future__ import annotations

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Ingestion's own config surface — did not exist before this phase.
    ORCHESTRATOR_URL/LLM_PROXY_BEARER let ingestion call BACK into the
    orchestrator's /llm/chat and /llm/embed proxies (never any LLM endpoint
    directly — same 'backend proxy, redact-first' boundary every real client
    in ingestion/app/survey and ingestion/app/dedup already documents in its
    own docstring). CHROMA_PERSIST_PATH has no default in ChromaVectorStore
    itself (its constructor requires a path) — this is where that path
    actually comes from at runtime."""

    orchestrator_url: str = "http://localhost:3001"
    llm_proxy_bearer: str = "dev-local-only"
    # Unset = figure/diagram extraction stays a placeholder, same behavior
    # as before vision support existed. Set to a real vision-capable model
    # name (e.g. "llava") to actually describe extracted figure images.
    llm_vision_model: str | None = None
    chroma_persist_path: str = "./.req2ado/vectors"
    # Local chromadb.PersistentClient (default, unchanged from before this
    # option existed) does not survive horizontal scaling -- each ingestion
    # replica would hold an independent, incomplete corpus copy. Set to
    # "http" (plus chroma_host/chroma_port) to instead connect to a real,
    # shared Chroma server via chromadb.HttpClient, making ingestion
    # genuinely stateless and horizontally scalable.
    chroma_mode: str = "embedded"
    chroma_host: str = "localhost"
    chroma_port: int = 8000
    # /ingest previously read the whole upload into memory with no size
    # guard of its own -- the orchestrator's own upload-size check happens
    # before it forwards a file here, but this endpoint is independently
    # reachable and had no protection if called directly. Mirrors
    # orchestrator's MAX_UPLOAD_SIZE_MB (env var, same name, same default).
    max_upload_size_mb: int = 25
    # KB/SharePoint ingestion (app/kb/graph_client.py) — SHAREPOINT_TOKEN is
    # the primary name; GRAPH_TOKEN is accepted as an alias for the same value.
    sharepoint_token: str | None = Field(
        default=None, validation_alias=AliasChoices("SHAREPOINT_TOKEN", "GRAPH_TOKEN")
    )
    graph_base_url: str = "https://graph.microsoft.com/v1.0"
    redis_url: str = "redis://localhost:6379"

    class Config:
        env_prefix = ""


settings = Settings()
