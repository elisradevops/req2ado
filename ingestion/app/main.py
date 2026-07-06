# ingestion/app/main.py
import tempfile
from pathlib import Path

from fastapi import FastAPI, UploadFile
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from app.canonical.model import CanonicalDoc
from app.config import settings
from app.dedup.check_for_duplicates import DuplicateCheckResult, check_for_duplicates
from app.dedup.orchestrator_embed_client import OrchestratorEmbedClient
from app.dedup.vector_store import ChromaVectorStore
from app.dispatch import dispatch_by_extension
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


class DedupCheckRequest(BaseModel):
    text: str
    area_path: str


class DedupUpsertRequest(BaseModel):
    item_id: str
    text: str
    area_path: str


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
async def level(doc: CanonicalDoc, customer_id: str | None = None, mode: str = "baseline") -> WorkItemTree:
    if mode == "survey":
        # One real client instance satisfies both Protocols build_survey_tree
        # needs (LlmLevelingClient, BatchedRequirementClient) — see Task 1's
        # docstring. run_in_threadpool: OrchestratorLlmClient's HTTP calls are
        # synchronous (httpx.Client, not an async client) — calling
        # build_survey_tree inline in this async route would block ingestion's
        # single-worker event loop for the whole job's duration, starving
        # every other concurrent request (including /health). Moving the
        # blocking work to FastAPI's threadpool keeps the loop free.
        client = OrchestratorLlmClient(settings.orchestrator_url, settings.llm_proxy_bearer)
        return await run_in_threadpool(build_survey_tree, doc, llm_client=client, requirement_client=client)
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
