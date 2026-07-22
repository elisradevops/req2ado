# Handoff — Point 4: Large-file optimization

Source: `docs/handoff.md`'s code-review §4 ("Large-file optimization
issues"). All 5 findings from that section are done.

## What changed

1. **OCR's O(n²) `PdfReader` reconstruction** — `page_has_extractable_text`
   constructed a fresh `PdfReader(path)` on every call, called twice per
   page (~2N reparses of the whole document for an N-page PDF). Added
   `cached_pdf_reader()` (small `functools.lru_cache`) and routed the
   per-page check through it — one real parse per path instead of 2N.
   (`ingestion/app/loaders/pdf_loader.py`)

2. **Upload size cap now enforced inside ingestion, streamed not buffered**
   — `/ingest` previously read the whole upload into memory unconditionally
   with `tmp.write(await file.read())`, no size guard at this layer at all
   (only the orchestrator's own pre-forward check existed, and this
   endpoint is independently reachable). Now streams in 1MB chunks and
   aborts with 413 as soon as the new `MAX_UPLOAD_SIZE_MB`-equivalent
   (`Settings.max_upload_size_mb`, default 25) is exceeded, never buffering
   past the cap. (`ingestion/app/main.py`, `ingestion/app/config.py`)

3. **Embeddings batched, not one-call-per-item** — `JobsService.confirm()`
   previously called `/dedup/upsert` (one embed() round-trip) per
   newly-created node, inline in the sequential loop. Added
   `POST /dedup/upsert-batch` (embeds every item's text in ONE call) and
   `IngestionHttpClient.upsertDedupEntriesBatch()`; `confirm()` now collects
   all newly-created items and upserts them in one batched call after the
   create loop, not one call per node. Trade-off, noted in code: one batch
   failure now loses the dedup backstop for the whole job's items instead of
   just one — acceptable, since it fails open the same way, just at job
   granularity instead of scattered per-item granularity.

4. **Table-only documents (e.g. xlsx) no longer produce an empty tree** —
   `build_baseline_tree`'s headingless-grouping fallback only triggered when
   `doc.blocks` was non-empty; xlsx's loader never produces `doc.blocks` at
   all (only `doc.tables`), so a table-only document fell through the
   structured path with nothing to level → empty tree, silently dropping a
   real spreadsheet's content. The fallback now also triggers when blocks
   are empty but tables aren't, folding each table into its own Requirement
   (pipe-delimited rows as the description, sheet name as the title,
   fully-blank tables skipped rather than becoming empty nodes).
   (`ingestion/app/leveling/tree_builder.py`) — **found and fixed the exact
   test that encoded this bug**: `test_empty_blocks_produces_empty_tree`
   asserted `tree.nodes == []` for a table-only doc; rewritten to assert the
   new, correct behavior.

5. **Real diagram/figure description via vision LLM** — figures were always
   `[FIGURE: none]` placeholders; any requirement expressed only in a
   diagram was silently lost. `LLM_VISION_MODEL` was declared in
   `.env.template` but completely unused anywhere. Implemented end-to-end:
   - `OpenWebUiClient.vision()` (previously a stub throwing
     "not implemented") now sends a real multimodal `chat.completions` call
     (image as a base64 `image_url` content part — same OpenAI-compatible
     endpoint `chat()` already uses, works against Ollama/Open WebUI's
     vision-capable models like llava/bakllava/moondream). Prompt text is
     redacted the same way `chat()` redacts messages.
   - New `POST /llm/vision` proxy route (bearer-guarded, same pattern as
     `/llm/chat`/`/llm/embed`), `LLM_VISION_MODEL` added to
     `config.schema.ts` (optional — unset preserves old placeholder-only
     behavior exactly).
   - New `OrchestratorVisionClient` (`ingestion/app/vision/`, mirrors
     `OrchestratorEmbedClient`'s structure) calls that proxy — never Open
     WebUI/Ollama directly, same boundary every other LLM call in this
     codebase already follows.
   - `docx_loader.py`/`pdf_loader.py` gained an optional `describe_figure`
     callback; when provided, called with the image's real raw bytes
     (docx: `rel.target_part.blob`; pdf: switched from pdfplumber's
     `page.images` — which has no guaranteed standalone-decodable image
     data — to pypdf's `ImageFile.data` via the same `cached_pdf_reader`
     Task 6 added) and the result becomes the figure's real caption instead
     of `None`. A `describe_figure` failure for one image is caught and
     falls back to the placeholder for that image only — never aborts the
     whole document.
   - `/ingest`'s dispatch call is now wrapped in `run_in_threadpool` — it
     can make a real network call per figure now, on top of the CPU-bound
     parsing/OCR work it already did; must not block the event loop, same
     reasoning `/level`'s SURVEY path already documents.

## Verification

- `ingestion`: `.venv/bin/python -m pytest` — 190/197 passing (7 failures
  are the pre-existing, unrelated poppler-not-installed gap — same count as
  before this point, no new failures). New coverage: reader-reuse
  assertion, upload-size-cap 413, dedup-upsert-batch (embed-call-count
  assertion), table-only tree (3 new tests + the rewritten bug-encoding
  test), vision client (3 tests), docx/pdf `describe_figure` wiring +
  failure-isolation (4 tests).
- `orchestrator`: `npx jest` — 131/131 passing (was 124 before this point).
  New coverage: `/llm/vision` route (4 tests), `OpenWebUiClient.vision()`
  (4 tests replacing the old not-implemented stub test),
  `upsertDedupEntriesBatch` (3 tests), rewrote 3 existing `confirm()` dedup
  tests to the new batched call shape.
- Not re-verified against the live ADO org or a real vision-capable local
  model this round — every change here is either a pure logic/perf fix or
  additive, config-gated new capability (`LLM_VISION_MODEL` unset preserves
  exact prior behavior everywhere it's checked). Trying this against a real
  Ollama vision model (llava) would be a good follow-up if diagram
  extraction is actually needed soon.
