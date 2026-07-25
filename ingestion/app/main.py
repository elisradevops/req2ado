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
from app.leveling.llm_leveling import _resolve_caps, build_survey_tree
from app.leveling.narration_publisher import NarrationPublisher
from app.leveling.tree_builder import build_baseline_tree
from app.quality.criteria_retrieval import CriteriaRetriever
from app.redaction.redactor import redact_canonical_doc
from app.survey.orchestrator_llm_client import OrchestratorLlmClient
from app.vision.emf_converter import convert_vector_image_to_png, sniff_vector_image_extension
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


def _sniff_image_mime_type(image_bytes: bytes) -> str | None:
    """Magic-byte sniff, not a filename/extension guess -- every
    describe_figure caller only ever has raw bytes (a docx/pptx-embedded
    image, or a standalone image file already opened into memory). Returns
    None for a non-raster format this function doesn't handle (e.g. a
    docx-embedded EMF/WMF vector graphic) -- _describe_figure now attempts a
    real conversion for that case (see emf_converter.py) before falling back
    to the orchestrator's pre-existing image/png default."""
    if image_bytes.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if image_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if image_bytes.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if image_bytes.startswith(b"BM"):
        return "image/bmp"
    if image_bytes.startswith(b"RIFF") and image_bytes[8:12] == b"WEBP":
        return "image/webp"
    if image_bytes.startswith((b"II*\x00", b"MM\x00*")):
        return "image/tiff"
    return None


def _describe_figure(image_bytes: bytes) -> str:
    # Sniffed from the actual bytes, not a filename extension -- every
    # caller (docx/pptx-embedded figures, standalone image files) hands over
    # raw bytes with no reliable filename/extension of their own, so this is
    # the one place that can know the real type. Previously the orchestrator
    # hardcoded image/png regardless of actual content (see
    # OrchestratorVisionClient.describe_figure's docstring) -- harmless for
    # an actual PNG, silently wrong for anything else.
    mime_type = _sniff_image_mime_type(image_bytes)
    if mime_type is None:
        # Not a raster format at all -- most commonly an EMF/WMF vector
        # metafile (Word's embedding format for a pasted Visio/PowerPoint
        # diagram), which the vision endpoint can never describe correctly
        # regardless of mimeType label (see emf_converter.py). Convert to a
        # real raster image first; if that fails or the bytes are some other
        # unrecognized format entirely, fall through to the pre-existing
        # behavior (image/png default, likely still wrong but no worse than
        # before this conversion path existed).
        vector_extension = sniff_vector_image_extension(image_bytes)
        if vector_extension is not None:
            converted = convert_vector_image_to_png(image_bytes, vector_extension)
            if converted is not None:
                image_bytes = converted
                mime_type = "image/png"
    return _vision_client.describe_figure(image_bytes, mime_type)


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
    user_id: str | None,
    link_type_catalog: list[dict] | None,
    job_id: str | None,
    model: str | None = None,
) -> WorkItemTree:
    """Wraps build_survey_tree so BOTH the (possibly network-calling)
    CriteriaRetriever construction above AND the tree-building itself run
    inside run_in_threadpool -- constructing the retriever inline in the
    async /level route (before dispatching to the threadpool) would block
    the event loop for its httpx call, the exact problem run_in_threadpool
    below is already there to avoid for build_survey_tree itself.

    user_id is optional: when the caller omits it (no KB scope known yet),
    build_survey_tree skips KB retrieval entirely and behaves exactly as it
    did before KB retrieval existed. The Knowledge Base is scoped by this
    submitting user's identity, NOT any ADO area path (see
    KbVectorStore's own docstring) -- a job's ADO destination is unrelated
    to which KB documents its owner has ingested. link_type_client is only
    wired up when a catalog was actually supplied -- passing it
    unconditionally would make every survey call (including every
    pre-existing caller that omits this param) issue an extra
    infer_trace_links call, changing behavior for callers this must leave
    untouched. An empty catalog is treated the same as no catalog at all --
    infer_trace_links has nothing to validate against, so skipping it
    matches pipeline.worker.ts's documented degraded-mode contract (empty
    catalog -> empty trace_links, never blocking the rest of the job).

    job_id is optional: when the caller omits it (no job context, e.g. a
    direct test/curl call), no narration is published -- build_survey_tree
    behaves exactly as it did before narration existed."""
    progress_callback = None
    if job_id is not None:
        progress_callback = NarrationPublisher(_narration_redis, job_id).publish
    return build_survey_tree(
        doc,
        analysis_client=client,
        scoring_client=client,
        customer_id=customer_id,
        criteria_retriever=_get_criteria_retriever(),
        user_id=user_id,
        embed_client=_embed_client,
        vector_store=_kb_vector_store,
        link_type_client=client if link_type_catalog else None,
        link_type_catalog=link_type_catalog,
        # Same client, same "only wired when actually usable" convention as
        # link_type_client above -- verification is meaningless without KB
        # retrieval itself being enabled (user_id set), and only applies to
        # the non-tool-capable fallback path in the first place (§5c).
        kb_relevance_client=client if user_id else None,
        progress_callback=progress_callback,
        model=model,
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
    user_id: str
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
    user_id: str | None = None


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
async def ingest(
    file: UploadFile, redact: bool = False, languages: str = "eng", skip_vision: bool = False
) -> CanonicalDoc:
    # skip_vision: /jobs/preview (orchestrator) only needs blockCount/
    # sectionCount/fileType to show the user before they even pick a mode --
    # it never reads figure captions. Without this, every embedded image in
    # a merely-previewed document paid the full per-image vision-LLM
    # inference cost (observed live: a single small image made preview take
    # 28s instead of ~30ms) for output nobody uses. Real job submission
    # (pipeline.worker.ts) never sets this -- captions still matter there.
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
            describe_figure=_describe_figure if (_vision_client is not None and not skip_vision) else None,
        )
    finally:
        Path(tmp_path).unlink(missing_ok=True)

    if redact:
        doc = redact_canonical_doc(doc)
    return doc


# Gemma4 repetition-collapse mitigation (confirmed upstream bug,
# ollama/ollama#15502) -- these are the Gemma4 team's own release-note-
# recommended sampler settings, confirmed in ollama/ollama#15502 to reduce
# degenerate token-repetition on long generations. Applied unconditionally
# to every SURVEY analysis call (see OrchestratorLlmClient's top_k/min_p
# forwarding) -- harmless for any other model/backend that ignores the
# passthrough options field (see LlmChatOptions.topK/minP's own docstring).
_SURVEY_TOP_K = 50
_SURVEY_MIN_P = 0.05


@app.post("/level", response_model=WorkItemTree)
async def level(
    doc: CanonicalDoc,
    customer_id: str | None = None,
    mode: str = "baseline",
    user_id: str | None = None,
    link_type_catalog: str | None = None,
    model: str | None = None,
    job_id: str | None = None,
) -> WorkItemTree:
    if mode == "survey":
        # One real client instance satisfies SectionAnalysisClient (and every
        # other build_survey_tree Protocol). run_in_threadpool:
        # OrchestratorLlmClient's HTTP calls are synchronous (httpx.Client,
        # not an async client) — calling build_survey_tree inline in this
        # async route would block ingestion's single-worker event loop for
        # the whole job's duration, starving every other concurrent request
        # (including /health). Moving the blocking work to FastAPI's
        # threadpool keeps the loop free.
        # link_type_catalog arrives as a JSON-encoded query param (matches
        # the existing lightweight query-param style used by customer_id/
        # user_id here) rather than restructuring the request body around
        # CanonicalDoc — the orchestrator is the only caller that populates it.
        # model is an optional per-job override of the orchestrator's own
        # LLM_CHAT_MODEL default (see OpenWebUiClient.chat's opts.model) --
        # unset means "use whatever the orchestrator is configured with",
        # matching pre-model-selection behavior exactly. Also resolved by
        # build_survey_tree's own _resolve_caps(model) for branch-size cap +
        # tool-calling capability (§5c/§6).
        # num_ctx (§6 of the whole-document redesign): Ollama's actual
        # runtime context window isn't what a model's architectural max
        # implies -- without setting it explicitly, Ollama truncates to its
        # own small default regardless of how large a prompt this proxies,
        # so the §3 whole-document gate's promise ("fits budget -> analyzed
        # in one call") wouldn't actually hold for a local model. Sized from
        # the SAME _resolve_caps(model) budget build_survey_tree itself uses
        # for the gate decision, so num_ctx and the gate never disagree. A
        # genuine OpenAI-compat backend (the production frontier-model
        # proxy) ignores this unrecognized field -- harmless to always send.
        num_ctx = _resolve_caps(model).context_budget_tokens
        client = OrchestratorLlmClient(
            settings.orchestrator_url, settings.llm_proxy_bearer, model=model, num_ctx=num_ctx,
            top_k=_SURVEY_TOP_K, min_p=_SURVEY_MIN_P,
        )
        catalog = json.loads(link_type_catalog) if link_type_catalog else None
        return await run_in_threadpool(
            _build_survey_tree_with_scoring, doc, client, customer_id, user_id, catalog, job_id, model
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
            body.user_id,
            body.doc_type,
            graph_client,
            _embed_client,
            _kb_vector_store,
            describe_figure=_describe_figure if _vision_client is not None else None,
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
            body.user_id,
            body.doc_type,
            graph_client,
            _embed_client,
            _kb_vector_store,
            body.recursive,
            describe_figure=_describe_figure if _vision_client is not None else None,
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
        body.user_id,
        _embed_client,
        _kb_vector_store,
        chat_client,
        _chat_redis_publisher,
    )
    return {"ok": True}
