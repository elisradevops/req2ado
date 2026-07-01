# OCR Language Support (Hebrew/RTL) + Watermark Mitigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close two gaps found in the Phase 1 OCR loader (`ingestion/app/loaders/ocr.py`) after merge: (1) OCR is hardcoded to English, so Hebrew/RTL-script scanned pages OCR as garbage; (2) no watermark mitigation exists, so watermark text mixes indistinguishably into real content.

**Architecture:** Task A makes the OCR language configurable end-to-end (loader → dispatcher → API) and proves Hebrew OCR works via a synthetic Hebrew fixture verified in Docker. Task B adds a confidence-based word filter as a best-effort watermark mitigation (not detection/removal), wired into the default OCR path. Both tasks touch only `ocr.py` plus its two callers (`dispatch.py`, `main.py`) — no other loader is touched.

**Tech Stack:** Same as Phase 1 — Python 3.11+/pytesseract/pdf2image, verified via ephemeral `python:3.11-slim` Docker containers (this dev machine's Homebrew is x86_64-only and cannot run Tesseract natively; production target is Linux/K8s where apt-get installs work cleanly).

## Global Constraints

- Do NOT touch `text_loader.py`, `docx_loader.py`, `xlsx_loader.py`, `pdf_loader.py`, or `redaction/redactor.py` — this addendum only modifies `ocr.py`, `dispatch.py`, `main.py`, plus their tests.
- Full watermark *detection/removal* (image-processing-based, e.g. diagonal-overlay cropping) is explicitly OUT OF SCOPE. This addendum only adds confidence-based word filtering as a documented, best-effort heuristic — the plan and code must say so honestly, not oversell it as solved.
- All OCR-dependent tests MUST be verified inside a `python:3.11-slim` Docker container with `apt-get install tesseract-ocr poppler-utils` (+ Hebrew language pack + a Hebrew-capable font for Task A) — this Mac (arm64, broken x86_64-only Homebrew) cannot run Tesseract natively. This mirrors the real K8s/Linux deployment target.
- Type hints on every function signature; docstrings only where genuinely non-obvious (this repo's default is no comments).
- Existing default behavior (English OCR, no filtering change visible to Task 6/8's existing tests) must remain backward compatible — existing tests in `tests/test_ocr.py` and `tests/test_ingest_endpoint.py::test_ingest_scanned_pdf_via_ocr` must still pass unmodified.

---

### Task A: Configurable OCR language (Hebrew/RTL support)

**Files:**
- Modify: `ingestion/app/loaders/ocr.py` (both functions)
- Modify: `ingestion/app/dispatch.py:17,30` (thread `languages` param through)
- Modify: `ingestion/app/main.py:19-20` (add `languages` query param)
- Create: `ingestion/tests/fixtures/build_hebrew_scanned_pdf_fixture.py`
- Create: `ingestion/tests/fixtures/hebrew_scanned_sample.pdf` (generated, committed as binary fixture)
- Test: `ingestion/tests/test_ocr.py` (add new test cases to the existing file)

**Interfaces:**
- Modifies: `ocr_page_to_text(path: str, page_index: int, languages: str = "eng") -> str` — adds one parameter with a default, so all existing callers keep working unchanged.
- Modifies: `load_pdf_with_ocr_fallback(path: str, languages: str = "eng") -> CanonicalDoc` — same default-preserving pattern; Task B's function signature (below) must match this same parameter name and default.
- Modifies: `dispatch_by_extension(filename: str, tmp_path: str, languages: str = "eng") -> CanonicalDoc` — only the `.pdf` branch actually uses it; other branches ignore it.
- Modifies: `POST /ingest` — adds `languages: str = "eng"` as a FastAPI query parameter, passed through to `dispatch_by_extension`.

**Boundary:** Only touch `ocr.py`, `dispatch.py`, `main.py`, and this task's own fixture/test additions. Do not modify `pdf_loader.py`, `text_loader.py`, `docx_loader.py`, `xlsx_loader.py`, or `redactor.py`. Do not remove or change any existing test in `test_ocr.py` — only add new ones.

- [ ] **Step 1: Write the Hebrew fixture generator**

```python
# ingestion/tests/fixtures/build_hebrew_scanned_pdf_fixture.py
"""Run once to (re)generate hebrew_scanned_sample.pdf: `python build_hebrew_scanned_pdf_fixture.py`.

Renders Hebrew text via PIL into an image-only PDF page (no text layer),
simulating a scanned Hebrew document. Requires a Hebrew-capable TrueType
font to be available on the system running this script — on Debian/Ubuntu,
`apt-get install fonts-noto-core` provides `NotoSansHebrew` or similar; on
macOS, a system font like "Arial Unicode" or "Arial Hebrew" may work. This
script tries a list of common font paths and picks the first one that
exists; if none are found, it raises with a clear error rather than
silently rendering tofu boxes (empty glyph placeholders).
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

_CANDIDATE_FONT_PATHS = [
    "/usr/share/fonts/truetype/noto/NotoSansHebrew-Regular.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansHebrew-Regular.otf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",  # fallback; may not have full Hebrew coverage
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",  # macOS fallback for local dev
]

fixtures_dir = Path(__file__).parent
image_path = fixtures_dir / "_hebrew_scanned_page.png"
out_path = fixtures_dir / "hebrew_scanned_sample.pdf"

font_path = next((p for p in _CANDIDATE_FONT_PATHS if Path(p).exists()), None)
if font_path is None:
    raise RuntimeError(
        "No Hebrew-capable font found among candidates: "
        f"{_CANDIDATE_FONT_PATHS}. Install a Hebrew font package "
        "(e.g. `apt-get install fonts-noto-core` on Debian/Ubuntu) before running this script."
    )

font = ImageFont.truetype(font_path, size=48)
hebrew_text = "בדיקת מערכת קליטה"  # "receiver system test" — arbitrary synthetic content, not real customer data

img = Image.new("RGB", (1200, 300), color="white")
draw = ImageDraw.Draw(img)
draw.text((40, 100), hebrew_text, fill="black", font=font)
img.save(image_path)

c = canvas.Canvas(str(out_path), pagesize=letter)
c.drawImage(str(image_path), 50, 500, width=500, height=125)
c.showPage()
c.save()

image_path.unlink()
print(f"wrote {out_path} using font {font_path}")
```

- [ ] **Step 2: Generate the fixture INSIDE Docker (this Mac has no Hebrew font readily available and no working Tesseract to cross-check against anyway)**

Run:
```bash
cd /Users/EdenZviSchwartz/Repos/Projects/.claude/worktrees/req2ado-ocr-i18n/elisradevops/req2ado/ingestion
docker run --rm -v "$(pwd)/..:/req2ado" -w /req2ado/ingestion python:3.11-slim bash -c "
  apt-get update -qq &&
  apt-get install -y -qq tesseract-ocr tesseract-ocr-heb poppler-utils gcc fonts-noto-core > /dev/null 2>&1 &&
  pip install -q -e '.[dev]' &&
  python tests/fixtures/build_hebrew_scanned_pdf_fixture.py
"
```
Expected: `wrote .../hebrew_scanned_sample.pdf using font /usr/share/fonts/.../NotoSansHebrew-Regular.ttf` (or similar path under `fonts-noto-core`'s install location — the exact path may vary; if the script's candidate list doesn't match what `fonts-noto-core` actually installs on this image, inspect `fc-list :lang=he` inside the container to find the real path and update `_CANDIDATE_FONT_PATHS` accordingly before proceeding).

If `fonts-noto-core` doesn't actually provide Hebrew coverage on this Debian slim image, try `fonts-noto` (larger package) instead, and update the Docker command and this step's expected output accordingly — verify empirically, don't guess.

- [ ] **Step 3: Write the failing tests**

```python
# Add to ingestion/tests/test_ocr.py (append to the existing file)

def test_ocr_page_to_text_extracts_hebrew_with_heb_language() -> None:
    text = ocr_page_to_text(str(FIXTURES / "hebrew_scanned_sample.pdf"), 0, languages="heb")
    assert len(text.strip()) > 0
    # Hebrew Unicode block is U+0590-U+05FF; assert at least one character falls in it,
    # rather than asserting an exact string match (Tesseract's accuracy on synthetic
    # rendered fixtures varies — structural presence is a more reliable assertion here).
    assert any("֐" <= ch <= "׿" for ch in text)


def test_ocr_default_language_still_english() -> None:
    # Regression guard: confirm the DEFAULT (no languages arg) behavior is unchanged
    # from before this task — existing English fixture still OCRs correctly.
    text = ocr_page_to_text(str(FIXTURES / "scanned_sample.pdf"), 0)
    assert "OPEN" in text
```

- [ ] **Step 4: Run tests to verify they fail (the Hebrew one for missing `languages` param, or wrong extraction; the English one should already pass since it's a regression check)**

Run (inside Docker, same container pattern as Step 2, replacing the last line with `pytest tests/test_ocr.py -v`):
```bash
docker run --rm -v "$(pwd)/..:/req2ado" -w /req2ado/ingestion python:3.11-slim bash -c "
  apt-get update -qq &&
  apt-get install -y -qq tesseract-ocr tesseract-ocr-heb poppler-utils gcc fonts-noto-core > /dev/null 2>&1 &&
  pip install -q -e '.[dev]' &&
  pytest tests/test_ocr.py -v
"
```
Expected: `test_ocr_page_to_text_extracts_hebrew_with_heb_language` FAILS with `TypeError: ocr_page_to_text() got an unexpected keyword argument 'languages'` (function doesn't accept the param yet). `test_ocr_default_language_still_english` should PASS already (no code change needed for it — it's a pre-existing behavior check).

- [ ] **Step 5: Implement the language parameter**

```python
# ingestion/app/loaders/ocr.py (full file, modified)
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


def ocr_page_to_text(path: str, page_index: int, languages: str = "eng") -> str:
    """`languages` is passed directly to Tesseract's `lang` parameter; join
    multiple language codes with '+' for mixed-script documents, e.g.
    'heb+eng' for Hebrew narrative with embedded English part numbers.
    Requires the corresponding Tesseract language pack to be installed
    (e.g. `tesseract-ocr-heb` on Debian/Ubuntu for 'heb')."""
    images = convert_from_path(path, first_page=page_index + 1, last_page=page_index + 1)
    return pytesseract.image_to_string(images[0], lang=languages)


def load_pdf_with_ocr_fallback(path: str, languages: str = "eng") -> CanonicalDoc:
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
        ocr_text = ocr_page_to_text(path, page_index, languages=languages).strip()
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

- [ ] **Step 6: Thread the parameter through the dispatcher**

```python
# ingestion/app/dispatch.py (full file, modified)
from __future__ import annotations

from pathlib import Path

from fastapi import HTTPException

from app.canonical.model import CanonicalDoc
from app.loaders.docx_loader import load_docx
from app.loaders.ocr import load_pdf_with_ocr_fallback
from app.loaders.text_loader import load_markdown, load_txt
from app.loaders.xlsx_loader import load_xlsx

_SUPPORTED_EXTENSIONS = {".txt", ".md", ".docx", ".xlsx", ".pdf"}


def dispatch_by_extension(filename: str, tmp_path: str, languages: str = "eng") -> CanonicalDoc:
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
    return load_pdf_with_ocr_fallback(tmp_path, languages=languages)
```

- [ ] **Step 7: Add the query param to the API endpoint**

```python
# ingestion/app/main.py (full file, modified)
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
```

- [ ] **Step 8: Run the full suite inside Docker to verify GREEN and no regressions**

Run:
```bash
docker run --rm -v "$(pwd)/..:/req2ado" -w /req2ado/ingestion python:3.11-slim bash -c "
  apt-get update -qq &&
  apt-get install -y -qq tesseract-ocr tesseract-ocr-heb poppler-utils gcc fonts-noto-core > /dev/null 2>&1 &&
  pip install -q -e '.[dev]' &&
  pytest -v
"
```
Expected: all tests pass, including the 2 new ones from Step 3, and all pre-existing tests (should be 42 total: the 40 from Phase 1 + 2 new here).

- [ ] **Step 9: Commit**

```bash
git add ingestion/app/loaders/ocr.py ingestion/app/dispatch.py ingestion/app/main.py ingestion/tests/test_ocr.py ingestion/tests/fixtures/build_hebrew_scanned_pdf_fixture.py ingestion/tests/fixtures/hebrew_scanned_sample.pdf
git commit -m "feat(ingestion): add configurable OCR language support incl. Hebrew"
```

---

### Task B: Basic watermark mitigation via OCR confidence filtering

**Files:**
- Modify: `ingestion/app/loaders/ocr.py` (add new function, wire into `load_pdf_with_ocr_fallback`)
- Create: `ingestion/tests/fixtures/build_watermarked_pdf_fixture.py`
- Create: `ingestion/tests/fixtures/watermarked_sample.pdf` (generated, committed as binary fixture)
- Test: `ingestion/tests/test_ocr.py` (add new test cases)

**Interfaces:**
- Consumes: nothing new from Task A besides the `languages` parameter already added.
- Produces: `ocr_page_to_text_filtered(path: str, page_index: int, languages: str = "eng", confidence_threshold: int = 30) -> str` — used internally by `load_pdf_with_ocr_fallback`, but also independently testable/importable.
- Modifies: `load_pdf_with_ocr_fallback` to call `ocr_page_to_text_filtered` instead of `ocr_page_to_text` as its OCR step (watermark mitigation becomes the default, not opt-in).

**Boundary:** Only touch `ocr.py` and this task's own fixture/test additions. Do NOT attempt real watermark detection (image analysis, diagonal-text detection, transparency estimation) — this is confidence-based word filtering only, an explicitly best-effort heuristic. Do not touch the redaction pass (`redactor.py`) — that's a separate concern (PII/secret stripping, not watermark noise).

**IMPORTANT — this task is exploratory.** Tesseract's OCR confidence on synthetic light-gray rendered text is empirically variable and may not reliably separate from solid black text the way a real semi-transparent watermark would. Verify actual behavior in Step 2 below BEFORE writing the final test assertions in Step 3 — if the confidence gap isn't reliable, write a test that asserts what IS true (real text present in filtered output) rather than a strict "watermark text absent" claim, and note the limitation honestly in the function's docstring per Step 4's code.

- [ ] **Step 1: Write the watermark fixture generator**

```python
# ingestion/tests/fixtures/build_watermarked_pdf_fixture.py
"""Run once to (re)generate watermarked_sample.pdf: `python build_watermarked_pdf_fixture.py`.

Renders solid black body text plus a lighter gray "DRAFT" watermark-style
overlay into a single image-only PDF page, simulating a watermarked scanned
document. This is a simplified simulation (flat gray color, not a real
semi-transparent diagonal overlay) — good enough to test confidence-based
filtering behavior, not a faithful real-world watermark reproduction.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

fixtures_dir = Path(__file__).parent
image_path = fixtures_dir / "_watermarked_page.png"
out_path = fixtures_dir / "watermarked_sample.pdf"

img = Image.new("RGB", (1200, 400), color="white")
draw = ImageDraw.Draw(img)

try:
    body_font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", size=32)
    watermark_font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", size=80)
except OSError:
    body_font = ImageFont.load_default()
    watermark_font = ImageFont.load_default()

# Faint gray watermark, rendered first so body text draws on top (closer to real layering)
draw.text((150, 150), "DRAFT", fill=(210, 210, 210), font=watermark_font)

# Solid black body text — the real content we want preserved
draw.text((40, 40), "The receiver shall support at least 40 channels.", fill=(0, 0, 0), font=body_font)

img.save(image_path)

c = canvas.Canvas(str(out_path), pagesize=letter)
c.drawImage(str(image_path), 50, 400, width=500, height=167)
c.showPage()
c.save()

image_path.unlink()
print(f"wrote {out_path}")
```

- [ ] **Step 2: Generate the fixture and empirically inspect Tesseract's confidence scores BEFORE writing test assertions**

Run:
```bash
cd /Users/EdenZviSchwartz/Repos/Projects/.claude/worktrees/req2ado-ocr-i18n/elisradevops/req2ado/ingestion
docker run --rm -v "$(pwd)/..:/req2ado" -w /req2ado/ingestion python:3.11-slim bash -c "
  apt-get update -qq &&
  apt-get install -y -qq tesseract-ocr poppler-utils gcc fonts-dejavu-core > /dev/null 2>&1 &&
  pip install -q -e '.[dev]' &&
  python tests/fixtures/build_watermarked_pdf_fixture.py &&
  python -c \"
import pytesseract
from pdf2image import convert_from_path
images = convert_from_path('tests/fixtures/watermarked_sample.pdf', first_page=1, last_page=1)
data = pytesseract.image_to_data(images[0], output_type=pytesseract.Output.DICT)
for text, conf in zip(data['text'], data['conf']):
    if text.strip():
        print(repr(text), conf)
\"
"
```
Expected: a printed list of `(word, confidence)` pairs. Inspect this output carefully — confirm whether "DRAFT" (the watermark word) genuinely has a lower `conf` value than the body-text words ("receiver", "shall", "support", etc.). If the confidence gap is NOT clearly present (e.g. both score similarly high), the fixture's gray value (`210,210,210`) may need to be lightened further (try `230,230,230` or `240,240,240`) and this step re-run — iterate until you observe a real, reportable confidence difference, or conclude honestly that this heuristic doesn't discriminate reliably for this synthetic fixture and adjust Step 3's test accordingly (see the IMPORTANT note above the task).

- [ ] **Step 3: Write the test(s), calibrated to what Step 2 actually observed**

```python
# Add to ingestion/tests/test_ocr.py (append to the existing file)

def test_ocr_page_to_text_filtered_keeps_body_text() -> None:
    from app.loaders.ocr import ocr_page_to_text_filtered

    text = ocr_page_to_text_filtered(str(FIXTURES / "watermarked_sample.pdf"), 0)
    assert "receiver" in text.lower() or "channels" in text.lower()


def test_ocr_page_to_text_filtered_drops_low_confidence_words() -> None:
    # Calibrated against Step 2's empirical confidence inspection: if "DRAFT"
    # scored meaningfully lower than the body text at the default
    # confidence_threshold=30, it should be filtered out here. This assertion
    # documents the OBSERVED behavior from Step 2 — if Step 2 found the
    # confidence gap unreliable, adjust this assertion (or the threshold
    # default) to match reality rather than asserting a false guarantee.
    from app.loaders.ocr import ocr_page_to_text_filtered

    text = ocr_page_to_text_filtered(str(FIXTURES / "watermarked_sample.pdf"), 0)
    assert "DRAFT" not in text
```

If Step 2's empirical check showed the confidence gap is NOT reliable enough to support `test_ocr_page_to_text_filtered_drops_low_confidence_words` as written, replace that test's assertion with a softer, honest one (e.g. asserting the filtered text is no LONGER than the unfiltered text, or simply removing this second test and noting in the commit message that confidence-based filtering did not reliably discriminate this synthetic watermark style) — do not force a fragile assertion to pass by over-tuning the fixture to the test.

- [ ] **Step 4: Implement `ocr_page_to_text_filtered` and wire it in**

```python
# ingestion/app/loaders/ocr.py — add this function, and modify load_pdf_with_ocr_fallback's OCR call

from pytesseract import Output  # add to existing imports at top of file


def ocr_page_to_text_filtered(
    path: str, page_index: int, languages: str = "eng", confidence_threshold: int = 30
) -> str:
    """Best-effort watermark mitigation: drops words below `confidence_threshold`
    (Tesseract's 0-100 confidence scale; -1 means non-text region, always
    dropped). Watermarks are OFTEN rendered fainter than body text, which
    OFTEN produces lower OCR confidence — but this is a heuristic, not a
    guarantee. It will not detect a watermark rendered at similar contrast
    to body text, and may occasionally drop genuine low-confidence body
    text (e.g. blurry scans). Full watermark detection (image-processing
    based) is out of scope for this function."""
    images = convert_from_path(path, first_page=page_index + 1, last_page=page_index + 1)
    data = pytesseract.image_to_data(images[0], lang=languages, output_type=Output.DICT)

    kept_words = [
        word
        for word, conf in zip(data["text"], data["conf"])
        if word.strip() and int(conf) >= confidence_threshold
    ]
    return " ".join(kept_words)
```

Then modify `load_pdf_with_ocr_fallback`'s OCR call (the line reading `ocr_text = ocr_page_to_text(path, page_index, languages=languages).strip()`) to instead call:

```python
        ocr_text = ocr_page_to_text_filtered(path, page_index, languages=languages).strip()
```

- [ ] **Step 5: Run the tests written in Step 3 to confirm they pass, then run the full suite inside Docker**

Run:
```bash
docker run --rm -v "$(pwd)/..:/req2ado" -w /req2ado/ingestion python:3.11-slim bash -c "
  apt-get update -qq &&
  apt-get install -y -qq tesseract-ocr tesseract-ocr-heb poppler-utils gcc fonts-noto-core fonts-dejavu-core > /dev/null 2>&1 &&
  pip install -q -e '.[dev]' &&
  pytest -v
"
```
Expected: all tests pass (should be 44-45 total depending on whether Step 3's second test was kept or adjusted per its own instructions). Pay special attention to `test_load_pdf_with_ocr_fallback_produces_open_tbd_block` and `test_ingest_scanned_pdf_via_ocr` (pre-existing tests from Phase 1) — since `load_pdf_with_ocr_fallback` now calls the filtered function internally, confirm these still pass unchanged (the English "OPEN: confirm connector..." fixture's body text should all score above the default `confidence_threshold=30`, since it's solid black text — but verify this empirically rather than assuming).

- [ ] **Step 6: Commit**

```bash
git add ingestion/app/loaders/ocr.py ingestion/tests/test_ocr.py ingestion/tests/fixtures/build_watermarked_pdf_fixture.py ingestion/tests/fixtures/watermarked_sample.pdf
git commit -m "feat(ingestion): add confidence-based OCR word filtering as best-effort watermark mitigation"
```

---

## Self-Review Notes

- **Spec coverage:** Task A covers configurable OCR language end-to-end (loader → dispatcher → API) with Hebrew as the concrete proof case; Task B covers confidence-based filtering wired as the new default OCR path. Both explicitly documented as heuristics where accuracy isn't guaranteed (RTL text ordering nuances beyond basic Unicode-range detection; watermark confidence separation not guaranteed for all watermark styles) — this plan does not oversell either as a fully solved problem, per the global constraint.
- **Explicitly out of scope, and correctly so:** true bidi (bidirectional) text reordering/layout correctness for mixed Hebrew+Latin lines (only Unicode-range presence is tested, not reading-order correctness); real watermark detection via image analysis; multi-language auto-detection (`languages` must be explicitly passed by the caller — no auto-detect logic).
- **Type consistency:** `languages: str = "eng"` parameter name and default are identical across `ocr_page_to_text`, `load_pdf_with_ocr_fallback`, `dispatch_by_extension`, and the FastAPI endpoint — verified no naming drift (e.g., not `lang` in one place and `languages` in another). `confidence_threshold: int = 30` is only on `ocr_page_to_text_filtered`, not threaded further up the call chain in this addendum (callers use the default) — if per-request confidence tuning is wanted later, that's a follow-up, not silently promised here.
- **No placeholders:** all steps contain complete, runnable code; Step 2 of Task B explicitly instructs empirical verification before finalizing Step 3's assertions — this is intentional (an exploratory step), not a TBD/placeholder, and the plan states exactly what to do if the empirical result differs from the expected one.
