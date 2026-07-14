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
    chroma_persist_path: str = "./.req2ado/vectors"
    sharepoint_token: str | None = Field(
        default=None, validation_alias=AliasChoices("SHAREPOINT_TOKEN", "GRAPH_TOKEN")
    )
    graph_base_url: str = "https://graph.microsoft.com/v1.0"

    class Config:
        env_prefix = ""


settings = Settings()
