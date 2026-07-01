# Phase 1 Multi-Format Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `ingestion` Python/FastAPI package that converts txt/md/docx/pdf/scanned-pdf/xlsx documents into the canonical `CanonicalDoc` JSON shape already defined in `shared/schemas/canonical-doc.schema.json`, plus a redaction pass — matching Phase 1's DoD in `docs/architecture.md`.

**Architecture:** One pydantic model module mirrors the JSON Schema exactly. One loader module per input format, each independently testable against a synthetic golden fixture, all producing the same `CanonicalDoc` shape. A single FastAPI `POST /ingest` endpoint dispatches by file extension. Redaction is a separate, non-mutating pass applied only to a copy sent externally — never to the stored canonical blocks (BASELINE-mode fidelity requirement).

**Tech Stack:** Python 3.11, FastAPI, pydantic v2, `python-docx`, `pypdf`, `pdfplumber`, `pytesseract` + `pdf2image` (OCR), `openpyxl`, `markdown-it-py`, pytest, ruff, mypy.

## Global Constraints

- Ingestion output MUST validate against `elisradevops/req2ado/shared/schemas/canonical-doc.schema.json` — field names, enum values, and nesting must match exactly. Do not modify that schema file.
- Do NOT touch `mcp-ado-server/`, `orchestrator/`, or `frontend/` — Phase 0 packages, complete and out of scope.
- All test fixtures must be synthetic/fabricated content — no real customer or company data (CLAUDE.md data-sensitivity rule). Use placeholder text like "Receiver", "Channel scan", "ACME Corp" style generic content.
- Redaction must never mutate the canonical stored `Block`/`Table`/`Figure` text — it only transforms a copy, and BASELINE mode's fidelity hash is computed over the untouched original.
- Figure/diagram references that aren't inline must render as `[FIGURE: <caption/none>]` placeholders, per architecture.md's "Handle figure placeholders gracefully" requirement.
- Type hints on every function signature; pydantic models, not raw dicts, for all `CanonicalDoc`-shaped data; pytest fixtures (not manual setup) for shared test data; docstrings only where genuinely non-obvious — this repo defaults to no comments otherwise.

---

### Task 1: Python project scaffold + canonical pydantic models

**Files:**
- Create: `ingestion/pyproject.toml`
- Create: `ingestion/app/__init__.py`
- Create: `ingestion/app/canonical/__init__.py`
- Create: `ingestion/app/canonical/model.py`
- Create: `ingestion/app/main.py`
- Create: `ingestion/tests/__init__.py`
- Create: `ingestion/tests/test_health.py`
- Create: `ingestion/pytest.ini`
- Create: `ingestion/ruff.toml`

**Interfaces:**
- Produces: `DocumentFormat`, `BlockKind` (str enums), `SourceRef`, `Document`, `Block`, `Table`, `Figure`, `CanonicalDoc` (pydantic `BaseModel`s) in `ingestion/app/canonical/model.py` — every later task imports these exact names and fields.
- Produces: FastAPI `app` instance in `ingestion/app/main.py` with `GET /health` → `{"ok": true}`.

**Boundary:** This task only builds the foundation (models + health endpoint). No loaders yet.

- [ ] **Step 1: Write pyproject.toml**

```toml
# ingestion/pyproject.toml
[project]
name = "req2ado-ingestion"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
    "fastapi>=0.115.0",
    "uvicorn[standard]>=0.30.0",
    "pydantic>=2.9.0",
    "python-docx>=1.1.2",
    "pypdf>=5.0.0",
    "pdfplumber>=0.11.4",
    "pytesseract>=0.3.13",
    "pdf2image>=1.17.0",
    "openpyxl>=3.1.5",
    "markdown-it-py>=3.0.0",
    "python-multipart>=0.0.12",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.3.0",
    "httpx>=0.27.0",
    "ruff>=0.6.0",
    "mypy>=1.11.0",
    "reportlab>=4.2.0",
]

[build-system]
requires = ["setuptools>=68.0"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
include = ["app*"]
```

- [ ] **Step 2: Write the canonical pydantic models**

```python
# ingestion/app/canonical/model.py
from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field


class DocumentFormat(str, Enum):
    TXT = "txt"
    MD = "md"
    DOCX = "docx"
    PDF = "pdf"
    PDF_SCANNED = "pdf_scanned"
    XLSX = "xlsx"


class BlockKind(str, Enum):
    HEADING = "heading"
    PARAGRAPH = "paragraph"
    LIST_ITEM = "list_item"
    TABLE = "table"
    FIGURE = "figure"
    NOTE = "note"
    OPEN_TBD = "open_tbd"


class SourceRef(BaseModel):
    document_path: str
    start_offset: int = Field(ge=0)
    end_offset: int = Field(ge=0)
    page: int | None = None


class Document(BaseModel):
    path: str
    format: DocumentFormat
    sha256: str


class Block(BaseModel):
    id: str
    kind: BlockKind
    text: str
    heading_level: int | None = Field(default=None, ge=1)
    number_label: str | None = None
    source_ref: SourceRef


class Table(BaseModel):
    id: str
    rows: list[list[str]]
    caption: str | None = None
    source_ref: SourceRef


class Figure(BaseModel):
    id: str
    caption: str | None = None
    source_ref: SourceRef


class CanonicalDoc(BaseModel):
    document: Document
    blocks: list[Block] = Field(default_factory=list)
    tables: list[Table] = Field(default_factory=list)
    figures: list[Figure] = Field(default_factory=list)
```

- [ ] **Step 3: Write the FastAPI app with health endpoint**

```python
# ingestion/app/main.py
from fastapi import FastAPI

app = FastAPI(title="req2ado-ingestion")


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}
```

- [ ] **Step 4: Write empty `__init__.py` files**

```python
# ingestion/app/__init__.py
```

```python
# ingestion/app/canonical/__init__.py
```

```python
# ingestion/tests/__init__.py
```

- [ ] **Step 5: Write the failing health test**

```python
# ingestion/tests/test_health.py
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_returns_ok() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"ok": True}
```

- [ ] **Step 6: Write pytest and ruff config**

```ini
# ingestion/pytest.ini
[pytest]
testpaths = tests
pythonpath = .
```

```toml
# ingestion/ruff.toml
line-length = 100
target-version = "py311"

[lint]
select = ["E", "F", "I", "UP"]
```

- [ ] **Step 7: Create a virtualenv, install, and run the test to verify it passes**

Run:
```bash
cd ingestion
python3.11 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
pytest tests/test_health.py -v
```
Expected: PASS (1 test) — if `python3.11` isn't available, use whatever Python 3.11+ interpreter exists (`python3 --version` to check) and report the actual interpreter used.

- [ ] **Step 8: Verify the pydantic models round-trip against the JSON Schema shape by hand**

Run (from `ingestion/`, venv active):
```bash
python -c "
from app.canonical.model import CanonicalDoc, Document, DocumentFormat, Block, BlockKind, SourceRef
doc = CanonicalDoc(
    document=Document(path='x.txt', format=DocumentFormat.TXT, sha256='abc'),
    blocks=[Block(id='b1', kind=BlockKind.PARAGRAPH, text='hello', source_ref=SourceRef(document_path='x.txt', start_offset=0, end_offset=5))],
)
print(doc.model_dump_json(indent=2))
"
```
Expected: valid JSON printed with keys `document`, `blocks`, `tables: []`, `figures: []` — matching `shared/schemas/canonical-doc.schema.json`'s required top-level keys exactly.

- [ ] **Step 9: Commit**

```bash
git add ingestion/pyproject.toml ingestion/app ingestion/tests ingestion/pytest.ini ingestion/ruff.toml
git commit -m "feat(ingestion): scaffold Python/FastAPI package with canonical pydantic models"
```

---

### Task 2: txt/md loader

**Files:**
- Create: `ingestion/app/loaders/__init__.py`
- Create: `ingestion/app/loaders/text_loader.py`
- Create: `ingestion/tests/fixtures/sample.txt`
- Create: `ingestion/tests/fixtures/sample.md`
- Test: `ingestion/tests/test_text_loader.py`

**Interfaces:**
- Consumes: `CanonicalDoc`, `Document`, `DocumentFormat`, `Block`, `BlockKind`, `SourceRef` from `app.canonical.model` (Task 1).
- Produces: `load_txt(path: str) -> CanonicalDoc` and `load_markdown(path: str) -> CanonicalDoc` in `ingestion/app/loaders/text_loader.py` — Task 8 imports both by these exact names.

**Boundary:** Only touch `ingestion/app/loaders/text_loader.py`, `ingestion/app/loaders/__init__.py`, and this task's own fixtures/test. Do not modify `ingestion/app/canonical/model.py`.

- [ ] **Step 1: Write the fixtures**

```
# ingestion/tests/fixtures/sample.txt
This is a plain requirement statement about the widget subsystem.

It has two paragraphs describing expected behavior.
```

```markdown
# ingestion/tests/fixtures/sample.md
# Receiver

## Broadcast & Inputs

### Channel scan

The receiver shall scan all available channels within 10 seconds of power-on.

- Supports terrestrial broadcast
- Supports cable input
```

- [ ] **Step 2: Write the failing test**

```python
# ingestion/tests/test_text_loader.py
from pathlib import Path

from app.canonical.model import BlockKind
from app.loaders.text_loader import load_markdown, load_txt

FIXTURES = Path(__file__).parent / "fixtures"


def test_load_txt_produces_paragraph_blocks() -> None:
    doc = load_txt(str(FIXTURES / "sample.txt"))
    assert doc.document.format.value == "txt"
    assert len(doc.blocks) == 2
    assert all(b.kind == BlockKind.PARAGRAPH for b in doc.blocks)
    assert "widget subsystem" in doc.blocks[0].text


def test_load_markdown_produces_heading_depth_blocks() -> None:
    doc = load_markdown(str(FIXTURES / "sample.md"))
    headings = [b for b in doc.blocks if b.kind == BlockKind.HEADING]
    assert [h.heading_level for h in headings] == [1, 2, 3]
    assert [h.text for h in headings] == ["Receiver", "Broadcast & Inputs", "Channel scan"]

    paragraphs = [b for b in doc.blocks if b.kind == BlockKind.PARAGRAPH]
    assert any("scan all available channels" in p.text for p in paragraphs)

    list_items = [b for b in doc.blocks if b.kind == BlockKind.LIST_ITEM]
    assert len(list_items) == 2
    assert list_items[0].text == "Supports terrestrial broadcast"


def test_load_txt_sha256_is_populated() -> None:
    doc = load_txt(str(FIXTURES / "sample.txt"))
    assert len(doc.document.sha256) == 64
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd ingestion && pytest tests/test_text_loader.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.loaders'`

- [ ] **Step 4: Implement the loaders**

```python
# ingestion/app/loaders/__init__.py
```

```python
# ingestion/app/loaders/text_loader.py
from __future__ import annotations

import hashlib
from pathlib import Path

from markdown_it import MarkdownIt

from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef


def _sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_txt(path: str) -> CanonicalDoc:
    file_path = Path(path)
    text = file_path.read_text(encoding="utf-8")
    document = Document(path=path, format=DocumentFormat.TXT, sha256=_sha256_of(file_path))

    blocks: list[Block] = []
    offset = 0
    for i, paragraph in enumerate(p for p in text.split("\n\n") if p.strip()):
        start = text.index(paragraph, offset)
        end = start + len(paragraph)
        offset = end
        blocks.append(
            Block(
                id=f"b{i}",
                kind=BlockKind.PARAGRAPH,
                text=paragraph.strip(),
                source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end),
            )
        )
    return CanonicalDoc(document=document, blocks=blocks)


def load_markdown(path: str) -> CanonicalDoc:
    file_path = Path(path)
    text = file_path.read_text(encoding="utf-8")
    document = Document(path=path, format=DocumentFormat.MD, sha256=_sha256_of(file_path))

    md = MarkdownIt()
    tokens = md.parse(text)

    blocks: list[Block] = []
    block_id = 0
    i = 0
    while i < len(tokens):
        token = tokens[i]
        if token.type == "heading_open":
            level = int(token.tag[1])
            inline = tokens[i + 1]
            content = inline.content
            start = text.index(content)
            blocks.append(
                Block(
                    id=f"b{block_id}",
                    kind=BlockKind.HEADING,
                    text=content,
                    heading_level=level,
                    source_ref=SourceRef(
                        document_path=path, start_offset=start, end_offset=start + len(content)
                    ),
                )
            )
            block_id += 1
            i += 3
            continue
        if token.type == "paragraph_open":
            inline = tokens[i + 1]
            content = inline.content
            start = text.index(content)
            blocks.append(
                Block(
                    id=f"b{block_id}",
                    kind=BlockKind.PARAGRAPH,
                    text=content,
                    source_ref=SourceRef(
                        document_path=path, start_offset=start, end_offset=start + len(content)
                    ),
                )
            )
            block_id += 1
            i += 3
            continue
        if token.type == "inline" and token.level > 0 and tokens[i - 1].type == "list_item_open":
            content = token.content
            start = text.index(content)
            blocks.append(
                Block(
                    id=f"b{block_id}",
                    kind=BlockKind.LIST_ITEM,
                    text=content,
                    source_ref=SourceRef(
                        document_path=path, start_offset=start, end_offset=start + len(content)
                    ),
                )
            )
            block_id += 1
        i += 1

    return CanonicalDoc(document=document, blocks=blocks)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ingestion && pytest tests/test_text_loader.py -v`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add ingestion/app/loaders/__init__.py ingestion/app/loaders/text_loader.py ingestion/tests/fixtures/sample.txt ingestion/tests/fixtures/sample.md ingestion/tests/test_text_loader.py
git commit -m "feat(ingestion): add txt/md loader with heading-depth parsing"
```

---

### Task 3: docx loader

**Files:**
- Create: `ingestion/app/loaders/docx_loader.py`
- Create: `ingestion/tests/fixtures/build_docx_fixture.py` (a small script generating the fixture, since docx is a binary format)
- Create: `ingestion/tests/fixtures/sample.docx` (generated by the script above, committed as a binary fixture)
- Test: `ingestion/tests/test_docx_loader.py`

**Interfaces:**
- Consumes: `CanonicalDoc`, `Document`, `DocumentFormat`, `Block`, `BlockKind`, `Table`, `Figure`, `SourceRef` from `app.canonical.model` (Task 1).
- Produces: `load_docx(path: str) -> CanonicalDoc` in `ingestion/app/loaders/docx_loader.py` — Task 8 imports this by exact name.

**Boundary:** Only touch `ingestion/app/loaders/docx_loader.py` and this task's own fixtures/test/generator script. Do not modify `text_loader.py` or `model.py`.

- [ ] **Step 1: Write the fixture generator script**

```python
# ingestion/tests/fixtures/build_docx_fixture.py
"""Run once to (re)generate sample.docx: `python build_docx_fixture.py`."""
from pathlib import Path

from docx import Document as DocxDocument

doc = DocxDocument()
doc.add_heading("Display", level=1)
doc.add_heading("Picture Modes", level=2)
doc.add_paragraph("The display shall support at least three picture presets.")

table = doc.add_table(rows=2, cols=2)
table.cell(0, 0).text = "Mode"
table.cell(0, 1).text = "Description"
table.cell(1, 0).text = "Vivid"
table.cell(1, 1).text = "High saturation preset"

doc.add_paragraph("See the diagram below for panel layout.")

out_path = Path(__file__).parent / "sample.docx"
doc.save(str(out_path))
print(f"wrote {out_path}")
```

- [ ] **Step 2: Generate the fixture**

Run: `cd ingestion && python tests/fixtures/build_docx_fixture.py`
Expected: `wrote .../ingestion/tests/fixtures/sample.docx`

- [ ] **Step 3: Write the failing test**

```python
# ingestion/tests/test_docx_loader.py
from pathlib import Path

from app.canonical.model import BlockKind
from app.loaders.docx_loader import load_docx

FIXTURES = Path(__file__).parent / "fixtures"


def test_load_docx_extracts_heading_levels() -> None:
    doc = load_docx(str(FIXTURES / "sample.docx"))
    headings = [b for b in doc.blocks if b.kind == BlockKind.HEADING]
    assert [(h.text, h.heading_level) for h in headings] == [
        ("Display", 1),
        ("Picture Modes", 2),
    ]


def test_load_docx_extracts_paragraphs() -> None:
    doc = load_docx(str(FIXTURES / "sample.docx"))
    paragraphs = [b for b in doc.blocks if b.kind == BlockKind.PARAGRAPH]
    assert any("three picture presets" in p.text for p in paragraphs)


def test_load_docx_extracts_table_as_cell_grid() -> None:
    doc = load_docx(str(FIXTURES / "sample.docx"))
    assert len(doc.tables) == 1
    assert doc.tables[0].rows == [
        ["Mode", "Description"],
        ["Vivid", "High saturation preset"],
    ]


def test_load_docx_format_is_docx() -> None:
    doc = load_docx(str(FIXTURES / "sample.docx"))
    assert doc.document.format.value == "docx"
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd ingestion && pytest tests/test_docx_loader.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.loaders.docx_loader'`

- [ ] **Step 5: Implement the loader**

```python
# ingestion/app/loaders/docx_loader.py
from __future__ import annotations

import hashlib
from pathlib import Path

from docx import Document as DocxDocument

from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef, Table

_STYLE_HEADING_PREFIX = "Heading "


def load_docx(path: str) -> CanonicalDoc:
    file_path = Path(path)
    sha256 = hashlib.sha256(file_path.read_bytes()).hexdigest()
    document = Document(path=path, format=DocumentFormat.DOCX, sha256=sha256)

    docx_doc = DocxDocument(path)
    blocks: list[Block] = []
    tables: list[Table] = []
    block_id = 0
    offset = 0

    for paragraph in docx_doc.paragraphs:
        content = paragraph.text.strip()
        if not content:
            continue
        start = offset
        end = start + len(content)
        offset = end + 1

        style_name = paragraph.style.name if paragraph.style else ""
        if style_name.startswith(_STYLE_HEADING_PREFIX):
            level = int(style_name.removeprefix(_STYLE_HEADING_PREFIX))
            blocks.append(
                Block(
                    id=f"b{block_id}",
                    kind=BlockKind.HEADING,
                    text=content,
                    heading_level=level,
                    source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end),
                )
            )
        else:
            blocks.append(
                Block(
                    id=f"b{block_id}",
                    kind=BlockKind.PARAGRAPH,
                    text=content,
                    source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end),
                )
            )
        block_id += 1

    for table_index, docx_table in enumerate(docx_doc.tables):
        rows = [[cell.text.strip() for cell in row.cells] for row in docx_table.rows]
        tables.append(
            Table(
                id=f"t{table_index}",
                rows=rows,
                source_ref=SourceRef(document_path=path, start_offset=0, end_offset=0),
            )
        )

    return CanonicalDoc(document=document, blocks=blocks, tables=tables)
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd ingestion && pytest tests/test_docx_loader.py -v`
Expected: PASS (4 tests)

- [ ] **Step 7: Commit**

```bash
git add ingestion/app/loaders/docx_loader.py ingestion/tests/fixtures/build_docx_fixture.py ingestion/tests/fixtures/sample.docx ingestion/tests/test_docx_loader.py
git commit -m "feat(ingestion): add docx loader with heading/table extraction"
```

---

### Task 4: xlsx loader

**Files:**
- Create: `ingestion/app/loaders/xlsx_loader.py`
- Create: `ingestion/tests/fixtures/build_xlsx_fixture.py`
- Create: `ingestion/tests/fixtures/sample.xlsx` (generated, committed as binary fixture)
- Test: `ingestion/tests/test_xlsx_loader.py`

**Interfaces:**
- Consumes: `CanonicalDoc`, `Document`, `DocumentFormat`, `Table`, `SourceRef` from `app.canonical.model` (Task 1).
- Produces: `load_xlsx(path: str) -> CanonicalDoc` in `ingestion/app/loaders/xlsx_loader.py` — Task 8 imports this by exact name.

**Boundary:** Only touch `ingestion/app/loaders/xlsx_loader.py` and this task's own fixtures/test/generator. Do not modify other loaders.

- [ ] **Step 1: Write the fixture generator**

```python
# ingestion/tests/fixtures/build_xlsx_fixture.py
"""Run once to (re)generate sample.xlsx: `python build_xlsx_fixture.py`."""
from pathlib import Path

from openpyxl import Workbook

wb = Workbook()
ws = wb.active
ws.title = "PowerBudget"
ws.append(["Component", "Voltage", "Current (A)"])
ws.append(["FPGA", "3.3V", "2.5"])
ws.append(["CPU", "5V", "4.0"])

ws2 = wb.create_sheet("AddressMap")
ws2.append(["Address", "Register"])
ws2.append(["0x0000", "CTRL"])

out_path = Path(__file__).parent / "sample.xlsx"
wb.save(str(out_path))
print(f"wrote {out_path}")
```

- [ ] **Step 2: Generate the fixture**

Run: `cd ingestion && python tests/fixtures/build_xlsx_fixture.py`
Expected: `wrote .../ingestion/tests/fixtures/sample.xlsx`

- [ ] **Step 3: Write the failing test**

```python
# ingestion/tests/test_xlsx_loader.py
from pathlib import Path

from app.loaders.xlsx_loader import load_xlsx

FIXTURES = Path(__file__).parent / "fixtures"


def test_load_xlsx_produces_one_table_per_sheet() -> None:
    doc = load_xlsx(str(FIXTURES / "sample.xlsx"))
    assert len(doc.tables) == 2


def test_load_xlsx_table_rows_match_sheet_contents() -> None:
    doc = load_xlsx(str(FIXTURES / "sample.xlsx"))
    power_budget = next(t for t in doc.tables if t.caption == "PowerBudget")
    assert power_budget.rows == [
        ["Component", "Voltage", "Current (A)"],
        ["FPGA", "3.3V", "2.5"],
        ["CPU", "5V", "4.0"],
    ]


def test_load_xlsx_second_sheet_present() -> None:
    doc = load_xlsx(str(FIXTURES / "sample.xlsx"))
    address_map = next(t for t in doc.tables if t.caption == "AddressMap")
    assert address_map.rows[0] == ["Address", "Register"]


def test_load_xlsx_format_is_xlsx() -> None:
    doc = load_xlsx(str(FIXTURES / "sample.xlsx"))
    assert doc.document.format.value == "xlsx"
    assert doc.blocks == []
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd ingestion && pytest tests/test_xlsx_loader.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.loaders.xlsx_loader'`

- [ ] **Step 5: Implement the loader**

```python
# ingestion/app/loaders/xlsx_loader.py
from __future__ import annotations

import hashlib
from pathlib import Path

from openpyxl import load_workbook

from app.canonical.model import CanonicalDoc, Document, DocumentFormat, SourceRef, Table


def load_xlsx(path: str) -> CanonicalDoc:
    file_path = Path(path)
    sha256 = hashlib.sha256(file_path.read_bytes()).hexdigest()
    document = Document(path=path, format=DocumentFormat.XLSX, sha256=sha256)

    workbook = load_workbook(filename=path, data_only=True)
    tables: list[Table] = []
    for sheet_index, sheet_name in enumerate(workbook.sheetnames):
        sheet = workbook[sheet_name]
        rows = [
            [str(cell) if cell is not None else "" for cell in row]
            for row in sheet.iter_rows(values_only=True)
        ]
        tables.append(
            Table(
                id=f"t{sheet_index}",
                rows=rows,
                caption=sheet_name,
                source_ref=SourceRef(document_path=path, start_offset=0, end_offset=0),
            )
        )

    return CanonicalDoc(document=document, tables=tables)
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd ingestion && pytest tests/test_xlsx_loader.py -v`
Expected: PASS (4 tests)

- [ ] **Step 7: Commit**

```bash
git add ingestion/app/loaders/xlsx_loader.py ingestion/tests/fixtures/build_xlsx_fixture.py ingestion/tests/fixtures/sample.xlsx ingestion/tests/test_xlsx_loader.py
git commit -m "feat(ingestion): add xlsx loader producing one table per sheet"
```

---

### Task 5: pdf loader (text + tables, no OCR)

**Files:**
- Create: `ingestion/app/loaders/pdf_loader.py`
- Create: `ingestion/tests/fixtures/build_pdf_fixture.py`
- Create: `ingestion/tests/fixtures/sample.pdf` (generated, committed as binary fixture)
- Test: `ingestion/tests/test_pdf_loader.py`

**Interfaces:**
- Consumes: `CanonicalDoc`, `Document`, `DocumentFormat`, `Block`, `BlockKind`, `Table`, `SourceRef` from `app.canonical.model` (Task 1).
- Produces: `load_pdf(path: str) -> CanonicalDoc` in `ingestion/app/loaders/pdf_loader.py` — Task 6 (OCR fallback) and Task 8 both import this by exact name. Also produces `page_has_extractable_text(path: str, page_index: int) -> bool` as a helper Task 6 will reuse.

**Boundary:** Only touch `ingestion/app/loaders/pdf_loader.py` and this task's own fixtures/test/generator. This task does NOT implement OCR — a page with no extractable text should simply produce zero blocks for that page (Task 6 handles the OCR fallback on top of this).

- [ ] **Step 1: Write the fixture generator (uses reportlab, a dev dependency)**

```python
# ingestion/tests/fixtures/build_pdf_fixture.py
"""Run once to (re)generate sample.pdf: `python build_pdf_fixture.py`."""
from pathlib import Path

from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas
from reportlab.platypus import SimpleDocTemplate, Paragraph, Table as RLTable
from reportlab.lib.styles import getSampleStyleSheet

out_path = Path(__file__).parent / "sample.pdf"
styles = getSampleStyleSheet()
doc = SimpleDocTemplate(str(out_path), pagesize=letter)

elements = [
    Paragraph("Backplane Power Budget", styles["Title"]),
    Paragraph("The backplane shall supply a minimum of 150W total.", styles["BodyText"]),
    RLTable([["Rail", "Voltage", "Max Current"], ["3.3V", "3.3", "10A"], ["12V", "12", "5A"]]),
]
doc.build(elements)
print(f"wrote {out_path}")
```

- [ ] **Step 2: Generate the fixture**

Run: `cd ingestion && python tests/fixtures/build_pdf_fixture.py`
Expected: `wrote .../ingestion/tests/fixtures/sample.pdf`

- [ ] **Step 3: Write the failing test**

```python
# ingestion/tests/test_pdf_loader.py
from pathlib import Path

from app.canonical.model import BlockKind
from app.loaders.pdf_loader import load_pdf, page_has_extractable_text

FIXTURES = Path(__file__).parent / "fixtures"


def test_load_pdf_extracts_text_blocks_with_page_number() -> None:
    doc = load_pdf(str(FIXTURES / "sample.pdf"))
    assert len(doc.blocks) >= 1
    assert all(b.source_ref.page == 1 for b in doc.blocks)
    assert any("Backplane Power Budget" in b.text for b in doc.blocks)
    assert any(b.kind == BlockKind.PARAGRAPH for b in doc.blocks)


def test_load_pdf_extracts_at_least_one_table() -> None:
    doc = load_pdf(str(FIXTURES / "sample.pdf"))
    assert len(doc.tables) >= 1
    flat = [cell for row in doc.tables[0].rows for cell in row]
    assert "3.3V" in flat


def test_load_pdf_format_is_pdf() -> None:
    doc = load_pdf(str(FIXTURES / "sample.pdf"))
    assert doc.document.format.value == "pdf"


def test_page_has_extractable_text_true_for_text_page() -> None:
    assert page_has_extractable_text(str(FIXTURES / "sample.pdf"), 0) is True
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd ingestion && pytest tests/test_pdf_loader.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.loaders.pdf_loader'`

- [ ] **Step 5: Implement the loader**

```python
# ingestion/app/loaders/pdf_loader.py
from __future__ import annotations

import hashlib
from pathlib import Path

import pdfplumber
from pypdf import PdfReader

from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef, Table


def page_has_extractable_text(path: str, page_index: int) -> bool:
    reader = PdfReader(path)
    page = reader.pages[page_index]
    text = page.extract_text() or ""
    return len(text.strip()) > 0


def load_pdf(path: str) -> CanonicalDoc:
    file_path = Path(path)
    sha256 = hashlib.sha256(file_path.read_bytes()).hexdigest()
    document = Document(path=path, format=DocumentFormat.PDF, sha256=sha256)

    blocks: list[Block] = []
    tables: list[Table] = []
    block_id = 0
    table_id = 0

    with pdfplumber.open(path) as pdf:
        for page_number, page in enumerate(pdf.pages, start=1):
            text = page.extract_text() or ""
            offset = 0
            for paragraph in (p for p in text.split("\n\n") if p.strip()):
                start = text.index(paragraph, offset)
                end = start + len(paragraph)
                offset = end
                blocks.append(
                    Block(
                        id=f"b{block_id}",
                        kind=BlockKind.PARAGRAPH,
                        text=paragraph.strip(),
                        source_ref=SourceRef(
                            document_path=path, start_offset=start, end_offset=end, page=page_number
                        ),
                    )
                )
                block_id += 1

            for extracted_table in page.extract_tables():
                rows = [[cell or "" for cell in row] for row in extracted_table]
                tables.append(
                    Table(
                        id=f"t{table_id}",
                        rows=rows,
                        source_ref=SourceRef(
                            document_path=path, start_offset=0, end_offset=0, page=page_number
                        ),
                    )
                )
                table_id += 1

    return CanonicalDoc(document=document, blocks=blocks, tables=tables)
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd ingestion && pytest tests/test_pdf_loader.py -v`
Expected: PASS (4 tests)

- [ ] **Step 7: Commit**

```bash
git add ingestion/app/loaders/pdf_loader.py ingestion/tests/fixtures/build_pdf_fixture.py ingestion/tests/fixtures/sample.pdf ingestion/tests/test_pdf_loader.py
git commit -m "feat(ingestion): add pdf loader with text/table extraction"
```

---

### Task 6: OCR fallback for scanned PDF pages

**Files:**
- Create: `ingestion/app/loaders/ocr.py`
- Create: `ingestion/tests/fixtures/build_scanned_pdf_fixture.py`
- Create: `ingestion/tests/fixtures/scanned_sample.pdf` (generated: an image-only PDF page, committed as binary fixture)
- Test: `ingestion/tests/test_ocr.py`

**Interfaces:**
- Consumes: `page_has_extractable_text` from `app.loaders.pdf_loader` (Task 5); `CanonicalDoc`, `Document`, `DocumentFormat`, `Block`, `BlockKind`, `Figure`, `SourceRef` from `app.canonical.model` (Task 1).
- Produces: `load_pdf_with_ocr_fallback(path: str) -> CanonicalDoc` in `ingestion/app/loaders/ocr.py` — Task 8 imports this by exact name as the entry point for any `.pdf` upload (it internally delegates to `load_pdf` for text pages and OCRs image-only pages).
- Produces: `ocr_page_to_text(path: str, page_index: int) -> str` — a focused helper wrapping `pytesseract` + `pdf2image`, used internally and independently testable.

**Boundary:** Only touch `ingestion/app/loaders/ocr.py` and this task's own fixtures/test/generator. Do not modify `pdf_loader.py` — import from it instead.

- [ ] **Step 1: Write the fixture generator (renders a PDF page as a rasterized image, then re-embeds it with no text layer)**

```python
# ingestion/tests/fixtures/build_scanned_pdf_fixture.py
"""Run once to (re)generate scanned_sample.pdf: `python build_scanned_pdf_fixture.py`.

Produces a PDF whose single page has NO extractable text layer (an image-only
page), simulating a scanned/photographed document, so the OCR fallback path
can be exercised without needing a real scanner.
"""
from pathlib import Path

from PIL import Image, ImageDraw
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

fixtures_dir = Path(__file__).parent
image_path = fixtures_dir / "_scanned_page.png"
out_path = fixtures_dir / "scanned_sample.pdf"

img = Image.new("RGB", (1200, 400), color="white")
draw = ImageDraw.Draw(img)
draw.text((40, 40), "OPEN: confirm connector part number before release", fill="black")
img.save(image_path)

c = canvas.Canvas(str(out_path), pagesize=letter)
c.drawImage(str(image_path), 50, 500, width=500, height=167)
c.showPage()
c.save()

image_path.unlink()
print(f"wrote {out_path}")
```

- [ ] **Step 2: Generate the fixture**

Run: `cd ingestion && python tests/fixtures/build_scanned_pdf_fixture.py`
Expected: `wrote .../ingestion/tests/fixtures/scanned_sample.pdf`

You will also need Tesseract and Poppler installed on the system (not pip packages) for `pytesseract`/`pdf2image` to work: `brew install tesseract poppler` on macOS, or `apt-get install tesseract-ocr poppler-utils` on Debian/Ubuntu. If these system binaries are unavailable in your environment, report BLOCKED with the exact error rather than skipping the test.

- [ ] **Step 3: Write the failing test**

```python
# ingestion/tests/test_ocr.py
from pathlib import Path

from app.canonical.model import BlockKind
from app.loaders.ocr import load_pdf_with_ocr_fallback, ocr_page_to_text
from app.loaders.pdf_loader import page_has_extractable_text

FIXTURES = Path(__file__).parent / "fixtures"


def test_scanned_page_has_no_extractable_text() -> None:
    assert page_has_extractable_text(str(FIXTURES / "scanned_sample.pdf"), 0) is False


def test_ocr_page_to_text_extracts_the_rendered_words() -> None:
    text = ocr_page_to_text(str(FIXTURES / "scanned_sample.pdf"), 0)
    assert "OPEN" in text
    assert "connector" in text.lower() or "part number" in text.lower()


def test_load_pdf_with_ocr_fallback_produces_open_tbd_block() -> None:
    doc = load_pdf_with_ocr_fallback(str(FIXTURES / "scanned_sample.pdf"))
    assert len(doc.blocks) >= 1
    assert any(b.kind == BlockKind.OPEN_TBD for b in doc.blocks)
    assert any("OPEN" in b.text for b in doc.blocks)


def test_load_pdf_with_ocr_fallback_uses_text_path_when_available() -> None:
    doc = load_pdf_with_ocr_fallback(str(FIXTURES / "sample.pdf"))
    assert any("Backplane Power Budget" in b.text for b in doc.blocks)
    assert doc.document.format.value == "pdf_scanned" or doc.document.format.value == "pdf"
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd ingestion && pytest tests/test_ocr.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.loaders.ocr'`

- [ ] **Step 5: Implement the OCR fallback**

```python
# ingestion/app/loaders/ocr.py
from __future__ import annotations

import hashlib
import re
from pathlib import Path

import pytesseract
from pdf2image import convert_from_path
from pypdf import PdfReader

from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef
from app.loaders.pdf_loader import load_pdf, page_has_extractable_text

_OPEN_TBD_PATTERN = re.compile(r"\b(OPEN|TBD)\b[:\s]", re.IGNORECASE)


def ocr_page_to_text(path: str, page_index: int) -> str:
    images = convert_from_path(path, first_page=page_index + 1, last_page=page_index + 1)
    return pytesseract.image_to_string(images[0])


def load_pdf_with_ocr_fallback(path: str) -> CanonicalDoc:
    reader = PdfReader(path)
    num_pages = len(reader.pages)

    any_scanned = any(not page_has_extractable_text(path, i) for i in range(num_pages))
    if not any_scanned:
        return load_pdf(path)

    file_path = Path(path)
    sha256 = hashlib.sha256(file_path.read_bytes()).hexdigest()
    document = Document(path=path, format=DocumentFormat.PDF_SCANNED, sha256=sha256)

    text_doc = load_pdf(path)
    blocks: list[Block] = list(text_doc.blocks)
    block_id = len(blocks)

    for page_index in range(num_pages):
        if page_has_extractable_text(path, page_index):
            continue
        ocr_text = ocr_page_to_text(path, page_index).strip()
        if not ocr_text:
            continue
        kind = BlockKind.OPEN_TBD if _OPEN_TBD_PATTERN.search(ocr_text) else BlockKind.PARAGRAPH
        blocks.append(
            Block(
                id=f"b{block_id}",
                kind=kind,
                text=ocr_text,
                source_ref=SourceRef(
                    document_path=path, start_offset=0, end_offset=len(ocr_text), page=page_index + 1
                ),
            )
        )
        block_id += 1

    return CanonicalDoc(document=document, blocks=blocks, tables=text_doc.tables)
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd ingestion && pytest tests/test_ocr.py -v`
Expected: PASS (4 tests) — if Tesseract/Poppler binaries are missing, this is the expected failure point; escalate rather than working around it.

- [ ] **Step 7: Commit**

```bash
git add ingestion/app/loaders/ocr.py ingestion/tests/fixtures/build_scanned_pdf_fixture.py ingestion/tests/fixtures/scanned_sample.pdf ingestion/tests/test_ocr.py
git commit -m "feat(ingestion): add OCR fallback for scanned PDF pages"
```

---

### Task 7: Redaction pass

**Files:**
- Create: `ingestion/app/redaction/__init__.py`
- Create: `ingestion/app/redaction/redactor.py`
- Test: `ingestion/tests/test_redaction.py`

**Interfaces:**
- Consumes: `CanonicalDoc`, `Block` from `app.canonical.model` (Task 1).
- Produces: `redact_canonical_doc(doc: CanonicalDoc, *, trusted_local: bool = False) -> CanonicalDoc` in `ingestion/app/redaction/redactor.py` — Task 8 imports this by exact name. Returns a NEW `CanonicalDoc` (deep copy with redacted text); never mutates the input.

**Boundary:** Only touch `ingestion/app/redaction/`. Do not modify any loader — loaders must keep producing verbatim, unredacted text; redaction is a separate pass applied downstream, never inside a loader.

- [ ] **Step 1: Write the failing test**

```python
# ingestion/tests/test_redaction.py
from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef
from app.redaction.redactor import redact_canonical_doc


def _doc_with_text(text: str) -> CanonicalDoc:
    return CanonicalDoc(
        document=Document(path="x.txt", format=DocumentFormat.TXT, sha256="abc"),
        blocks=[
            Block(
                id="b0",
                kind=BlockKind.PARAGRAPH,
                text=text,
                source_ref=SourceRef(document_path="x.txt", start_offset=0, end_offset=len(text)),
            )
        ],
    )


def test_redacts_email_addresses() -> None:
    doc = _doc_with_text("Contact jane.doe@example.com for details.")
    redacted = redact_canonical_doc(doc)
    assert "jane.doe@example.com" not in redacted.blocks[0].text
    assert "<redacted>" in redacted.blocks[0].text


def test_redacts_urls() -> None:
    doc = _doc_with_text("See https://internal.example.com/spec for the full spec.")
    redacted = redact_canonical_doc(doc)
    assert "https://internal.example.com/spec" not in redacted.blocks[0].text


def test_redacts_guids() -> None:
    doc = _doc_with_text("Ticket ID: 550e8400-e29b-41d4-a716-446655440000 was closed.")
    redacted = redact_canonical_doc(doc)
    assert "550e8400-e29b-41d4-a716-446655440000" not in redacted.blocks[0].text


def test_redacts_hostnames() -> None:
    doc = _doc_with_text("Deployed to build-server-42.internal.corp for testing.")
    redacted = redact_canonical_doc(doc)
    assert "build-server-42.internal.corp" not in redacted.blocks[0].text


def test_redacts_part_numbers() -> None:
    doc = _doc_with_text("Use connector PN-4471-A2 for this interface.")
    redacted = redact_canonical_doc(doc)
    assert "PN-4471-A2" not in redacted.blocks[0].text


def test_trusted_local_bypasses_redaction() -> None:
    doc = _doc_with_text("Contact jane.doe@example.com for details.")
    redacted = redact_canonical_doc(doc, trusted_local=True)
    assert redacted.blocks[0].text == doc.blocks[0].text


def test_redaction_never_mutates_the_original_doc() -> None:
    doc = _doc_with_text("Contact jane.doe@example.com for details.")
    original_text = doc.blocks[0].text
    redact_canonical_doc(doc)
    assert doc.blocks[0].text == original_text
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ingestion && pytest tests/test_redaction.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.redaction'`

- [ ] **Step 3: Implement the redactor**

```python
# ingestion/app/redaction/__init__.py
```

```python
# ingestion/app/redaction/redactor.py
from __future__ import annotations

import re

from app.canonical.model import CanonicalDoc

_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}"),  # email
    re.compile(r"https?://[^\s]+"),  # url
    re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"),  # guid
    re.compile(r"\b[a-zA-Z0-9-]+\.(?:internal|corp|local)\.[a-zA-Z]{2,}\b"),  # hostname
    re.compile(r"\b(?:PN|P/N)-[A-Za-z0-9-]+\b"),  # part number
]


def _redact_text(text: str) -> str:
    redacted = text
    for pattern in _PATTERNS:
        redacted = pattern.sub("<redacted>", redacted)
    return redacted


def redact_canonical_doc(doc: CanonicalDoc, *, trusted_local: bool = False) -> CanonicalDoc:
    if trusted_local:
        return doc.model_copy(deep=True)

    redacted = doc.model_copy(deep=True)
    for block in redacted.blocks:
        block.text = _redact_text(block.text)
    for table in redacted.tables:
        table.rows = [[_redact_text(cell) for cell in row] for row in table.rows]
    for figure in redacted.figures:
        if figure.caption:
            figure.caption = _redact_text(figure.caption)
    return redacted
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ingestion && pytest tests/test_redaction.py -v`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add ingestion/app/redaction/__init__.py ingestion/app/redaction/redactor.py ingestion/tests/test_redaction.py
git commit -m "feat(ingestion): add non-mutating redaction pass for email/url/guid/hostname/part-number"
```

---

### Task 8: FastAPI `/ingest` wiring

**Files:**
- Modify: `ingestion/app/main.py`
- Create: `ingestion/app/dispatch.py`
- Test: `ingestion/tests/test_ingest_endpoint.py`

**Interfaces:**
- Consumes: `load_txt`, `load_markdown` (Task 2), `load_docx` (Task 3), `load_xlsx` (Task 4), `load_pdf_with_ocr_fallback` (Task 6), `redact_canonical_doc` (Task 7), `CanonicalDoc` (Task 1).
- Produces: `dispatch_by_extension(filename: str, tmp_path: str) -> CanonicalDoc` in `ingestion/app/dispatch.py`; `POST /ingest` route added to the `app` in `ingestion/app/main.py` accepting a multipart file upload plus an optional `redact: bool = False` query param, returning the `CanonicalDoc` as JSON (via FastAPI's automatic pydantic serialization).

**Boundary:** Only touch `ingestion/app/main.py` (adding the route) and create `ingestion/app/dispatch.py`. Do not modify any loader or the redactor's logic — only import and call them.

- [ ] **Step 1: Write the failing test**

```python
# ingestion/tests/test_ingest_endpoint.py
from pathlib import Path

from fastapi.testclient import TestClient

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ingestion && pytest tests/test_ingest_endpoint.py -v`
Expected: FAIL — `404` on `/ingest` (route doesn't exist yet) or `ModuleNotFoundError` for `app.dispatch`

- [ ] **Step 3: Implement the dispatcher**

```python
# ingestion/app/dispatch.py
from __future__ import annotations

from pathlib import Path

from fastapi import HTTPException

from app.canonical.model import CanonicalDoc
from app.loaders.docx_loader import load_docx
from app.loaders.ocr import load_pdf_with_ocr_fallback
from app.loaders.text_loader import load_markdown, load_txt
from app.loaders.xlsx_loader import load_xlsx

_SUPPORTED_EXTENSIONS = {".txt", ".md", ".docx", ".xlsx", ".pdf"}


def dispatch_by_extension(filename: str, tmp_path: str) -> CanonicalDoc:
    extension = Path(filename).suffix.lower()
    if extension not in _SUPPORTED_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported file extension: {extension}")

    if extension == ".txt":
        return load_txt(tmp_path)
    if extension == ".md":
        return load_markdown(tmp_path)
    if extension == ".docx":
        return load_docx(tmp_path)
    if extension == ".xlsx":
        return load_xlsx(tmp_path)
    return load_pdf_with_ocr_fallback(tmp_path)
```

- [ ] **Step 4: Add the `/ingest` route**

```python
# ingestion/app/main.py  (replace existing content)
import tempfile
from pathlib import Path

from fastapi import FastAPI, UploadFile

from app.canonical.model import CanonicalDoc
from app.dispatch import dispatch_by_extension
from app.redaction.redactor import redact_canonical_doc

app = FastAPI(title="req2ado-ingestion")


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


@app.post("/ingest", response_model=CanonicalDoc)
async def ingest(file: UploadFile, redact: bool = False) -> CanonicalDoc:
    suffix = Path(file.filename or "").suffix
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name

    try:
        doc = dispatch_by_extension(file.filename or "", tmp_path)
    finally:
        Path(tmp_path).unlink(missing_ok=True)

    if redact:
        doc = redact_canonical_doc(doc)
    return doc
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ingestion && pytest tests/test_ingest_endpoint.py -v`
Expected: PASS (8 tests)

- [ ] **Step 6: Run the full suite**

Run: `cd ingestion && pytest -v`
Expected: PASS — all tests across all 8 tasks green (health + text + docx + xlsx + pdf + ocr + redaction + ingest endpoint).

- [ ] **Step 7: Commit**

```bash
git add ingestion/app/main.py ingestion/app/dispatch.py ingestion/tests/test_ingest_endpoint.py
git commit -m "feat(ingestion): wire POST /ingest endpoint dispatching by file extension"
```

---

## Self-Review Notes

- **Spec coverage:** all Phase 1 DoD items covered — txt/md (Task 2), docx (Task 3), xlsx (Task 4), pdf (Task 5), scanned-pdf/OCR (Task 6), tables (Tasks 3-5, xlsx), figures (docx loader does not yet emit `Figure` placeholders for embedded images — see gap below), redaction (Task 7), single ingestion entrypoint (Task 8).
- **Gap found during self-review:** the docx loader (Task 3) fixture and tests do not exercise embedded-image → `Figure` placeholder extraction, even though `python-docx` can enumerate inline shapes/images. Given Phase 1's DoD says "figures→placeholders" is in scope, Task 3's implementer should treat this as a known gap: if time allows, extend `load_docx` to detect inline images via `paragraph._p.xpath('.//pic:pic')` (or simpler: scan `document.part.rels` for image relationships) and emit a `Figure(caption=None, ...)` per image found. This is called out explicitly here rather than silently skipped — if the implementer finds it non-trivial with the available library version, report DONE_WITH_CONCERNS rather than skipping silently.
- **Type consistency:** `load_txt`, `load_markdown`, `load_docx`, `load_xlsx`, `load_pdf`, `load_pdf_with_ocr_fallback` all share the signature `(path: str) -> CanonicalDoc` — consistent across all tasks. `dispatch_by_extension(filename: str, tmp_path: str) -> CanonicalDoc` in Task 8 correctly calls each by this shared shape.
- **No placeholders:** all task steps contain complete, runnable code — no TBD/TODO left in implementation steps (the one inline `# TODO` note in Task 3's self-review is a flagged known gap for the plan itself, not a placeholder inside implementation code).
