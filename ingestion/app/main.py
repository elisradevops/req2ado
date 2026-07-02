# ingestion/app/main.py
import tempfile
from pathlib import Path

from fastapi import FastAPI, UploadFile

from app.canonical.model import CanonicalDoc
from app.dispatch import dispatch_by_extension
from app.leveling.tree_builder import build_baseline_tree
from app.redaction.redactor import redact_canonical_doc
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
async def level(doc: CanonicalDoc) -> WorkItemTree:
    return build_baseline_tree(doc)
