# ingestion/app/config.py
from __future__ import annotations

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


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
    # DUPLICATED, deliberately, from the orchestrator's own EMBED_MODEL
    # config (orchestrator/src/config/config.schema.ts) — the /llm/embed
    # proxy response carries only raw vectors, no model identifier, and
    # adding one would be a cross-service HTTP contract change. Both
    # services read the SAME env var name out of the same shared
    # environment (docker-compose `env_file: .env`, which .env.template
    # already declares EMBED_MODEL in; k8s `envFrom: configMapRef:
    # req2ado-config`, which 01-configmap.yaml already sets), so at runtime
    # they cannot disagree unless someone wires the var to only one service.
    # Same deliberate-duplication rationale as max_upload_size_mb below;
    # unlike that one, this pair has a mechanical drift guard —
    # ingestion/tests/test_embed_model_drift.py.
    #
    # Consumed by dedup/vector_store.py and kb/kb_vector_store.py to stamp
    # the embed model into every Chroma collection name, so swapping the
    # embed model can never silently compare new query vectors against
    # vectors that some OTHER model produced. Default matches the value
    # k8s/01-configmap.yaml ships.
    embed_model: str = "nomic-embed-text"
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
    # How many figures may be captioned concurrently by /ingest's post-parse
    # captioning pass. Vision captioning used to run fully inline during the
    # document walk -- one network round-trip per figure, strictly in
    # document order -- so a 39-figure document performed 39 sequential
    # vision calls, each with up to vision_request_timeout_seconds above to
    # spend. Its own dial, separate from survey_branch_concurrency/
    # survey_chunk_concurrency: this is a different model behind a different
    # client (_vision_client / LLM_VISION_MODEL), whose backend capacity is
    # an independent operational fact, and it runs in /ingest rather than
    # /level so it never overlaps with either of those.
    #
    # Default of 1 preserves the exact previous behavior (no
    # ThreadPoolExecutor is constructed at all at 1) and carries the SAME
    # operator caveat survey_branch_concurrency's own comment below spells
    # out in full: this is req2ado's own client-side fan-out, not a request
    # for more backend capacity. Raising it only helps if the configured
    # vision backend can genuinely serve more than one generation at a time;
    # on a shared backend, raise it only in coordination with whoever
    # operates that backend's own concurrency limit.
    vision_caption_concurrency: int = 1
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
    # The chunk-level counterpart to survey_branch_concurrency above, for
    # the five chunked whole-document/whole-subtree LLM enhancement passes
    # (title/tag, requirement-text synthesis, Epic/Feature parent summary,
    # requirement quality scoring, Epic/Feature quality scoring). Each of
    # those splits its work into independent chunks and, before this dial
    # existed, always issued them one at a time -- the dominant wall-clock
    # term on a large document.
    #
    # Separate dial, not a reuse of survey_branch_concurrency, because the
    # two never compound: not one of those five passes runs inside a branch
    # worker (title/tag, synthesis and parent-summary all run inside
    # _detect_deterministic_subtrees' sequential subtree loop, before the
    # branch loop exists; both scoring passes run at whole-document scope
    # after every branch executor has shut down). So an operator can raise
    # this one without also raising branch concurrency, and total in-flight
    # requests is max(this, branch), never the product.
    #
    # Default of 1 preserves the exact previous behavior (no
    # ThreadPoolExecutor is constructed at all at 1) and carries the SAME
    # operator warning survey_branch_concurrency's own comment above spells
    # out in full: this is req2ado's own client-side fan-out, not a request
    # for more backend capacity. A local single-GPU Ollama with default
    # settings (one parallel slot) gains nothing from raising this; on a
    # shared backend, raise it only in coordination with whoever operates
    # that backend's own concurrency limit.
    survey_chunk_concurrency: int = 1
    # Kill switch for scoring.py's §7 canary/drift probe (the fixed,
    # known-bad sentinel requirement injected into every quality-scoring
    # batch -- see _CANARY_NODE_ID's own module comment). Default on,
    # preserving current behavior, but the live finding that a chunk's score
    # is dominated by neighboring context (byte-identical descriptions in
    # different chunks scored 85 vs 20 at temperature=0, see scoring.py)
    # means the canary's mere presence in the prompt could plausibly anchor
    # or shift real scores -- this lets an operator turn it off without a
    # code deploy if that turns out to matter in production.
    survey_scoring_canary_enabled: bool = True
    # Kill switch for app/loaders/docx_pagination.py's docx->PDF page
    # alignment (see /ingest's own comment for wiring) -- default on, but
    # lets this be disabled without a code deploy if the LibreOffice
    # conversion causes latency or accuracy problems in practice. A failure
    # inside the alignment itself already degrades to `doc` unchanged (see
    # annotate_docx_pages's own try/except) -- this flag skips even
    # ATTEMPTING it, for when the conversion step itself is the problem
    # (e.g. contending on shared LibreOffice profile resources under load).
    docx_page_alignment_enabled: bool = True

    # env_ignore_empty: a var PRESENT BUT BLANK in a real .env file
    # (`SURVEY_CHUNK_CONCURRENCY=`, a shape .env.template's own commented-out
    # examples invite) is treated as UNSET and falls back to the field
    # default, instead of being parsed as the empty string and crashing the
    # whole process at import time with a pydantic ValidationError. Every
    # non-str field here is exposed to that -- the concurrency dials
    # (survey_branch_concurrency / survey_chunk_concurrency /
    # vision_caption_concurrency) and the bool kill switches most obviously,
    # since they are the ones an operator is most likely to comment out by
    # emptying rather than deleting.
    model_config = SettingsConfigDict(env_prefix="", env_ignore_empty=True)


settings = Settings()
