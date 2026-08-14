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
    # Middle rung of the SURVEY call ladder (orchestrator -> ingestion ->
    # this -> the LLM backend) -- see orchestrator_llm_client.py's own doc
    # comment. Deliberately narrower than the orchestrator's own
    # INGESTION_REQUEST_TIMEOUT_MS (1h) so this layer reports a stuck LLM
    # call first, with real margin to the outer layer's own ceiling. Same
    # numeric default as before this was configurable (no behavior change).
    llm_request_timeout_seconds: float = 1800.0
    # Confirmed real bug: this was hardcoded to 300s while the orchestrator's
    # own LLM_REQUEST_TIMEOUT_MS defaults to 600s (600_000ms) -- a vision
    # call that would have succeeded between 300-600s got aborted here
    # first, permanently dropping that figure's caption (sequential
    # captioning + zero retry by design means this compounds at scale). 590s
    # is deliberately just under the orchestrator's 600s default so THIS
    # layer times out first with an honest "vision call gave up" signal,
    # rather than the orchestrator's own timeout firing and surfacing a
    # generic connection reset instead. If either this value or the
    # orchestrator's LLM_REQUEST_TIMEOUT_MS changes, reconsider the other --
    # they're meant to stay in that relative order.
    vision_request_timeout_seconds: float = 590.0
    # No logging config existed anywhere in this service before -- whatever
    # uvicorn's own defaults produced. Named so it's configurable without a
    # code change per deployment (e.g. DEBUG locally, INFO/WARNING in prod).
    log_level: str = "INFO"
    # SURVEY's per-branch analysis loop (build_survey_tree) was fully
    # sequential -- one branch's analyze_section/title-tag/synthesis calls
    # complete before the next branch starts, even though branches are
    # independent (no branch reads another's output). Default of 1
    # preserves that exact behavior (zero risk, zero deployment
    # coordination needed) -- this is a real dial, not a free lunch: it
    # only helps if the configured LLM backend can actually SERVE more than
    # one generation concurrently. A local single-GPU Ollama instance
    # started with default settings (llama-server's own default is
    # `-np 1`, one parallel slot) gains NOTHING from raising this past 1 --
    # requests just queue backend-side instead of in this loop, and the
    # added complexity is pure waste. In a real multi-tenant deployment
    # (e.g. a shared Open WebUI/Ollama cluster already serving 100+ human
    # users' own chats), raise this ONLY in coordination with whoever
    # operates that backend's own concurrency limit (OLLAMA_NUM_PARALLEL or
    # equivalent) -- this is req2ado's own client-side fan-out, not a
    # request for more backend capacity than already exists; setting it
    # higher than the backend can truly serve concurrently adds queueing
    # delay and connection overhead for every one of those other users
    # without buying this job anything back.
    survey_branch_concurrency: int = 1
    # Kill switch for app/loaders/docx_pagination.py's docx->PDF page
    # alignment (see /ingest's own comment for wiring) -- default on, but
    # lets this be disabled without a code deploy if the LibreOffice
    # conversion causes latency or accuracy problems in practice. A failure
    # inside the alignment itself already degrades to `doc` unchanged (see
    # annotate_docx_pages's own try/except) -- this flag skips even
    # ATTEMPTING it, for when the conversion step itself is the problem
    # (e.g. contending on shared LibreOffice profile resources under load).
    docx_page_alignment_enabled: bool = True

    class Config:
        env_prefix = ""


settings = Settings()
