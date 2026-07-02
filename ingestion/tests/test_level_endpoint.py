from fastapi.testclient import TestClient

from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef
from app.main import app

client = TestClient(app)


def _sr(path: str) -> SourceRef:
    return SourceRef(document_path=path, start_offset=0, end_offset=10)


def test_level_endpoint_returns_worktree_json() -> None:
    doc = CanonicalDoc(
        document=Document(path="x.txt", format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="1 Receiver", source_ref=_sr("x.txt")),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="1.1 Broadcast & Inputs", source_ref=_sr("x.txt")),
            Block(id="b2", kind=BlockKind.PARAGRAPH, text="1.1.1 Channel Scan", source_ref=_sr("x.txt")),
        ],
    )
    response = client.post("/level", json=doc.model_dump(mode="json"))
    assert response.status_code == 200
    body = response.json()
    assert len(body["nodes"]) == 3
    assert body["nodes"][0]["type"] == "Epic"
    assert body["nodes"][1]["type"] == "Epic"
    assert body["nodes"][2]["type"] == "Feature"
