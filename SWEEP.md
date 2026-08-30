# req2ado Pre-Release Sweep

Full end-to-end audit of all four services (`frontend/`, `orchestrator/`, `ingestion/`, `mcp-ado-server/`), investigated by 9 parallel Opus-model passes on 2026-08-30. This is a **multi-session task tracker**, not a one-sitting checklist — check items off as they're actually fixed and verified, don't batch-check.

## Legend

- 🔴 **Blocker** — real data-integrity/correctness bug or release-blocking gap. Fix before shipping to production customers.
- 🟠 **High** — real bug or meaningful gap, not release-blocking on its own, but should land soon.
- 🟡 **Medium** — real issue, safe to ship without, worth scheduling.
- 🟢 **Low** — genuine but minor; batch these together when convenient.
- 🔵 **Info/Deferred** — investigated, not a bug, or explicitly a future feature/design decision.

Each item: `- [ ] SEVERITY — one-line summary (file:line)`. Longer context follows as a sub-bullet where useful.

---

## Executive Triage — cross-cutting Blockers (read this section first)

These are the items that actually threaten data integrity or correctness in production. Everything else in this document is real but non-blocking.

- [ ] 🔴 **`confirm()` can create duplicate ADO work items via a non-atomic status guard.** Two concurrent confirms (two tabs, a client timeout + retry, or an automation caller) both pass the `diff_ready` check before either writes `status: 'writing'`, so both build identical `toCreate` sets and both write to ADO. `orchestrator/src/modules/pipeline/jobs.service.ts:1401-1405`. Fix: `updateMany({ where: { id, status: 'diff_ready' }, data: { status: 'writing' } })`, throw if `count === 0`.
- [ ] 🔴 **`confirm()` writes to ADO *before* recording the durable resume row, so a failure orphans real work items and retries duplicate them.** `createWorkItem` → `idempotencyService.record()` (bare `prisma.create` against a unique constraint) → `createdItemMapping.upsert()`. If `record()` throws (e.g. a resubmit of the same document racing an earlier confirm), the ADO item now exists with no `CreatedItemMapping` row, so every retry recreates it, unbounded. `jobs.service.ts:1750-1761`, `orchestrator/src/modules/writeback/idempotency.service.ts:46-48`. Fix: move the `createdItemMapping.upsert` to right after `createWorkItem`, before `record()`; make `record()` an upsert on `{sourceHash, areaPath}`.
- [ ] 🔴 **`retryWithBackoff` retries non-idempotent POST creates on lost responses.** Any dispatched request with no HTTP response (timeout, `ECONNRESET`, 502/503/504) is treated as retryable, including `createWorkItem`'s POST (`maxRetries: 5`). If ADO commits the create but the response is lost, retries create up to 6 copies, and since the orphans never reach any mapping table, req2ado is permanently blind to them. `mcp-ado-server/src/backends/retryWithBackoff.ts:55-68`, `realAdo.ts:168-182` (same shape in `uploadAttachment`, `:484-488`). Fix: add a `retryOnNoResponse: false` option, pass it from the create/upload call sites only.
- [ ] 🔴 **A failed dedup-judge silently drops real requirements — fails open in the *unsafe* direction with zero logging.** The judge only runs to *downgrade* an embedding-flagged duplicate; on exception it leaves `is_duplicate = True` with no warning logged anywhere (every other fail-open path in this codebase appends an `IntegrityWarning` — this is the one exception). With the judge backend down, every borderline match becomes a silent `dedup_skip`, and `confirm()` never creates those items — while the UI shows a confident "near-duplicate" badge. `ingestion/app/dedup/check_for_duplicates.py:127-134`. Fix: log a warning and set a distinguishable `judge_verdict = "judge_failed"`.
- [ ] 🔴 **Supported document-format set disagrees across all three layers, and the KB upload path has no gate at all.** Ingestion accepts 8 extensions + 8 image types; the orchestrator and both frontend dropzones accept only 5; the orchestrator's own comment claiming the lists match is stale and false. `ingestion/app/dispatch.py:19-20` vs `orchestrator/src/modules/pipeline/jobs.controller.ts:38-45` vs `frontend/src/components/FileDropzone.tsx:7-8`/`MultiFileDropzone.tsx:11-12` vs `ingestion/app/kb/ingest_service.py:131` (no gate). Fix: pick the shipping set, export one shared constant, gate the KB path to match.
- [ ] 🔴 **BASELINE mode on a multi-sheet `.xlsx` collapses every sheet into a single ADO work item.** Every sheet gets `SourceRef(start_offset=0, end_offset=0)`; the identity hash used for BASELINE table-only docs deliberately excludes description text, so all N sheets hash identically and idempotency lookup resolves sheets 2..N to sheet 1's item. `ingestion/app/loaders/xlsx_loader.py:441`, `ingestion/app/leveling/tree_builder.py:125-146,670-692`. A related, same-shape Medium bug: PDF table offsets reset per page (`pdf_loader.py:1825`), causing cross-page collisions for the first table on any page. Fix: give sheet *i* offsets `(i, i+1)` (pptx already does this).
- [ ] 🔴 **No LLM call anywhere sets a `seed`, and the orchestrator's wire DTO silently drops one if sent.** `orchestrator/src/modules/llm/openwebui.client.ts:83` supports `seed`, but `llm-chat.dto.ts:37-64` has no `seed` field and `llm.controller.ts:37-48` never forwards one — so nothing in the pipeline is actually reproducible run-to-run, undermining item 6's determinism ask entirely. Fix: add `seed` to the DTO and controller (both stream and non-stream branches), set `seed=42` once in `OrchestratorLlmClient.__init__`, spread into every payload, and add it to the LLM cache key.
- [ ] 🔴 **O(n²·d) pure-Python cosine similarity scan in conflict detection, with a 3× wasted constant.** Recomputes both vector norms on every pair even though the input vectors are already unit-normalized (so the norm is provably always 1.0). At 500 requirements this is minutes of single-threaded CPU inside a job. `ingestion/app/leveling/conflict_detection.py:28-34,149-153`. `numpy` is already a transitive dependency — vectorize as one `E @ E.T` matmul.

**Fix order recommendation:** the two orchestrator confirm-path races, then `retryWithBackoff`, then the dedup-judge swallow (these four are the direct "duplicate or lost work items in ADO" risk). Then the format-set/xlsx-collapse pair (data-integrity for non-docx customers). Then the seed/determinism fix and the conflict-detection vectorization (correctness-adjacent + a very cheap, very high-value performance win).

---

## 1. Dead code & redundant comments

Comment hygiene is genuinely clean repo-wide — no commented-out blocks, no restatement-noise found. All items below are dead code (unused exports/functions), not comments.

- [ ] 🟡 Dead code cluster: single-block SURVEY requirement path is unreachable from `main.py`/`dispatch.py`, kept alive only by its own tests. `ingestion/app/survey/build_survey_requirements.py`, `requirement_client.py`, `OrchestratorLlmClient.generate_requirements` (`orchestrator_llm_client.py:944`), plus `tests/test_build_survey_requirements.py` and `tests/test_survey_golden.py`. Delete the module, protocol, client method, and both test files together (keep the `.txt` prompt per the versioning convention).
- [ ] 🟢 Dead export `useJobDetail` — `frontend/src/store/jobsStore.ts:120`, zero references.
- [ ] 🟢 Dead export pair `RELEVANCE_LABELS`/`relevanceLabel` — `frontend/src/utils/labels.ts:103,109`, neither is consumed as designed.
- [ ] 🟢 `stripProjectPrefix` exported but only used in its own file — `frontend/src/components/DestinationBar.tsx:102`; drop `export`.
- [ ] 🟢 `solve3x3` and `ETA_*` constants exported but unused externally — `orchestrator/src/modules/pipeline/eta.service.ts:147`.
- [ ] 🟢 Dead function `requirements_by_node_schema` — `ingestion/app/survey/_response_schemas.py:259`, zero references.
- [ ] 🟢 `ocr_page_to_text` is test-only; production uses `ocr_page_to_text_filtered` — `ingestion/app/loaders/ocr.py:19`. Decide: keep as documented baseline, or fold tests into the filtered variant and delete.
- [ ] 🟢 Dead export `redactPat` — `mcp-ado-server/src/auth/patAuth.ts:30`, no reference outside stale `dist/`.

## 2. Duplicated code & reusable modules (incl. styling classes)

- [ ] 🟠 `formatFileSize` byte-for-byte triplicated (`frontend/src/components/MultiFileDropzone.tsx:23`, `pages/NewJobWizard.tsx:35`, `pages/BatchStatus.tsx:31`) **plus a 4th, divergent variant** (`SharePointFolderTree.tsx:14`) that already renders sizes inconsistently in the same UI. Move to `src/utils/fileSize.ts`, delete the other three, reconcile the 4th.
- [ ] 🟠 The ~20-field job-detail response shape is declared inline **twice** and must be kept in sync by hand — already caused one documented live bug (a field silently dropped by the narrower of the two shapes). `orchestrator/src/modules/pipeline/jobs.service.ts:500-525` vs `jobs.controller.ts:275-296`. Extract one exported `JobDetailResponse` interface.
- [ ] 🟠 ~20 LLM call sites in `ingestion/app/survey/orchestrator_llm_client.py` repeat the same payload-envelope + response-parsing boilerplate (12+ end in an identical 4-line tail; the sampling-options block repeats 18-19 times — this is also why fixing prompt-determinism item 6 in one place won't propagate without this refactor). Add a private `_chat_json(...)` helper and collapse the simple methods onto it.
- [ ] 🟡 Form-field label/wrapper shell duplicated verbatim across `frontend/src/ui/TextField.tsx:28-39`, `Select.tsx:68-78`, `Combobox.tsx:100-110`. Extract a shared `<FieldShell>`.
- [ ] 🟡 Section-label Tailwind string (`text-micro font-semibold uppercase tracking-wide text-ink-3`) hand-repeated 8+ times across `StatTile.tsx`, `AddChildForm.tsx`, `DestinationBar.tsx`, `ChatPanel.tsx`, `NodeDetailPanel.tsx`. Export a `LABEL_MICRO` constant or `.label-micro` class.
- [ ] 🟡 Table `<th>` class strings copy-pasted per column across `KbFileList.tsx`, `BatchStatus.tsx`, `JobsList.tsx` (three overlapping recipes). Extract a shared `TableHeaderCell` with an `align` prop.
- [ ] 🟡 No shared test render helper — provider wrapper re-declared in ~10 frontend test files. Add `renderWithProviders(ui, opts)` to `src/test/`.
- [ ] 🟡 `FolderIngestFile` interface re-declared inline instead of imported — `orchestrator/src/modules/pipeline/ingestion-http.client.ts:378-388` duplicates `kb.service.ts:33-42`.
- [ ] 🟡 No shared Prisma test double; mocks re-declared per spec (13+ inline mocks in one file alone). Add `test/helpers/prismaMock.ts`.
- [ ] 🟡 Figure-emission sequence duplicated across every visual loader (`pdf_loader.py:2067`, `docx_loader.py:950,1050`, `pptx_loader.py:331`). Extract a shared `append_figure(...)` helper.
- [ ] 🟡 Two Chroma vector stores share identical construction, but a documented perf fix (collection-handle caching) landed in only one. `ingestion/app/dedup/vector_store.py:39-49` vs `kb/kb_vector_store.py:39-54` (uncached `get_or_create_collection` on every query). Port the cache.
- [ ] 🟡 `timingSafeEqualBearer` byte-identical in two services with no shared source — security-relevant logic forking silently. `mcp-ado-server/src/auth/timingSafeEqualBearer.ts` vs `orchestrator/src/modules/llm/timing-safe-equal-bearer.ts`. Promote to `shared/ts/src/`.
- [ ] 🟢 `_add_requirements_table` duplicated identically across two test fixture builders — move to `tests/fixtures/_docx_helpers.py`.
- [ ] 🟢 10-12 parameter `analyze_section*` signature restated 4 times across protocol + 3 implementations — introduce a frozen `SectionAnalysisOptions` dataclass.
- [ ] 🟢 (frontend, cross-referenced from item 9) `action`→status-label mapping duplicated between `ActionBadge.tsx:31-70` and `DiffTree.tsx:292-303`'s column-width measurer — drift here silently mis-sizes a UI column. Export one `actionLabel(entry)` and call it from both.
- [ ] 🟢 Style/logic dup batch: `SEVERITY_ICON` verbatim in `Alert.tsx` and `ToastProvider.tsx`; neutral fallback hex `'#64748B'` hardcoded in 3 files; filter-predicate `(!filterAction || …) && (!query || …)` duplicated 3x; `QualityGauge.tsx` has two identical 12-line category-partition loops and duplicates a "Cleared: …" list block twice in the same file.

## 3. Cross-file-type process consistency

- [ ] 🔴 (see Executive Triage) Supported-format set diverges across ingestion/orchestrator/frontend/KB.
- [ ] 🔴 (see Executive Triage) BASELINE multi-sheet xlsx collapse.
- [ ] 🟠 PDF's own figure-caption-name harvesting logic (`Figure.name` from the document's own "Figure N: Title" label) was never extended to docx/pptx/image. Worse, docx *inverts* the documented rule — the author's own Caption paragraph gets written into the vision-prose field instead, so the LLM-authored title wins over the document's real one. `ingestion/app/loaders/pdf_loader.py:1889-1914` vs `docx_loader.py:861-867` vs `pptx_loader.py:329`/`image_loader.py:36`. Fix docx to set `name=` from Caption and leave `caption` to vision; hoist into a shared helper.
- [ ] 🟠 Table-only formats (xlsx/csv) preview as "0 blocks, 0 sections, empty document map" because the preview and document-map logic is entirely block/heading-driven — and those bogus `(0,0)` samples feed the shared ETA regression model, degrading estimate accuracy for docx/pdf jobs too. `orchestrator/src/modules/pipeline/jobs.controller.ts:232-252`, `eta.service.ts:129-137,296-304,388-398`. Add table/cell counts as ETA features and preview inputs.
- [ ] 🟠 Silent, unevenly-distributed content drops: footnotes/endnotes/comments are read by **no loader at all**, with no warning ever raised; a docx nested-table drop leaks a literal `"[UNSUPPORTED: nested table]"` string into cell text instead of becoming a real warning (breaks the NOTE-prefix bridge that would otherwise catch it); BASELINE silently drops blank tables where SURVEY warns; pptx never descends into grouped shapes (pictures/tables inside a group vanish) while docx has a fallback pass for the same class of miss. Route every drop through the existing `[UNSUPPORTED: …]` NOTE-block channel.
- [ ] 🟡 Figure-progress narration (structural pre-count enabling a real "figure N of M" denominator) is gated to `.docx` only, degrading the progress UI for pdf/pptx/image to open-ended "figure N so far" with no ETA. `ingestion/app/main.py:745-750`. Extend the pre-pass to pptx/images now; PDF via a cheap image-XObject count pass.
- [ ] 🟡 `page_alignment` narration phase never fires for PDF, leaving a stepper sub-state that only ever appears for docx.
- [ ] 🟡 Warning categories are format-skewed: `[UNSUPPORTED:` codes are entirely disjoint per format; `OCR_RECOVERED_TABLE_TEXT` and `EXTERNAL_REFERENCE` are missing from the warning-grouping module that every sibling kind uses, so a scanned PDF with 40 recovered tables spams 40 near-identical warning rows instead of one grouped entry.
- [ ] 🟡 `OPEN_TBD` classification (flagged in the New Job wizard's "worth knowing" card) is produced only for scanned PDFs — the check silently never runs for docx/txt/xlsx/native-text PDF, the primary formats. Move into a shared post-load classification pass in `dispatch.py`.
- [ ] 🟡 Heading/section detection (and therefore Epic/Feature typing, hierarchy inference, `deterministic_subtree`/`map_scope` narration) is structurally unreachable for txt/xlsx/csv, and pptx hardcodes a flat level-1 with no real nesting.
- [ ] 🟡 Encoding handling is inconsistent and unsafe for non-Latin text: RTF is decoded as UTF-8 with silent mojibake on CP1252 content (no warning); CSV/text loaders pass no `errors=` and will **raise and abort ingestion** on a non-UTF-8 file (e.g. Hebrew CP1255), against this codebase's own degrade-don't-raise discipline used elsewhere.
- [ ] 🟢 `pdf_loader.py:941-947` `_line_is_bold` never got the modal-sampling fix its sibling `_line_size` received; docstring claims parity it doesn't have. Currently harmless (value unpacked but never read).

## 4. Knowledge Base actually used per job

- [ ] 🔴 (see Executive Triage) Always-include KB files cited as grounding but never reach analysis/authoring/scoring on the default (tool-capable) model path.
- [ ] 🟠 Job-level `kbCitations` can be non-empty when zero real grounding was applied to the output the user sees — same root cause as above, covered by the same fix.
- [ ] 🟡 Per-step narration on the agentic path is hardcoded `kb_grounded=False` *before* the agentic call runs and is never re-fired with the real result — the UI permanently shows "Not grounded" for this step even when retrieval succeeded. `ingestion/app/leveling/llm_leveling.py:2905`.
- [ ] 🟡 Fabricated citation identity on the fallback path: a synthetic `{"source_file": "(document-level)", "similarity": 1.0}` renders in the UI as if it were a real KB file match. `llm_leveling.py:2949`. Pass the real citation dicts through instead.
- [ ] 🟡 KB/Chroma retrieval failures are completely silent to the user — exceptions are swallowed, logged server-side only, and no job warning is ever appended, so an outage produces a completed job indistinguishable from "no KB attached." `ingestion/app/kb/retrieval.py:42,94,105`. The `/ready` healthcheck also doesn't ping this store.
- [ ] 🔵 No per-job KB picker exists — KB is attached per-user (global) on a separate page, applying to every SURVEY job for that user. Not a bug, but worth one line in the New Job wizard so "grounded against your knowledge base" isn't read as a per-job opt-in.
- [ ] 🔵 BASELINE never uses the KB — correct as-is (deterministic extraction, no LLM prompt to ground). No action.
- [ ] 🔵 The "golden-e2e vector store isolation" fix from an earlier session only isolated the **dedup** test-script store between runs; KB collections are already separately namespaced by user. Not a production KB isolation defect — verified clean.

## 5. Document-understanding UI summary & cross-run consistency

**Status: requirements gathered, design not yet started.** Everything the pipeline needs for a real "did the AI understand this document" summary already exists — this is a surfacing job, not a new-computation job. Run a `/design` session against the list below before implementing.

Signals that exist today but are **computed and never shown anywhere**:
- [ ] 🟡 `grounding_score` — the single strongest anti-hallucination number the pipeline owns (fraction of generated text's vocabulary present in its source block) is fully computed and piped to the API (`DryRunDiffEntry.groundingScore`) but **no frontend component reads it at all**.
- [ ] 🟡 `flagged` count (`groundingScore < 0.2 || qualityScore < 50`) is computed, typed frontend-side, returned by the API — and never rendered. A "N items need a second look" tile is close to a one-line change.
- [ ] 🟡 `pageAlignAnchoredRatio` (how much of the document could be confidently anchored to real pages) is typed frontend-side, never rendered.
- [ ] 🟢 No warning count-by-kind or by-severity exists per job (only a flat actionable count) — the richest untapped signal for a comprehension summary; only a batch-level histogram exists today.
- [ ] 🟢 `parse_done`'s real `blockCount/tableCount/figureCount` are shown only as transient chips during the run, then lost once the job reaches `diff_ready` — no persisted job-level summary payload exists at all (ingestion's terminal output has no "summary" object, just the raw tree).
- [ ] 🔵 Confirmed: the "quality 82 · well-formed · from §3.2.1" text seen in the New Job mode cards is **hardcoded illustrative mock copy**, not a real computed number — don't treat it as precedent for a pre-run quality prediction.

Cross-format/cross-mode UI consistency (separate from item 3's backend consistency — this is what the *user sees*):
- [ ] 🟠 `figureCount` being docx-only (item 3) means an otherwise-identical PDF job renders a visibly different, degraded progress UI (no ETA, no "figure N of M" sub-label, "no progress estimate for this step yet") — reads as broken, not as a deliberate format difference.
- [ ] 🟡 Page provenance labels flip meaning by format with no explanation: "Page 12 (approx.)" (docx, derived) vs "Page 12" (pdf, native) vs "Slide" (pptx) vs **nothing at all** (xlsx/csv — the whole Sources block disappears).
- [ ] 🟡 Panels silently vanish rather than degrade gracefully: `FigureDescriptions` and `SectionResults` both return `null` when empty, so BASELINE jobs, figure-less PDFs, and any *reloaded* SURVEY job (SectionResults is SSE-only, never persisted) render a structurally shorter page with zero explanation of why.
- [ ] 🟡 No format branch exists in the job UI at all today — every format difference reaches the user as a silently-null field rather than an explicit "what this format can/can't tell you" state. Contrast with BASELINE-vs-SURVEY mode handling, which already does this well (`JobLifecycleSteps.tsx:16-42,132`) and should be the template.
- [ ] 🔵 Heading-detection confidence genuinely differs by source (docx: real style names; PDF: font-size heuristic ranking) but is presented with equal authority in the wizard's Sections/Depth tiles — worth a confidence indicator, not urgent.

## 6. LLM prompt determinism

- [ ] 🔴 (see Executive Triage) No `seed` anywhere; orchestrator DTO drops it silently even if sent.
- [ ] 🟠 `topK`/`minP` (already configured, `_SURVEY_TOP_K=50`/`_SURVEY_MIN_P=0.05`) are forwarded on only 5 of 19 chat payloads — missing from trace-links, scoring, synthesis, title/tag, parent-summary, dedup-judge, group-topics, distill-title, and plain `generate_requirements`. Hoist into one `_sampling_options()` helper spread onto every payload.
- [ ] 🟠 Two module-level singleton clients (`_dedup_judge_client`, `_checklist_client`) run with **no model override, no `numCtx`, no sampling options** — dedup verdicts and KB-checklist extraction silently run on the orchestrator's default model, with the exact silent-truncation risk this codebase documents elsewhere as already-confirmed-missing. `ingestion/app/main.py:172,196,1223`.
- [ ] 🟡 The one non-JSON `chat/chat_client.py` surface runs at `temperature: 0.3` (the only non-zero value in the codebase) with no seed; the streaming controller forwards only `model/temperature/responseSchema/maxTokens`, silently discarding `numCtx/topK/minP/think` even though the DTO accepts them.
- [ ] 🟡 Vision captioning is deterministic today only by server-side accident (hardcoded on the OpenWebUI client side) — nothing in Python expresses or protects this, and `max_tokens: 300` is a live caption-truncation risk with a workaround already in place for the symptom, not the cause.
- [ ] 🟢 Embeddings carry no model-version pin — swapping the embed model server-side silently invalidates every stored dedup/KB vector with no detection. Stamp the embed model name into the vector-store collection key.

## 7. Prompt structure, token cost, canaries/hallucination-reduction

- [ ] 🟠 **Highest-leverage fix in the whole audit:** the whole-document trace-link-inference prompt (largest single payload in the system) has no output schema and no evidence requirement — nothing checks a proposed link has any textual basis. Wrap output as `{"links": [...]}` with an **unbounded** array (a bounded `maxItems` is what triggers the known Ollama grammar-cost cliff — keep it unbounded on purpose) plus a required `evidence_quote` field, and reject any link whose quote isn't a literal substring of the source node's text. `ingestion/app/survey/orchestrator_llm_client.py:980-1006`, `ingestion/app/leveling/trace_links.py:150-180`.
- [ ] 🟠 The one real hallucination detector (`grounding_score`) is inert for LLM-authored parent nodes (Epics/Features) — the exact nodes least anchored to source text. `_apply_parent_summary_pass` overwrites `node.description` with an LLM summary and never recomputes the score, so it stays at a self-compared 1.0. `ingestion/app/leveling/id_tree_builder.py:434-460` (contrast the synthesis pass at `:609`, which does this correctly). Recompute against the concatenated descendant requirement text, and raise the 0.2 threshold for synthesized parents.
- [ ] 🟡 The scoring prompt forces a fabricated answer for every one of exactly N items with no abstain/confidence channel, and there is no self-consistency, majority-vote, or canary-probe technique anywhere in the repo (zero hits for `majority|canary|vote|self-consistency` in any prompt/LLM path). Add a `confidence` field to the score schema plus one prompt line permitting low-confidence-instead-of-guessing; cheapest canary: one fixed known-bad sentinel requirement appended per job, asserted server-side as an immediate model/config-drift signal.
- [ ] 🟡 The trace-link prompt sends full requirement text for every node in the document; cross-reference signal lives in short prose spans. Truncate per-node text to ~400 chars and pre-filter to nodes matching a cross-reference pattern, sending titles only for the rest — an order-of-magnitude payload reduction on the system's largest call.
- [ ] 🟢 `generate_requirements` (unlike its siblings) has neither a response schema nor `numCtx` set.
- [ ] 🔵 Prompt-prefix caching structure is already correct (dynamic content appended, not interleaved) — no action needed there.

## 8a. Correctness bug sweep

- [ ] 🔴 (see Executive Triage) `confirm()` non-atomic status guard → duplicate ADO writes.
- [ ] 🔴 (see Executive Triage) `confirm()` write-then-record ordering → orphaned/re-duplicated ADO items.
- [ ] 🔴 (see Executive Triage) `retryWithBackoff` retries non-idempotent creates.
- [ ] 🔴 (see Executive Triage) Dedup-judge silent unsafe fail-open.
- [ ] 🟠 `cancel()` can be silently reverted: the worker's last cancellation checkpoint is before a long dedup/verification tail (real jobs: 543-node embed round-trip), and unconditionally writes `status: 'diff_ready'` at the end regardless of a cancel landing in that window — including the automated stale-job watchdog triggering the same resurrection with no user involved. `orchestrator/src/modules/pipeline/pipeline.worker.ts:661,923-967`. Add a cancellation re-check immediately before the final status write.
- [ ] 🟡 `Number(matchedItemId)` with no finiteness check can inject a literal `NaN` as an ADO work-item id from a bad dedup-store record, propagating into a `PATCH .../workItems/NaN` call and a `NaN` audit-table write. `orchestrator/src/modules/writeback/dry-run.service.ts:415-419`.
- [ ] 🟡 Lost updates on `dryRunDiff`: read-modify-write with no optimistic-concurrency check — two clients editing different nodes simultaneously silently discard one edit while both get a success response. The frontend already works around this for bulk-exclude by serializing calls, confirming the hazard is known but unfixed server-side. `jobs.service.ts:610-692`.
- [ ] 🟡 SSE replay-then-subscribe ordering gap: events published between the replay read and the subscribe call are never delivered on that stream; if the dropped event is terminal, the client stalls on "running" until reconnect. `orchestrator/src/modules/pipeline/job-events.controller.ts:77-97`.
- [ ] 🟡 Two unhandled-rejection risks in the frontend job page: `getJob(id).then(...)` with no `.catch` (leaves the user stuck on a stale "running" view with zero signal on failure), and no `onerror` on the job-events `EventSource` (an expired session becomes a silent infinite reconnect loop). `frontend/src/pages/JobDetail.tsx:340`, `api/events.ts:308-340`.
- [ ] 🟢 Unbounded ancestor walk in `isExcluded` — a cyclic `parentLocalId` chain in a persisted diff would hang the confirm request forever (no visited-set guard). `jobs.service.ts:1471-1479`.
- [ ] 🟢 Unguarded `JSON.parse` inside the Redis pub/sub message handler — a malformed publish would throw inside an EventEmitter and crash the orchestrator HTTP process; the persistence subscriber already guards the equivalent case correctly nearby. `job-events.controller.ts:119-120`.

## 8b. Big-O time/space complexity

- [ ] 🔴 (see Executive Triage) O(n²·d) pure-Python cosine scan in conflict detection.
- [ ] 🟠 All 4 chunked LLM enhancement passes (title/tag, synthesis, requirement scoring, epic/feature scoring) run strictly sequentially per chunk despite each chunk being fully independent — the dominant wall-clock term on any large document. `survey_branch_concurrency` also **defaults to 1** in config, so even the already-parallel branch paths run serially out of the box — confirm the production value before shipping. Bounded `ThreadPoolExecutor` (same primitive already used for branch parallelism) is the fix; the real cost is that per-chunk narration ordering would need to become completion-order rather than document-order.
- [ ] 🟠 Figure vision captioning is fully serialized inline during document parsing (one network round-trip per figure, in document order) — a 39-figure document performs 39 sequential vision calls. `ingestion/app/main.py:790-870`. Two-phase (collect during parse, caption with a bounded pool, reassign by id) is the fix, but must preserve the strict lockstep-append invariant already documented in that function.
- [ ] 🟠 `GET /jobs` list endpoint fetches every job's full `dryRunDiff` JSON just to compute `.length`, with **no pagination at all** — a 554-node diff is multi-MB, ×N retained jobs is hundreds of MB transferred and JSON-parsed for a screen that renders a count. `orchestrator/src/modules/pipeline/jobs.service.ts:582-603`. Fix: `jsonb_array_length` via raw SQL, or a denormalized `itemCount` column; add `take`/`skip`.
- [ ] 🟠 Two background sweeps (stale-job watchdog, one other) pull full `Job` rows including `dryRunDiff` on a 5-minute timer with no `select` — every in-flight job's entire diff payload crosses the wire every 5 minutes for a timestamp comparison. Also **no index on `Job.status`**, so both sweeps seq-scan. `stale-job-watchdog.service.ts:54-56`, `jobs.service.ts:195-197`. One-line `select` fix + one migration (`@@index([status])`) — highest value-to-effort ratio in this whole section.
- [ ] 🟠 N+1 query in the stale-job watchdog — one `jobEvent.findFirst` per candidate job inside a loop. Replace with one `groupBy` query (the supporting index already exists).
- [ ] 🟠 N+1 idempotency lookups during dry-run diff construction — 1-2 DB round-trips per node (500-1100 total on a large document, bounded to 8-concurrent so it doesn't stampede, but still serializes into 60-130 sequential batches of latency). `orchestrator/src/modules/writeback/dry-run.service.ts:370`. Prefetch one `findMany` into a map before the diff loop.
- [ ] 🟡 Sequential, non-deduplicated ADO queries for cross-job trace links — links sharing the same target customer-id each issue their own WIQL query. Dedupe the target set first, resolve concurrently.
- [ ] 🟡 Figure bytes rasterized twice per figure (once for captioning, again for storage) despite a code comment claiming reuse. Thread the already-rasterized bytes through the existing out-of-band dict instead.
- [ ] 🟡 O(T·H²) table-to-heading span attribution with a fresh list allocation per (table, boundary) pair — precompute intervals once and `bisect` instead.
- [ ] 🟡 `backfillMissedEvents` uses Redis `KEYS` (blocks the single Redis thread, O(entire keyspace)) — switch to cursor-based `SCAN`.
- [ ] 🟡 Missing indexes: `AuditEntry.jobId` and `DedupSkipAudit.jobId` are filtered/bulk-deleted by `jobId` with no covering index, unlike every other `Job` child table.
- [ ] 🟡 `JobDetail.tsx`'s `descendantCountsByLocalId` builder is **documented in its own comment as O(n) but is actually O(n²)** (copies the sibling array on every child insert). One-line fix (`push` instead of spread-rebuild) — the adversarial shape (one Epic with hundreds of direct children) is needed to see it in profiling.
- [ ] 🟢 One dedicated Redis connection per open SSE stream — a real architectural scaling ceiling (the persistence service already demonstrates the multiplexed-subscribe pattern that would fix it), flagged for awareness rather than this release.
- [ ] 🟢 `filterText.toLowerCase()` recomputed per row inside a filter callback — hoist above the loop (same pattern already done correctly elsewhere in the same codebase).

## 9. React / global CLAUDE.md rules compliance (frontend)

Audited against all 21 rules in the standing React ruleset; rules 7, 10, 14, 16, 18, 19 had zero violations (clean). `React.memo` appears **zero times** in the entire frontend.

- [ ] 🔴 Unhandled promise rejection on chat-history load — a failed fetch silently renders an empty conversation as if the node had never been discussed, with no error surfaced at all. `frontend/src/components/ChatPanel.tsx:145`. Add a `.catch`.
- [ ] 🟠 Multiple backend-mutation handlers have **no re-entry guard at all** (not even state-only) — double-click on Save/Add-Child creates two items. `pages/JobDetail.tsx:824` (`handleSaveEdit`), `:901` (`handleAddChild`). Also credential-write handlers in `pages/Settings.tsx:213,239` and several in `pages/KnowledgeBase.tsx` (`:267,289,310,195`) and `pages/Login.tsx:39` are unguarded or state-only (stale-closure) rather than using the established `useRef` pattern already correct elsewhere in this same codebase.
- [ ] 🟠 Stale-response races with no sequence guard: `KnowledgeBase.tsx`'s folder navigation (clicking folder A then B while A is in flight can land A's contents under B's breadcrumb) and `NewJobWizard.tsx`'s rapid-file-reselection preview race — notably, `NewJobWizard.tsx` already implements the correct `estimateRequestSeq` pattern elsewhere in the *same file* for a sibling call, it just wasn't applied here.
- [ ] 🟡 `JobDetail.tsx`'s nested `getJob(id)` refetch (the *only* path that populates `typeCatalog`/`warnings`/`traceLinkFailures`/`kbCitations` on completion) has no `.catch` and no stale/cancelled guard, silently leaving those fields permanently stale on a transient failure or writing into an unmounted page's state.
- [ ] 🟡 `ToastProvider`'s context `value={{ showToast }}` is a fresh object every render, causing every toast consumer in the tree to re-render on each add/dismiss. Wrap in `useMemo`.
- [ ] 🟡 `ProgressBanner`/`SectionStepList`/`DiffTreeRow` are unmemoized and rebuild collections (a `Set`, a `Map`, N row objects) on every 1-second clock tick or drag-move tick, with unstable props flowing into `DiffTreeRow` specifically.
- [ ] 🟡 Numeric-guard gaps that can render a literal `NaN` in the UI: `QualityGauge.tsx` band-clamp math has no `Number.isFinite` check (`:139,230`); `ProgressBanner.tsx:358`'s ETA calc has no `startedAt` validity check (an unparseable timestamp pins the ETA to "Estimating…" forever); several `formatFileSize`/`toFixed` call sites are unguarded (cross-references item 2's duplication finding).
- [ ] 🟡 `pages/JobDetail.tsx` is 1600 lines with 47 `useState` and 7 `useEffect` in one component — a clear Hook-SRP violation at the component level. Extract `useJobData(id)` and `useJobNarration(id, isLive)`. Similar, smaller versions in `KnowledgeBase.tsx`, `Settings.tsx`, `NewJobWizard.tsx`, `ChatPanel.tsx`.
- [ ] 🟢 Remaining violation counts by rule (full detail in the agent's original report, available on request): Rule 1 (State Shape) 3 Low; Rule 2 (Constants) 6 mostly-Low; Rule 4 (Inline CSS) 9 Low; Rule 5 (Style reuse) 5 Medium/Low; Rule 8 (DRY helpers) 6, overlaps item 2; Rule 13 (Hook encapsulation) 1 Low; Rule 15 (useEffect deps) 2 Low — both in `useWindowStartedAt`/`useWindowBaselineUnits`, the same shape already fixed once this session, recurred.

## 10. Partial-tree approval semantics (answers your question directly)

**Direct answer:** the only selection mechanism reachable from the UI today is a per-row **Exclude** checkbox, and exclusion **cascades down the entire subtree**. So "approve only the Requirements, not the Feature" or "approve unrelated Requirements from an unapproved Feature" is **not achievable in the UI** — excluding a parent silently drops its children too, and root-level Requirements are structurally forbidden even if you tried to route around it. This is conservative and tested (never creates an orphan), and is a **product/feature-scope decision, not a bug**, if this is genuinely a workflow customers need.

- [ ] 🟠 **Real bug found along the way:** the confirm dialog's "This creates N new work items" count ignores exclusions entirely (no ancestor-walk filter), so it over-promises whenever anything is excluded — directly contradicts what the write will actually do. `orchestrator/src/modules/pipeline/diff-summary.ts:27-35`, surfaced at `frontend/src/pages/JobDetail.tsx:1171`. Reuse the existing ancestry-walk filter before summarizing.
- [ ] 🟢 Latent trap (not currently reachable, no fix needed yet): a lower-level `selectedLocalIds` API exists server-side and would allow a row-level selection that violates the app's own tier rules (a root-level Requirement) if it were ever wired to the UI — it's safe today only because no caller passes it. Flag this in code review if row-level selection is ever built.
- [ ] 🟢 A childless parent (Feature approved, all children excluded) is created as an empty node in ADO with no explicit check either way — not flagged as wrong, just undocumented behavior worth a product decision.
- [ ] 🔵 No pre-submit warning exists for either scenario (orphan-producing or empty-parent-producing selections) beyond a small `EyeOff` icon + tooltip on affected rows. Consider a real "this drops N items" summary before Confirm as a UX improvement, not a correctness fix.

---

## Notes for whoever picks this up next

- All 9 investigations were read-only — **nothing in this document has been fixed yet**, this is the triage output only.
- Items 6/7 (prompt determinism/structure) and item 2's LLM-client duplication should likely be fixed together — the `_chat_json()` refactor and the `_sampling_options()` helper are the same piece of work.
- Item 5 needs an actual `/design` session before implementation — this document only gathered the data inventory, no UI has been designed.
- Item 8a's 4 Blockers and item 3/4's Blockers are independent of each other and can be parallelized across sessions/people.
- When closing an item, replace `- [ ]` with `- [x]` and add a one-line note of what was actually done + how it was verified (test added, live job re-run, etc.) — don't just check the box.
