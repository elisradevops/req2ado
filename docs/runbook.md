# Runbook

## Recovering a stuck pipeline job (BullMQ)

**Never manually mutate BullMQ's Redis keys directly** (e.g. `redis-cli LREM bull:req2ado-pipeline:active 0 <job-id>`) to clear a job stuck in `running`. This bypasses BullMQ's own bookkeeping and desyncs the worker's in-memory lock-renewal loop from Redis state — confirmed live (throwaway harness, no live app needed): a manual `LREM` on a job's active-list entry, while the owning worker is still actively renewing its lock, produces exactly the "could not renew lock" / "Missing lock for job N" errors observed in a real incident, repeating on every renewal attempt afterward.

**Correct recovery options, in order of preference:**
1. **Wait it out.** If the pipeline-worker process is healthy and the job is genuinely still progressing, let it finish naturally.
2. **Restart the owning pipeline-worker process/container.** BullMQ's own stalled-job detection (`stalledInterval`, now 60s — see `pipeline-worker.main.ts`) reclaims the job cleanly once the lock actually lapses; no manual Redis surgery needed. Note: this DOES kill the in-flight job (any long-running LLM calls are lost) — only do this if the job is actually wedged, not merely slow. Check `GET /jobs` for `running`/`pending` jobs before restarting `pipeline-worker` or `mcp-ado-server` for any other reason (a deploy, a config change) — this has caused unintended job kills before.
3. **If the job must be force-cleared while still locked**, use the BullMQ `Queue` API, not raw redis-cli: `const job = await queue.getJob(id); await job.remove()` — note this itself throws `Job could not be removed because it is locked by another worker` if the lock is still live (confirmed live), which is BullMQ correctly protecting against the exact corruption manual `LREM` causes. If it throws, fall back to option 2.
4. As a last resort, mark the Postgres `Job` row `status='failed'` directly with an audit-trail note explaining the manual intervention (do this only after the BullMQ-side state is already clean via options 1-3, not as a substitute for them).

## Purging a user's KB/PAT-vault data after an ADO account reset

**When to use this:** a user deleted their ADO account and created a new one, and the new account's session still sees the old account's KB context and/or dedup matches. Root cause: both the KB vector store (`ingestion/app/kb/kb_vector_store.py`, Chroma collection keyed by `sha256(userId)`) and the encrypted PAT vault (`credential-vault.service.ts`, row keyed by `user:<userId>`) are keyed off ADO's own `authenticatedUser.descriptor` — deliberately chosen because it survives display-name/email changes, which is exactly what let it survive the account reset too. Neither store has an automated cleanup path (see `job-retention.service.ts`'s own comment: it explicitly never touches either, by design, for unrelated reasons — see the note there about a prior manual DB wipe after an account migration, which this script now replaces with a repeatable, non-destructive-to-other-users command).

**Run from `orchestrator/`:**
```sh
npx ts-node scripts/purge-user-data.ts <userId> [--purge-jobs]
```
- `<userId>` is the ADO descriptor value from `Job.userId` / `IngestedDocument.userId` for the affected account (look it up via `SELECT DISTINCT "userId" FROM "Job" ORDER BY "createdAt" DESC LIMIT 5;` if unsure).
- Always purges: the vaulted PAT row (`ExternalCredential` for `user:<userId>`) and the user's entire KB Chroma collection (`DELETE /kb/collection?user_id=...` on the ingestion service).
- `--purge-jobs` additionally deletes that user's `Job` rows (and their children) — use only when you're certain the old identity is gone forever; job history has no other retention/expiry path (`job-retention.service.ts` only ages out jobs by `createdAt`, regardless of `userId`).
- This does **not** touch `IdempotencyMapping` or the dedup vector store — those are area-path-scoped, not user-scoped, and are deliberately never pruned (see `job-retention.service.ts`'s own comment on why: pruning them would let identical content get recreated as a duplicate work item on a later resubmit).

## Re-backfilling every area path after a dedup embedding-scheme change (e.g. the title/description blend)

**Deploy-critical, not optional.** `check_for_duplicates`/`/dedup/upsert*` compute the dedup similarity vector as a blend of the title and description embeddings (`ingestion/app/dedup/embedding_blend.py`), not the description alone. This is a **breaking change to the embedding scheme**: any vector already stored in an area path's Chroma collection before this deploy was embedded under the OLD (description-only) scheme, and is not directly comparable to a NEW blended query vector — cosine similarity between an old-scheme and new-scheme vector for the same content is not 1.0, and can legitimately land below the fixed 0.90 threshold even for a true duplicate. There is no code-level migration for this (no embedding-scheme version tag is stored per vector); the only fix is to physically re-run the backfill for every area path that has ever been backfilled or seeded before this deploy.

**After deploying any change to `ingestion/app/dedup/embedding_blend.py` (or anything else that changes what gets embedded for dedup), re-run backfill for every known area path:**
```sh
# List every area path that's ever been backfilled:
docker exec <postgres-container> psql -U req2ado -d req2ado -t -c 'SELECT "areaPath" FROM "AreaPathBackfill";'

# Then, authenticated as a user with a valid vaulted PAT, re-run for each:
POST /backfill { "areaPath": "<each one>" }
```
- This re-embeds and re-upserts every scanned item under the new scheme, overwriting the old vectors in place (same Chroma collection, same item ids).
- Skipping this for an area path means every pre-deploy dedup entry in that area path silently stops being a reliable duplicate match until it's re-backfilled — exactly the class of bug this blend change exists to fix, reintroduced for old data.
- This does not touch `IdempotencyMapping` (the exact-hash `reuse` path) — that scheme didn't change.

## Swapping EMBED_MODEL (dedup + KB vector stores)

**Deploy-critical, not optional.** Every Chroma collection name in both vector
stores now includes the configured embed model: `dedup/vector_store.py`'s
`_collection_name_for_area_path` and `kb/kb_vector_store.py`'s
`_kb_collection_name_for_user` both hash `EMBED_MODEL` into the digest
alongside the area path / user id. This is the model-version pin — before it
existed, changing the embed model left every stored vector in place and
silently compared new query vectors against vectors a *different* model
produced, with nothing anywhere able to detect it (there is no per-vector
model tag, and `/llm/embed`'s response body carries no model identifier).

**Consequence, by design:** changing `EMBED_MODEL` starts empty collections.
There is deliberately **no migration and no fallback lookup under the old
collection name** — a collection whose embed model is unknown is unsafe to
keep querying, which was the whole bug. The old collections are orphaned, not
deleted.

**Changing the embed model — do all of these:**
1. Change `EMBED_MODEL` in **one** place that both services read: the shared
   `.env` (docker-compose) or the `req2ado-config` ConfigMap (k8s). Both the
   orchestrator and ingestion consume the same one; setting it on only one
   service silently splits them. `ingestion/tests/test_embed_model_drift.py`
   guards the plumbing that makes this true.
2. Re-backfill dedup for every area path, using the procedure in the section
   above (list `AreaPathBackfill`, then `POST /backfill` for each). Until an
   area path is re-backfilled, its pre-swap entries are simply absent — a
   dedup check behaves as if that area path had never been ingested, so
   nothing is *wrongly* matched, but real duplicates stop being caught.
3. Re-ingest each user's KB sources (`POST /kb/ingest-url` per source).
   Nothing needs purging first: `existing_file_hash` reads from inside the
   collection, so under the new model it reports "never ingested" and the
   ingest re-chunks and re-embeds normally.
4. Optionally reclaim the orphaned collections' disk. They are inert, and
   dropping them is never required for correctness:
   ```sh
   # List every collection, old and new (v2 API; adjust host/port for your deploy):
   curl -s http://localhost:8001/api/v2/tenants/default_tenant/databases/default_database/collections
   ```
   Old dedup collections are `req2ado_<32 hex>` and old KB collections are
   `req2ado_kb_<32 hex>` — the same shape as the new ones, so identify the
   live set first (re-run step 2/3, then re-list and diff) before deleting
   anything. When in doubt, leave them; they cost only disk.

**Do not** try to "fix" a mid-swap state by reverting `EMBED_MODEL` to make the
old collections reachable again unless you are *certain* which model wrote
them — that is exactly the ambiguity the pin exists to eliminate.

## Real ADO Write — Verification Steps (CR7, gated on production access)

**Status: VERIFIED** against a real Azure DevOps Services org
(`https://dev.azure.com/elisradevops/`, project `elisradevops-project`), via
docker-compose with `ADO_BACKEND=real`. All 5 steps below passed: field discovery,
dry-run diff, a real write (work item #436 created with `State: Proposed`), and the
idempotency re-run (`createdCount: 0`, `action: 'reuse'` against #436).

**Six real bugs found and fixed this round** (all now covered by regression tests):
1. `RealAdoBackend.discoverFields` read `response.data.fields`, but ADO's real list
   responses are `{count, value: [...]}` — crashed on `undefined.map`. The test's own
   mock fixture invented the wrong shape too, masking it.
2. `mcp-ado-server`'s `resolveApiVersion` swallowed every error (401 included) and
   silently exhausted the whole ladder, producing an unhelpful generic error instead
   of the real auth failure — same class of bug the auth-login fix (see this repo's
   `ado-pat.provider.ts`) had already fixed on the login path, left unfixed here.
3. Orchestrator's `McpClient.parseToolTextResult` never checked the MCP result's
   `isError` flag, so a real tool error's plain-text message got blindly
   `JSON.parse()`'d, throwing an opaque `SyntaxError` that hid the actual failure.
4. `JobsService.confirm()` set `status: 'writing'` with no try/catch — any failure
   left the job stuck there forever (its own guard requires `diff_ready`, so no retry
   was ever possible again without a manual DB fix). At the time of this round, it
   reverted to `diff_ready` when nothing was written yet, or `failed` when a partial
   write occurred (full resume needed P4b's not-yet-built local-id→ADO-id tree). **P4b
   is now built** (`CreatedItemMapping`, see the Phase 10 checklist below) — confirm()
   always reverts to `diff_ready` now, since a retry safely skips whatever a prior
   attempt already created/linked instead of duplicating it.
5. `mcp-ado-server`'s write-path tool handlers (create/link/setFields) let axios's
   generic `"Request failed with status code 400"` propagate instead of surfacing
   ADO's actual response body (the real reason, e.g. a rejected field/value) — added
   `adoErrorMessage()` to extract it.
6. **The api-version ladder resolution itself was probing the wrong endpoint
   family.** `resolveApiVersion` probed org-level `_apis/connectionData`, which on
   this real org rejected 7.1/7.0/5.1 with 400 (resolving to `"none"`) — but the
   actual `_apis/wit/workitems` create endpoint accepts 7.1 directly and, unlike
   connectionData, hard-requires an explicit api-version, so `"none"` 400'd there
   with "No api-version was supplied". Fixed by probing `{project}/_apis/wit/fields`
   instead — the same endpoint family every real write call uses.

Work items **#435** ("api-version probe - delete me", a manual curl probe) and
**#436** (the golden-e2e-fixture.txt BASELINE test item) were created for real in
`elisradevops-project` during this verification round — both since soft-deleted
(moved to the recycle bin via `DELETE .../_apis/wit/workitems/{id}?api-version=7.1`,
recoverable if needed).

## Multi-node write verification (follow-up round)

**Status: VERIFIED.** The round above only proved a single flat node
(`docs/golden-e2e-fixture.txt` has no heading structure, so ingestion's
headingless-grouping rule folds it into exactly one `Feature` node) — this
round closed two gaps that left open: a real parent/child link write, and a
real Customer ID field population.

Used a new two-level fixture, `docs/golden-e2e-multinode-fixture.md`
(`# Feature heading` / `## Requirement heading`, `icd_style` profile: depth 1
→ `Feature`, depth ≥2 → `Requirement`). All steps passed against the same
real org/project:

- **Dry-run diff**: 2 entries, child's `parentLocalId` correctly pointed at
  the parent's `localId`, both `action: 'create'`.
- **Confirm**: `createdCount: 2`. Verified in ADO: both items `State:
  Proposed`, and the Requirement's `System.LinkTypes.Hierarchy-Reverse`
  relation correctly pointed at the Feature's id — **first real proof that
  `linkParentChild` works against a live org** (previously only unit-tested
  against mocked HTTP).
- **Idempotency re-run**: resubmitting the identical file returned both
  nodes as `action: 'reuse'` with the real ids from the first confirm, and a
  second confirm returned `createdCount: 0` — holds for a tree, not just a
  single node.
- **Customer ID field population — better result than expected.** The
  original CR7 round only checked `ado_discover_fields` for the `Epic` type,
  which has no `Custom.*` candidate field, so it was assumed this project
  couldn't test real population at all. It turns out **`Requirement` has
  `Custom.CustomerRequirementId`**: submitting a job with `customerId` set
  produced a real work item whose `Custom.CustomerRequirementId` field was
  populated with the submitted value — `resolveCustomerIdField`'s runtime
  resolution is proven working end-to-end against real ADO, not just its
  graceful no-op fallback. (`Feature`/`Epic` still have no candidate field,
  so Feature-type nodes correctly get no Customer ID field written — the
  no-op path is exercised too, on the parent node of the same job.)

One caveat carried over from the earlier round: this project's dedup vector
store isn't purged by an ADO soft-delete, so a fixture whose content is a
near-duplicate of a previously-tested (even since-deleted) item resolves to
`dedup_skip` instead of `create` on a fresh submission — hit this once while
drafting the fixture (near-duplicate of the earlier `#436` content) and
worked around it by using unrelated fixture content, rather than a real bug.

Debris from this round — work items **#437**, **#438** (Thermal Management /
Fan Speed Control) and **#439**, **#440** (Power Regulation / Voltage
Stability, the latter carrying the real `Custom.CustomerRequirementId` write)
— all four soft-deleted the same way as #435/#436.

Original notes below, kept for context on what was unverified before either round.

### Prerequisites

- A scratch ADO/TFS project (do not point this at a production project on the first run).
- A Personal Access Token (PAT) for an account with permission to create work items
  and read `_apis/wit/workitemtypes/{type}/fields` in that project.
- If the server presents a self-signed certificate: a CA bundle file reachable from
  wherever `mcp-ado-server` runs.
- `mcp-ado-server`'s own dependencies installed (`cd mcp-ado-server && pnpm install`).

### Steps

1. **Start `mcp-ado-server` against the real backend**, not the mock:

   ```bash
   cd mcp-ado-server
   ADO_BACKEND=real \
   ADO_BASE_URL=https://<your-tfs-host>/tfs/<Collection> \
   ADO_PROJECT=<ScratchProject> \
   ADO_CA_CERT=/path/to/ca-bundle.pem \
   MCP_BEARER=<a-bearer-you-choose> \
   PORT=4100 \
   node dist/index.js   # or: pnpm build && pnpm start
   ```

   `ADO_CA_CERT` is only needed for a self-signed on-prem certificate — omit it for a
   CA-issued cert (see `mcp-ado-server/src/backends/realAdo.ts`'s `buildHttpClient`).

2. **Verify field discovery works before writing anything** — confirms the PAT/org/
   project combination is valid and surfaces the real Customer ID field's ref name
   (see `docs/architecture.md`'s "Customer ID Field Resolution"):

   ```bash
   curl -s -X POST http://localhost:4100/api/ado/ado_discover_fields \
     -H "Authorization: Bearer <a-bearer-you-choose>" \
     -H "Content-Type: application/json" \
     -H "X-Ado-Org-Url: https://<your-tfs-host>/tfs/<Collection>" \
     -H "X-Ado-Pat: <your-real-PAT>" \
     -d '{"workItemType": "Epic"}'
   ```

   Inspect the response for `Custom.CustomerId` / `Custom.CustomerRequirementId` /
   `Custom.CustomerID` — confirms which one (if any) the runtime resolution in
   `JobsService.resolveCustomerIdField` will actually find in this real project.

3. **Run the full pipeline against the scratch project with `dry_run: true` first.**
   Point the orchestrator at this `mcp-ado-server` instance (`MCP_URL`, `MCP_BEARER`
   matching what you started it with above) and submit a small BASELINE document
   through the normal `POST /jobs` → `GET /jobs/:id` flow. Inspect the returned
   `dryRunDiff` — confirm the planned `System.Title`/`System.Description`/
   `System.AreaPath`/`System.State=Proposed` values look right, and that a Customer
   ID field is populated only if step 2 found a real candidate.

4. **Confirm a single write** (`POST /jobs/:id/confirm` with the real
   `X-Ado-Org-Url`/`X-Ado-Pat` headers). Verify in the ADO web UI:
   - Work items were created with `State = Proposed`.
   - Parent/child links use `System.LinkTypes.Hierarchy-Reverse` (child → parent),
     matching the tree structure from the dry-run diff.
   - The Customer ID field (if resolved in step 2) is populated with the value
     that was submitted.

5. **Re-run the exact same document through step 3–4 again** — this is the
   idempotency check. Expect **zero** new work items created (every node should
   resolve to `action: 'reuse'` via `IdempotencyService`'s `(sourceHash, customerId,
   areaPath) -> System.Id` lookup), not duplicates.

## Phase 10 changes — verification checklist (pending a real-ADO run)

Everything below is unit/integration-tested (orchestrator: 185/185 jest;
ingestion: 240/247 pytest, the 7 remaining failures are a pre-existing local
`poppler`/`pdf2image` environment gap, unrelated) but **none of it has been
run against a real org yet** — do this as one more round through steps 1-5
above, using the checklist below to know what to specifically look at in the
ADO web UI for each new capability. Reuse the same scratch project/PAT.

- [ ] **Source traceability field.** `JobsService.resolveSourceRefField`
  tries `Custom.SourceReference` / `Custom.SourceDocument` /
  `Custom.TraceabilityRef`, same discover-then-use pattern as Customer ID
  (see step 2 above, but query `ado_discover_fields` for these three names
  instead). If your project's process template doesn't define any of them,
  this is a no-op by design (documented limitation — no object storage
  exists in this system to host a real source-document URL, so this is a
  best-effort field, not a hard requirement). If one candidate DOES exist,
  confirm the created item's field is populated as
  `<document path>#offset=<start>-<end>` (or `#page=N&offset=...` for a PDF).
- [ ] **Classification writes to the real Requirement Type field, not
  `System.Tags`.** For a Requirement processed in SURVEY mode with a
  non-empty classification, confirm the created item's
  `Microsoft.VSTS.CMMI.RequirementType` (or `Custom.Requirement_Type` if
  that's what this project's process template exposes) is populated with
  the mapped value — and confirm `System.Tags` has NO `functional`/`safety`/
  etc. entries at all. When a Requirement's only tag has no CMMI
  counterpart (`regulatory`/`maintenance`/`behavior`), confirm the field is
  left at ADO's own default and the job's warnings include one
  `classification_not_representable` entry listing that Requirement.
- [ ] **Customer ID / source ref left unwritten when no candidate field
  exists (no `System.Tags` fallback).** A free-text `CustomerId:<value>` /
  `SourceRef:<value>` tag stamp turned out not to be a usable reference —
  removed. For a Requirement whose type has no candidate Customer ID field
  (Epic/Feature never carry one at all, by type gate), confirm the created
  item simply has no Customer ID field populated and — just as important —
  no `CustomerId:` entry in `System.Tags` either. Same check for source ref.
- [ ] **Configurable Customer ID candidates.** If your org uses a Customer ID
  field name not in the default 3-name list, set
  `CUSTOMER_ID_FIELD_CANDIDATES` (comma-separated, see `.env.template`) and
  confirm it resolves to the real field.
- [ ] **HTML table rendering.** Ingest a document containing a real table
  (docx table or xlsx sheet). The created Requirement's `System.Description`
  now contains an HTML `<table>` (row/column-preserving) instead of the
  previous flattened `" | "`-joined plain text. **This is the one item in
  this checklist most worth double-checking carefully**: confirm ADO's web
  UI actually RENDERS it as a table (System.Description is normally an HTML
  rich-text field, but this has not been confirmed against this specific
  org/process template) rather than displaying the raw `<table><tr><td>...`
  markup as literal text. If it renders as raw text, that is a real,
  actionable finding — file it against `ingestion/app/leveling/tree_builder.py`'s
  `_table_to_html`.
- [ ] **Mixed heading+table document.** A document with BOTH real heading
  blocks and a table previously dropped the table entirely (silent data
  loss). Confirm a table in such a document now produces its own Requirement
  child (attached under the last block-derived node — see
  `build_baseline_tree`'s docstring for why "last" is a documented
  approximation, not a precise position).
- [ ] **Flat numbered list grouping.** A flat single-column list (e.g. a
  plain-text/markdown file that's just `1 Do X`, `2 Do Y`, `3 Do Z` with no
  heading structure) previously produced N orphan top-level Feature items
  with no parent at all. Confirm it now creates one Epic → one Feature →
  N Requirement children instead.
- [ ] **ICD depth-3 sub-requirement.** If you have (or can construct) a
  document with a genuine icd_style sub-requirement one level below the
  normal Feature/Requirement pair (depth 3), confirm it resolves as another
  Requirement under its parent Requirement, not as a whole new Epic/Epic/
  Feature branch (the fix in `detect_profile_for_branch`, see
  `docs/architecture.md` section 1g).
- [ ] **SURVEY mode Customer ID.** Submit a SURVEY-mode job with `customerId`
  set. Previously this field was silently dropped for every SURVEY node
  (`build_survey_tree` had no `customer_id` parameter at all) — confirm a
  SURVEY-mode Requirement now gets the same Customer ID field population as
  a BASELINE one would (per the checklist item above).
- [ ] **Reject + row deselect.** `POST /jobs/:id/reject` on a `diff_ready`
  job should move it to `rejected` with zero ADO writes. `POST /jobs/:id/confirm`
  with a `selectedLocalIds` body array should create ONLY those rows —
  confirm a deselected row's ADO item does not exist, and that a child of a
  deselected parent still creates (orphaned, no parent link) rather than
  failing the whole confirm.
- [ ] **Summary + dedup-skip audit endpoints.** `GET /jobs/:id/summary`
  should return `{created, reused, dedupSkipped, flagged, warnings}` matching
  the dry-run diff you already verified in step 3. `GET /jobs/:id/dedup-skips`
  should return one durable row per `dedup_skip` entry (only relevant if a
  follow-up/near-duplicate document was submitted in this round, per the
  existing dedup-vector-store caveat above).
- [ ] **Post-write resume (P4b).** This is the hardest item in this checklist
  to verify without deliberately injecting a mid-write failure. If you can:
  submit a multi-node job, confirm it, and (e.g. via a network interruption,
  or temporarily revoking the PAT partway through a large tree) force a
  partial failure after SOME items were created. Confirm: (a) the job
  reverts to `diff_ready` (not stuck in `writing`, not `failed`); (b)
  re-running `POST /jobs/:id/confirm` creates ONLY the remaining items —
  the already-created ones are not duplicated in ADO; (c) parent/child links
  for previously-created items are not re-PATCHed either. If you can't
  safely force a real mid-write failure against this org, at minimum confirm
  a full, uninterrupted confirm() still produces the same result as before
  (regression, not new-behavior verification).
- [ ] **Post-write validation.** `GET /jobs/:id/validate` (same
  `X-Ado-Org-Url`/`X-Ado-Pat` headers as confirm) reads back every work item
  this job created and compares its real `System.Title`/`System.Description`/
  parent link against the dry-run diff. After a normal, successful confirm,
  this should return `{valid: true, checkedCount: N, mismatches: []}` — if it
  reports any mismatch on an otherwise-clean write, that is a genuine finding
  (e.g. ADO silently truncating/coercing a field) worth filing, not a false
  positive to dismiss.

### If something breaks

This is expected to be the first real-world exercise of `RealAdoBackend`'s retry/
backoff, api-version fallback ladder (`7.1 -> 5.1 -> none`), and batch-size-200
chunking — none of which have been proven against a live server's actual error
responses (429 shapes, TLS quirks, field-name conventions that differ from this
repo's assumptions). Treat a failure here as a real bug report, not a configuration
mistake, and file it against `mcp-ado-server/src/backends/realAdo.ts` with the exact
request/response that failed.
