# ingestion/app/main.py
import json
import logging
import tempfile
from pathlib import Path

import redis
from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from app.canonical.model import CanonicalDoc
from app.chat.chat_client import ChatLlmClient
from app.chat.chat_service import run_chat_turn
from app.chat.redis_publisher import RedisChatPublisher
from app.config import settings
from app.dedup.check_for_duplicates import DuplicateCheckResult, check_for_duplicates
from app.dedup.orchestrator_embed_client import OrchestratorEmbedClient
from app.dedup.vector_store import ChromaVectorStore
from app.dispatch import dispatch_by_extension
from app.kb.graph_client import GraphApiError, GraphClient
from app.kb.ingest_service import FolderIngestResult, IngestResult, ingest_document_from_url, ingest_folder_from_url
from app.kb.kb_vector_store import KbVectorStore
from app.leveling.llm_leveling import build_survey_tree
from app.leveling.narration_publisher import NarrationPublisher
from app.leveling.tree_builder import build_baseline_tree
from app.quality.criteria_retrieval import CriteriaRetriever
from app.redaction.redactor import redact_canonical_doc
from app.survey.orchestrator_llm_client import OrchestratorLlmClient
from app.vision.orchestrator_vision_client import OrchestratorVisionClient
from app.workitem.model import WorkItemTree

logger = logging.getLogger(__name__)

app = FastAPI(title="req2ado-ingestion")

# settings.chroma_mode="embedded" (default, unset = same behavior as
# before this option existed) means a local PersistentClient -- does NOT
# survive horizontal scaling, each ingestion instance gets an independent,
# incomplete corpus copy. Set chroma_mode="http" (+ chroma_host/chroma_port)
# to connect to a real, shared Chroma server instead, making ingestion
# genuinely stateless and safe to run as multiple replicas. Same reasoning
# applies to _kb_vector_store below (KB corpus, not dedup corpus).
_embed_client = OrchestratorEmbedClient(settings.orchestrator_url, settings.llm_proxy_bearer)
_vector_store = ChromaVectorStore(
    settings.chroma_persist_path,
    mode=settings.chroma_mode,
    host=settings.chroma_host,
    port=settings.chroma_port,
)
_kb_vector_store = KbVectorStore(
    settings.chroma_persist_path,
    mode=settings.chroma_mode,
    host=settings.chroma_host,
    port=settings.chroma_port,
)
# None (default: llm_vision_model unset) means figure extraction stays a
# placeholder -- identical behavior to before vision support existed.
_vision_client = (
    OrchestratorVisionClient(settings.orchestrator_url, settings.llm_proxy_bearer)
    if settings.llm_vision_model
    else None
)
# Module-level singleton, mirroring _embed_client/_kb_vector_store above:
# RedisChatPublisher.__init__ opens a redis.asyncio connection pool via
# from_url() that is never explicitly closed. Constructing one per request
# (as /chat/{job_id}/{local_id}/turn used to) leaked a pool on every chat
# turn, risking FD/Redis maxclients exhaustion on a long-running process.
_chat_redis_publisher = RedisChatPublisher(settings.redis_url)
# Separate SYNCHRONOUS redis client (not redis.asyncio like the chat
# publisher above) -- build_survey_tree's progress_callback fires from
# inside run_in_threadpool, i.e. on a worker THREAD, not the event loop,
# where an async client can't be awaited without loop gymnastics a plain
# sync call sidesteps. See NarrationPublisher's own docstring.
_narration_redis = redis.Redis.from_url(settings.redis_url)


def _describe_figure(image_bytes: bytes) -> str:
    return _vision_client.describe_figure(image_bytes)


# Lazily constructed (NOT at import time, unlike _vector_store above) --
# CriteriaRetriever's constructor makes a real embed() HTTP call to embed
# the corpus, and eagerly doing that at module-import time would make every
# test that imports `app.main` (most of the ingestion test suite) depend on
# a live embed proxy. Built on first actual SURVEY-mode-with-scoring request
# instead, and cached from then on (the corpus is static, no need to
# re-embed it every request). A failure to build it (embed proxy down,
# network error) degrades to ungrounded scoring (criteria_retriever=None)
# rather than failing the whole SURVEY job -- same "fail open" philosophy
# as the dedup check in dry-run.service.ts.
_criteria_retriever: CriteriaRetriever | None = None
_criteria_retriever_build_attempted = False


def _get_criteria_retriever() -> CriteriaRetriever | None:
    global _criteria_retriever, _criteria_retriever_build_attempted
    if _criteria_retriever_build_attempted:
        return _criteria_retriever
    _criteria_retriever_build_attempted = True
    try:
        _criteria_retriever = CriteriaRetriever(_embed_client)
    except Exception:
        logger.warning("Failed to build CriteriaRetriever -- SURVEY quality scoring will run ungrounded", exc_info=True)
        _criteria_retriever = None
    return _criteria_retriever


def _build_survey_tree_with_scoring(
    doc: CanonicalDoc,
    client: OrchestratorLlmClient,
    customer_id: str | None,
    area_path: str | None,
    link_type_catalog: list[dict] | None,
    job_id: str | None,
) -> WorkItemTree:
    """Wraps build_survey_tree so BOTH the (possibly network-calling)
    CriteriaRetriever construction above AND the tree-building itself run
    inside run_in_threadpool -- constructing the retriever inline in the
    async /level route (before dispatching to the threadpool) would block
    the event loop for its httpx call, the exact problem run_in_threadpool
    below is already there to avoid for build_survey_tree itself.

    area_path is optional: when the caller omits it (no KB scope known
    yet), build_survey_tree skips KB retrieval entirely and behaves exactly
    as it did before KB retrieval existed. link_type_client is only wired
    up when a catalog was actually supplied -- passing it unconditionally
    would make every survey call (including every pre-existing caller that
    omits this param) issue an extra infer_trace_links call, changing
    behavior for callers this must leave untouched. An empty catalog is
    treated the same as no catalog at all -- infer_trace_links has nothing
    to validate against, so skipping it matches pipeline.worker.ts's
    documented degraded-mode contract (empty catalog -> empty trace_links,
    never blocking the rest of the job).

    job_id is optional: when the caller omits it (no job context, e.g. a
    direct test/curl call), no narration is published -- build_survey_tree
    behaves exactly as it did before narration existed."""
    progress_callback = None
    if job_id is not None:
        progress_callback = NarrationPublisher(_narration_redis, job_id).publish
    return build_survey_tree(
        doc,
        llm_client=client,
        requirement_client=client,
        scoring_client=client,
        customer_id=customer_id,
        criteria_retriever=_get_criteria_retriever(),
        area_path=area_path,
        embed_client=_embed_client,
        vector_store=_kb_vector_store,
        link_type_client=client if link_type_catalog else None,
        link_type_catalog=link_type_catalog,
        # Same client, same "only wired when actually usable" convention as
        # link_type_client above -- verification is meaningless without KB
        # retrieval itself being enabled (area_path set).
        kb_relevance_client=client if area_path else None,
        progress_callback=progress_callback,
    )


class DedupCheckRequest(BaseModel):
    text: str
    area_path: str


class DedupUpsertRequest(BaseModel):
    item_id: str
    text: str
    area_path: str


class DedupUpsertBatchRequest(BaseModel):
    items: list[DedupUpsertRequest]


class KbIngestUrlRequest(BaseModel):
    url: str
    area_path: str
    doc_type: str | None = None
    recursive: bool = False  # ignored by /kb/ingest-url (single doc); folder route only


class ChatTurnItem(BaseModel):
    type: str
    title: str
    description: str
    childType: str | None = None
    qualityIssues: list[str] = []


class ChatTurnMessage(BaseModel):
    role: str
    content: str


class ChatTurnRequest(BaseModel):
    item: ChatTurnItem
    history: list[ChatTurnMessage] = []
    message: str
    model: str | None = None
    area_path: str | None = None


@app.get("/health")
def health() -> dict[str, bool]:
    # Liveness: process is up, nothing more. Deliberately does NOT check
    # Chroma -- a k8s liveness-probe failure restarts the pod, the wrong
    # response to "a dependency blipped" (that's what /ready is for).
    # Previously the ONLY health endpoint, unconditional {ok:True}.
    return {"ok": True}


@app.get("/ready")
def ready() -> Response:
    chroma_ok = _vector_store.ping()
    body = {"ok": chroma_ok, "chroma": chroma_ok}
    if not chroma_ok:
        return JSONResponse(status_code=503, content=body)
    return JSONResponse(status_code=200, content=body)


_UPLOAD_READ_CHUNK_BYTES = 1024 * 1024


@app.post("/ingest", response_model=CanonicalDoc)
async def ingest(file: UploadFile, redact: bool = False, languages: str = "eng") -> CanonicalDoc:
    # Previously `tmp.write(await file.read())` -- the whole upload was
    # buffered into memory unconditionally, with no size guard at this
    # layer at all (the orchestrator's own upload-size check happens before
    # it forwards a file here, but this endpoint is independently reachable
    # and had zero protection if called directly). Now streams in bounded
    # chunks and aborts as soon as the configured cap is exceeded, rather
    # than reading the entire body first and checking after the fact.
    max_bytes = settings.max_upload_size_mb * 1024 * 1024
    suffix = Path(file.filename or "").suffix
    total_bytes = 0
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp_path = tmp.name
        while chunk := await file.read(_UPLOAD_READ_CHUNK_BYTES):
            total_bytes += len(chunk)
            if total_bytes > max_bytes:
                Path(tmp_path).unlink(missing_ok=True)
                raise HTTPException(
                    status_code=413,
                    detail=f"file exceeds the {settings.max_upload_size_mb}MB upload limit",
                )
            tmp.write(chunk)

    try:
        # run_in_threadpool: dispatch_by_extension can now make a real
        # network call per figure (vision description) when
        # LLM_VISION_MODEL is configured, on top of the CPU-bound
        # parsing/OCR work it already did -- must not block the event loop
        # (same reasoning as /level's SURVEY path).
        doc = await run_in_threadpool(
            dispatch_by_extension,
            file.filename or "",
            tmp_path,
            languages=languages,
            describe_figure=_describe_figure if _vision_client is not None else None,
        )
    finally:
        Path(tmp_path).unlink(missing_ok=True)

    if redact:
        doc = redact_canonical_doc(doc)
    return doc


@app.post("/level", response_model=WorkItemTree)
async def level(
    doc: CanonicalDoc,
    customer_id: str | None = None,
    mode: str = "baseline",
    area_path: str | None = None,
    link_type_catalog: str | None = None,
    model: str | None = None,
    job_id: str | None = None,
) -> WorkItemTree:
    if mode == "survey":
        # One real client instance satisfies both Protocols build_survey_tree
        # needs (LlmLevelingClient, BatchedRequirementClient) — see Task 1's
        # docstring. run_in_threadpool: OrchestratorLlmClient's HTTP calls are
        # synchronous (httpx.Client, not an async client) — calling
        # build_survey_tree inline in this async route would block ingestion's
        # single-worker event loop for the whole job's duration, starving
        # every other concurrent request (including /health). Moving the
        # blocking work to FastAPI's threadpool keeps the loop free.
        # link_type_catalog arrives as a JSON-encoded query param (matches
        # the existing lightweight query-param style used by customer_id/
        # area_path here) rather than restructuring the request body around
        # CanonicalDoc — the orchestrator is the only caller that populates it.
        # model is an optional per-job override of the orchestrator's own
        # LLM_CHAT_MODEL default (see OpenWebUiClient.chat's opts.model) --
        # unset means "use whatever the orchestrator is configured with",
        # matching pre-model-selection behavior exactly.
        client = OrchestratorLlmClient(settings.orchestrator_url, settings.llm_proxy_bearer, model=model)
        catalog = json.loads(link_type_catalog) if link_type_catalog else None
        return await run_in_threadpool(
            _build_survey_tree_with_scoring, doc, client, customer_id, area_path, catalog, job_id
        )
    return build_baseline_tree(doc, customer_id=customer_id)


@app.post("/dedup/check", response_model=DuplicateCheckResult)
async def dedup_check(body: DedupCheckRequest) -> DuplicateCheckResult:
    return check_for_duplicates(
        body.text, item_id="", area_path=body.area_path, embed_client=_embed_client, vector_store=_vector_store
    )


@app.post("/dedup/upsert")
async def dedup_upsert(body: DedupUpsertRequest) -> dict[str, bool]:
    [embedding] = _embed_client.embed([body.text])
    _vector_store.upsert(body.item_id, embedding, body.area_path)
    return {"ok": True}


@app.post("/dedup/upsert-batch")
async def dedup_upsert_batch(body: DedupUpsertBatchRequest) -> dict[str, bool]:
    # Previously every confirmed work item triggered its own single-item
    # /dedup/upsert call (one embed() round-trip per item) from
    # JobsService.confirm()'s per-node loop, despite embed() already
    # accepting a list. Batches all items' texts into ONE embed() call.
    if not body.items:
        return {"ok": True}
    embeddings = _embed_client.embed([item.text for item in body.items])
    for item, embedding in zip(body.items, embeddings):
        _vector_store.upsert(item.item_id, embedding, item.area_path)
    return {"ok": True}


@app.post("/kb/ingest-url", response_model=IngestResult)
async def kb_ingest_url(body: KbIngestUrlRequest) -> IngestResult:
    # Token from env (SHAREPOINT_TOKEN / GRAPH_TOKEN). GraphClient raises
    # ValueError if unset — mapped to 400 below. ingest_document_from_url
    # makes synchronous httpx calls; run in the threadpool like /level and
    # the old /kb/sync so it never blocks the single-worker event loop.
    try:
        graph_client = GraphClient(settings.sharepoint_token or "", settings.graph_base_url)
        return await run_in_threadpool(
            ingest_document_from_url,
            body.url,
            body.area_path,
            body.doc_type,
            graph_client,
            _embed_client,
            _kb_vector_store,
        )
    except ValueError as exc:
        # SSRF/scheme/host/size/content-type violation, or missing token.
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except GraphApiError as exc:
        # Surface Graph's own status where it maps cleanly; else 502.
        status = exc.status if exc.status in (401, 403, 404) else 502
        raise HTTPException(status_code=status, detail=str(exc)) from exc


@app.post("/kb/ingest-folder-url", response_model=FolderIngestResult)
async def kb_ingest_folder_url(body: KbIngestUrlRequest) -> FolderIngestResult:
    # Same token/threadpool reasoning as /kb/ingest-url. Unlike the
    # single-document route, per-file failures are collected into the
    # response rather than raised — one bad file must not abort the batch.
    # Listing the folder itself (validate_share_url, list_folder_children)
    # can still fail with ValueError/GraphApiError, mapped the same way.
    try:
        graph_client = GraphClient(settings.sharepoint_token or "", settings.graph_base_url)
        return await run_in_threadpool(
            ingest_folder_from_url,
            body.url,
            body.area_path,
            body.doc_type,
            graph_client,
            _embed_client,
            _kb_vector_store,
            body.recursive,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except GraphApiError as exc:
        # 400 included here (unlike the single-doc route): Graph's own
        # response to /children on a non-folder driveItem is a 400, and that
        # is a client input error ("this link isn't a folder"), not a
        # Graph-unreachable 502.
        status = exc.status if exc.status in (400, 401, 403, 404) else 502
        raise HTTPException(status_code=status, detail=str(exc)) from exc


@app.post("/chat/{job_id}/{local_id}/turn")
async def chat_turn(job_id: str, local_id: str, body: ChatTurnRequest) -> dict[str, bool]:
    # ChatLlmClient and RedisChatPublisher are fully async (httpx.AsyncClient,
    # redis.asyncio) — no run_in_threadpool needed for those, unlike /level
    # and /kb/ingest-*, which wrap synchronous httpx.Client calls. However,
    # run_chat_turn also calls retrieve_context, which IS a blocking sync
    # call (embed client + vector store I/O) — it's wrapped in
    # run_in_threadpool inside run_chat_turn itself (chat_service.py), so
    # this route stays non-blocking end-to-end. The caller (orchestrator's
    # ChatService) doesn't await this request's completion either way — see
    # chat.service.ts.
    chat_client = ChatLlmClient(settings.orchestrator_url, settings.llm_proxy_bearer)
    await run_chat_turn(
        job_id,
        local_id,
        body.item.model_dump(),
        [m.model_dump() for m in body.history],
        body.message,
        body.model,
        body.area_path,
        _embed_client,
        _kb_vector_store,
        chat_client,
        _chat_redis_publisher,
    )
    return {"ok": True}
