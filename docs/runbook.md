# Runbook

## Recovering a stuck pipeline job (BullMQ)

**Never manually mutate BullMQ's Redis keys directly** (e.g. `redis-cli LREM bull:req2ado-pipeline:active 0 <job-id>`) to clear a job stuck in `running`. This bypasses BullMQ's own bookkeeping and desyncs the worker's in-memory lock-renewal loop from Redis state — confirmed live (throwaway harness, no live app needed): a manual `LREM` on a job's active-list entry, while the owning worker is still actively renewing its lock, produces exactly the "could not renew lock" / "Missing lock for job N" errors observed in a real incident, repeating on every renewal attempt afterward.

**Correct recovery options, in order of preference:**
1. **Wait it out.** If the pipeline-worker process is healthy and the job is genuinely still progressing, let it finish naturally.
2. **Restart the owning pipeline-worker process/container.** BullMQ's own stalled-job detection (`stalledInterval`, now 60s — see `pipeline-worker.main.ts`) reclaims the job cleanly once the lock actually lapses; no manual Redis surgery needed. Note: this DOES kill the in-flight job (any long-running LLM calls are lost) — only do this if the job is actually wedged, not merely slow. Check `GET /jobs` for `running`/`pending` jobs before restarting `pipeline-worker` or `mcp-ado-server` for any other reason (a deploy, a config change) — this has caused unintended job kills before.
3. **If the job must be force-cleared while still locked**, use the BullMQ `Queue` API, not raw redis-cli: `const job = await queue.getJob(id); await job.remove()` — note this itself throws `Job could not be removed because it is locked by another worker` if the lock is still live (confirmed live), which is BullMQ correctly protecting against the exact corruption manual `LREM` causes. If it throws, fall back to option 2.
4. As a last resort, mark the Postgres `Job` row `status='failed'` directly with an audit-trail note explaining the manual intervention (do this only after the BullMQ-side state is already clean via options 1-3, not as a substitute for them).

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
- [ ] **Classification tags.** Every created item should have `System.Tags`
  populated with its SURVEY-mode taxonomy tags (e.g. `functional; safety`)
  when the source doc was processed in SURVEY mode with tags present.
  `Microsoft.VSTS.CMMI.RequirementType` is deliberately NOT written (picklist
  risk — see `JobsService.confirm`'s field-assembly comment).
- [ ] **Customer ID non-type-gated fallback.** For a work-item type with NO
  candidate Customer ID field (Epic/Feature per the CR7 round above),
  `System.Tags` should now contain a `CustomerId:<value>` entry instead of
  silently dropping it — confirm this on an Epic/Feature node from a job
  with `customerId` set.
- [ ] **Configurable Customer ID candidates.** If your org uses a Customer ID
  field name not in the default 3-name list, set
  `CUSTOMER_ID_FIELD_CANDIDATES` (comma-separated, see `.env.template`) and
  confirm it resolves instead of falling back to the `System.Tags` tag above.
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
