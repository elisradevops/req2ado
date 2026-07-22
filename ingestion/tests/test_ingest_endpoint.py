# ingestion/tests/test_ingest_endpoint.py
import tempfile
from pathlib import Path

from fastapi.testclient import TestClient

from app.config import settings
from app.main import app

client = TestClient(app)
FIXTURES = Path(__file__).parent / "fixtures"


def _upload(filename: str, path: Path, redact: bool = False) -> dict:
    with open(path, "rb") as f:
        response = client.post(
            "/ingest",
            params={"redact": redact},
            files={"file": (filename, f, "application/octet-stream")},
        )
    assert response.status_code == 200
    return response.json()


def test_ingest_txt() -> None:
    body = _upload("sample.txt", FIXTURES / "sample.txt")
    assert body["document"]["format"] == "txt"
    assert len(body["blocks"]) == 2


def test_ingest_markdown() -> None:
    body = _upload("sample.md", FIXTURES / "sample.md")
    assert body["document"]["format"] == "md"
    assert any(b["kind"] == "heading" for b in body["blocks"])


def test_ingest_docx() -> None:
    body = _upload("sample.docx", FIXTURES / "sample.docx")
    assert body["document"]["format"] == "docx"
    assert len(body["tables"]) == 1


def test_ingest_xlsx() -> None:
    body = _upload("sample.xlsx", FIXTURES / "sample.xlsx")
    assert body["document"]["format"] == "xlsx"
    assert len(body["tables"]) == 2


def test_ingest_pdf() -> None:
    body = _upload("sample.pdf", FIXTURES / "sample.pdf")
    assert body["document"]["format"] == "pdf"
    assert len(body["blocks"]) >= 1


def test_ingest_scanned_pdf_via_ocr() -> None:
    body = _upload("scanned_sample.pdf", FIXTURES / "scanned_sample.pdf")
    assert body["document"]["format"] == "pdf_scanned"
    assert any(b["kind"] == "open_tbd" for b in body["blocks"])


def test_ingest_with_redact_strips_emails() -> None:
    # sample.txt has no email, so use a temp fixture with one inline
    import tempfile

    with tempfile.NamedTemporaryFile(suffix=".txt", mode="w", delete=False) as f:
        f.write("Contact jane.doe@example.com for details.")
        temp_path = Path(f.name)

    body = _upload(temp_path.name, temp_path, redact=True)
    assert "jane.doe@example.com" not in body["blocks"][0]["text"]
    temp_path.unlink()


def test_ingest_rejects_a_file_exceeding_the_configured_size_cap(monkeypatch) -> None:
    # Regression: /ingest previously buffered the whole upload into memory
    # with no size guard of its own at this layer (the orchestrator's own
    # check happens before forwarding here, but this endpoint is
    # independently reachable). Set a tiny cap so a small fixture trips it
    # without needing to actually construct a huge file.
    monkeypatch.setattr(settings, "max_upload_size_mb", 0)  # effectively 0 bytes allowed
    with tempfile.NamedTemporaryFile(suffix=".txt", mode="w", delete=False) as f:
        f.write("more than zero bytes of content")
        temp_path = Path(f.name)

    with open(temp_path, "rb") as f:
        response = client.post(
            "/ingest", files={"file": (temp_path.name, f, "application/octet-stream")}
        )
    assert response.status_code == 413
    temp_path.unlink()


def test_ingest_unsupported_extension_returns_400() -> None:
    import tempfile

    with tempfile.NamedTemporaryFile(suffix=".exe", mode="wb", delete=False) as f:
        f.write(b"not a real document")
        temp_path = Path(f.name)

    with open(temp_path, "rb") as f:
        response = client.post(
            "/ingest", files={"file": (temp_path.name, f, "application/octet-stream")}
        )
    assert response.status_code == 400
    temp_path.unlink()
