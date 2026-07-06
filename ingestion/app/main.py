# ingestion/app/main.py
import tempfile
from pathlib import Path

from fastapi import FastAPI, UploadFile
from starlette.concurrency import run_in_threadpool

from app.canonical.model import CanonicalDoc
from app.config import settings
from app.dispatch import dispatch_by_extension
from app.leveling.llm_leveling import build_survey_tree
from app.leveling.tree_builder import build_baseline_tree
from app.redaction.redactor import redact_canonical_doc
from app.survey.orchestrator_llm_client import OrchestratorLlmClient
from app.workitem.model import WorkItemTree

app = FastAPI(title="req2ado-ingestion")


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
