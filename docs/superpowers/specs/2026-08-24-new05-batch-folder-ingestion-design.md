# NEW-05 — Batch/Folder Ingestion — Design (draft)

**Status: DRAFT, not approved.** Written per the req2ado gap-closure plan's Phase 5 instruction
to spec this before touching any code — the architectural questions below need explicit sign-off
first, this is real new surface area (a second job shape), not a wiring fix. Do not implement
against this document until the open questions section is resolved.

## Purpose

Close NEW-05: "Enumerate and process all files in a source folder (e.g., the Customer
Requirements network folder), with per-file status and an aggregated ingestion report." Today the
whole product is strictly one-document-per-job — there is no way to point it at more than one
file and get more than one job's worth of work items out of a single submission.

## Prior state (confirmed by investigation this session)

- **Exactly one BullMQ queue, one enqueue call site.** `orchestrator/src/modules/pipeline/
  jobs.service.ts`'s `submit()` (`prisma.job.create` + `this.queue.add('ingest-and-level', ...)`)
  is the only place a job is ever created. No parent/child job concept, no `FlowProducer`, no
  second queue anywhere in the orchestrator.
- **The only existing folder-crawl code is unrelated and not a shortcut.** `ingestion/app/kb/
  ingest_service.py: ingest_folder_from_url` (Microsoft Graph API, `MAX_FOLDER_DEPTH = 5`,
  sequential/single-threaded) feeds the SURVEY-mode Knowledge Base's retrieval context — it never
  creates a work item, and its own orchestrator endpoint (`POST /kb/ingest-folder-url`) is itself
  currently frontend-dead-code (the shipped `KnowledgeBase.tsx` UI only calls the per-file
  `ingestFolderItem`, never the bulk one). It answers "what SharePoint client/pagination code
  already exists," nothing more.
- **Reusable primitive:** `orchestrator/src/modules/pipeline/map-with-concurrency.ts` — bounded,
  order-preserving, `Promise.allSettled`-style concurrency, already used by `confirm()`'s
  create/link/trace-link/attach phases and by `BackfillService`. This is the right tool for
  bounding fan-out inside the orchestrator process; it does not help with BullMQ-level scheduling.
- **Known cost/timeout ceilings that a batch will hit sooner than a single file does:**
  - The dev/staging LLM backend runs exactly one concurrent generation slot
    (`docs/survey-performance.md`, `-np 1`) — SURVEY jobs already serialize onto real wall-clock
    time with zero isolation between jobs today; a batch multiplies this directly.
  - `INGESTION_REQUEST_TIMEOUT_MS` (default 1 hour, `IngestionHttpClient`'s own `Agent`) and
    BullMQ's `lockDuration`/`stalledInterval` are already per-job, not global — this scales for
    free with N independent jobs, but N SURVEY jobs racing for the same single generation slot
    will make several of them individually slow enough to approach that per-job ceiling.
  - `StaleJobWatchdogService` (60-min inactivity threshold) is also per-job — no batch-level
    change needed there either.
- **Dedup is confirm()-time, not diff-time.** `ChromaVectorStore` only receives a real upsert
  inside `confirm()` (`jobs.service.ts`'s dedup-upsert batch, after a human approves the diff).
  Two files in the same batch that are BOTH still sitting at `diff_ready` (neither confirmed yet)
  will not dedup against each other — their embeddings don't exist yet. This is a real, current
  limitation to decide about explicitly (see Open Questions), not an oversight to silently fix.

## Open questions — need the user's decision before any implementation

### 1. What is "a source folder," concretely?
The CSV item's own wording ("the Customer Requirements network folder") reads like an on-prem
SMB/UNC file-share path, not necessarily a SharePoint/OneDrive sharing link — but the *only*
folder-crawl precedent in this codebase (`ingest_folder_from_url`) is Microsoft Graph API-based,
which only works against SharePoint/OneDrive, not an arbitrary network path. These are genuinely
different integrations with different auth models (Graph bearer token vs. filesystem access from
inside the ingestion container). **This needs a real answer, not an assumption:**
- (a) A browser-side multi-file picker/drop (`<input type="file" multiple>` or drag-a-folder),
  i.e. the user manually selects N files from wherever they are (including a mapped network
  drive) — no new server-side folder-walking code at all, just N files in one submission. Smallest
  build, and sidesteps the SharePoint-vs-SMB question entirely.
- (b) Reuse/extend the existing SharePoint Graph connector — only works if "the Customer
  Requirements network folder" is actually (or will become) a SharePoint/OneDrive location.
- (c) A genuinely new on-prem filesystem/SMB connector from inside the ingestion container —
  significant new surface (container-side file access, path validation/traversal safety, a new
  credential model), not implied by anything already built.

**Recommendation if forced to pick without more input: (a).** It's the smallest real solution to
the literal ask ("process all files in a folder" is satisfied by "select all the files you want
processed," from the user's own already-mapped network drive, via the OS file picker), needs zero
new backend connector work, and doesn't guess at an integration (SharePoint vs. SMB) the CSV item
doesn't actually specify.

### 2. Job/data model: one parent record, or a shared tag on N ordinary jobs?
**Recommendation:** additive, minimal-diff option — add a nullable `Job.batchId String?` column
and one new small `BatchJob` model (`id`, `areaPath`, `customerId?`, `mode`, `createdAt`,
`userId`) that exists purely for aggregate listing/summary. Each file becomes an ordinary `Job`
row (100% reuse of the existing single-document pipeline, unmodified) tagged with the shared
`batchId`. This avoids rewriting `pipeline.worker.ts`, `dry-run.service.ts`, or `confirm()` at all
— every existing test for the single-job path stays valid untouched. The alternative (a real
parent/child BullMQ `FlowProducer` job graph) is more "architecturally pure" but is a much larger
change for no functional benefit here, since files don't depend on each other's output.

### 3. Concurrency: reuse the process-wide worker pool, or cap batch-originated jobs separately?
**Recommendation:** add a second, smaller concurrency cap specifically for batch-originated SURVEY
jobs (e.g. `BATCH_SURVEY_CONCURRENCY`, default 1–2), enforced by the orchestrator deferring a
batch's later jobs' BullMQ `queue.add` calls rather than enqueueing all N at once — reusing
`mapWithConcurrency`-style bounding at the enqueue layer, not inside the worker. Reason: the
existing `PIPELINE_WORKER_CONCURRENCY` is tuned for "typically one interactively-submitted job at
a time"; a batch of a dozen SURVEY files enqueued at once would otherwise saturate the single
real LLM generation slot and make every one of them individually crawl toward the 1-hour
per-job ceiling, with no isolation or backpressure. BASELINE-only batches have no LLM cost and
don't need this cap.

### 4. Dedup-across-batch: accept today's confirm()-time-only scoping, or change it?
**Recommendation:** accept it for v1, but surface it explicitly in the UI (e.g. a batch-summary
note: "cross-file duplicate detection applies once you confirm a file — reviewing multiple diffs
before confirming any of them won't catch duplicates between them yet"). Changing this would mean
either serializing confirm() across the batch (bad UX: forces one-at-a-time review) or upserting
tentative/unconfirmed embeddings into Chroma (risks polluting the dedup corpus with never-approved
content) — both are real design changes bigger than this phase's stated scope.

### 5. UI shape
**Recommendation:** a new "batch upload" entry point (multi-file picker per Q1a) that submits one
`POST /jobs/batch` call, returning a `batchId`; a new lightweight batch-status page listing each
constituent job's status/link (reusing the existing `JobDetail` page unmodified per file — no new
per-file UI); and one aggregate summary (extend `getSummary()`'s existing shape:
`{created, reused, dedupSkipped, flagged, warnings}` per file, rolled up, plus `filesSucceeded`/
`filesFailed`/`filesPending`). No new SSE channel for v1 — the batch-status page polls
`GET /jobs?batchId=X` the same way `JobsList` already polls today; add a push channel only if
that cadence proves too slow in practice.

## What does NOT need to change
- `pipeline.worker.ts`, `dry-run.service.ts`, `confirm()`, ingestion's `/ingest`/`/level`/
  `/dedup/*` routes — none of these are per-file-vs-per-batch aware today and none need to be,
  under the recommended model (each file is still just an ordinary `Job`).
- Any existing single-document test suite.

## Stability rules carried over from the parent plan
Same non-negotiables as every other phase in this plan: fail-open dedup/scoring stays fail-open;
BASELINE stays provably LLM-free; no destructive ADO operations; additive schema only; warnings
over exceptions; any new long-running loop (a batch's own enqueue/poll loop) fires progress per
unit of work.

## Next step
Resolve the five open questions above (especially #1 — it changes the shape of everything else)
before writing an implementation plan for this phase.
