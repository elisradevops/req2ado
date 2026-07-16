# ingestion/app/main.py
import tempfile
from pathlib import Path

from fastapi import FastAPI, HTTPException, UploadFile
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
from app.leveling.tree_builder import build_baseline_tree
from app.redaction.redactor import redact_canonical_doc
from app.survey.orchestrator_llm_client import OrchestratorLlmClient
from app.workitem.model import WorkItemTree

app = FastAPI(title="req2ado-ingestion")

# LIMITATION (documented, not fixed in this phase): ChromaVectorStore's local
# PersistentClient does not survive horizontal scaling. Each ingestion
# instance gets an independent, incomplete corpus copy — dedup correctness
# requires ingestion to run as a SINGLE instance until Chroma is externalized
# to a shared server (chromadb.HttpClient against a real Chroma deployment).
# Matches the current Dockerfile (single uvicorn worker, no shared volume).
_embed_client = OrchestratorEmbedClient(settings.orchestrator_url, settings.llm_proxy_bearer)
_vector_store = ChromaVectorStore(settings.chroma_persist_path)
_kb_vector_store = KbVectorStore(settings.chroma_persist_path)
# Module-level singleton, mirroring _embed_client/_kb_vector_store above:
# RedisChatPublisher.__init__ opens a redis.asyncio connection pool via
# from_url() that is never explicitly closed. Constructing one per request
# (as /chat/{job_id}/{local_id}/turn used to) leaked a pool on every chat
# turn, risking FD/Redis maxclients exhaustion on a long-running process.
_chat_redis_publisher = RedisChatPublisher(settings.redis_url)


class DedupCheckRequest(BaseModel):
    text: str
    area_path: str


class DedupUpsertRequest(BaseModel):
    item_id: str
    text: str
    area_path: str


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
    return {"ok": True}


@app.post("/ingest", response_model=CanonicalDoc)
async def ingest(file: UploadFile, redact: bool = False, languages: str = "eng") -> CanonicalDoc:
    suffix = Path(file.filename or "").suffix
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name

    try:
        doc = dispatch_by_extension(file.filename or "", tmp_path, languages=languages)
    finally:
        Path(tmp_path).unlink(missing_ok=True)

    if redact:
        doc = redact_canonical_doc(doc)
    return doc


@app.post("/level", response_model=WorkItemTree)
async def level(
    doc: CanonicalDoc, customer_id: str | None = None, mode: str = "baseline", area_path: str | None = None
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
        # area_path is optional here: when the caller omits it (no KB scope
        # known yet), build_survey_tree skips retrieval entirely and behaves
        # exactly as it did before KB retrieval existed.
        client = OrchestratorLlmClient(settings.orchestrator_url, settings.llm_proxy_bearer)
        return await run_in_threadpool(
            build_survey_tree,
            doc,
            llm_client=client,
            requirement_client=client,
            area_path=area_path,
            embed_client=_embed_client,
            vector_store=_kb_vector_store,
            scoring_client=client,
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
