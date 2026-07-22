# Handoff — Point 3: On-prem environment hardening

Source: `docs/handoff.md`'s code-review §3 ("Potential bugs in an on-prem
environment"). All 5 bounded fixes from that section are done; the sixth
finding (no IWA/NTLM/Kerberos auth support) is a genuinely large, separate
undertaking — noted below, not attempted here.

## What changed

1. **Stale error message in `resolveApiVersion`** — the thrown error still
   said `"ADO connectionData validation failed"` even after this session's
   earlier fix moved the probe to `{project}/_apis/wit/fields`. Now says
   `"ADO wit/fields api-version probe failed"`, matching what it actually
   probes. (`mcp-ado-server/src/backends/realAdo.ts`)

2. **API-version ladder docs reconciled** — `docs/architecture.md` documented
   `7.1 → 5.1 → none`, missing the `7.0` rung the earlier real-on-prem-server
   auth fix (this session, `4436da2`) deliberately added. Updated every
   occurrence to `7.1 → 7.0 → 5.1 → none` with the rationale note.

3. **`retryWithBackoff` now retries genuine network failures, and honors
   `Retry-After`** — previously `isRetryable` required a numeric
   `error.response.status`; a transient network failure (ECONNRESET,
   ETIMEDOUT, ECONNREFUSED, DNS errors — no HTTP response received at all)
   was never retried, which is far more likely against a real on-prem
   network than a stable cloud endpoint. Also: a 429's own `Retry-After`
   header (seconds or HTTP-date) is now honored instead of blind exponential
   backoff when present. (`mcp-ado-server/src/backends/retryWithBackoff.ts`)

4. **Real ADO bulk-read added, `batchSize`/`concurrency` config now actually
   used** — `getWorkItem` had no MCP tool wired to it at all (dead code, no
   caller anywhere); rather than building a speculative one-off batch API
   for it, added `getWorkItemsBatch(ids)` to `AdoBackend` (both `MockAdoBackend`
   and `RealAdoBackend`), chunked at `config.batchSize` (real ADO's
   workitems-by-id endpoint caps at 200) and dispatched with bounded
   concurrency (`config.concurrency`), plus a new `ado_get_work_items_batch`
   MCP tool and the matching `McpClient.getWorkItemsBatch` method. This is a
   direct prerequisite for Point 8's backfill work (querying an area path's
   existing items in bulk), not speculative — it just has no caller yet in
   this worktree.

5. **`System.State` is now configurable, not hardcoded `'Proposed'`** — new
   `ADO_INITIAL_STATE` env var (`orchestrator/src/config/config.schema.ts`,
   default `'Proposed'` — byte-identical behavior for anyone who doesn't set
   it), threaded through `JobsService`'s constructor and used in place of the
   literal in the create-fields object. An on-prem process template whose
   initial workflow state isn't literally `"Proposed"` no longer fails every
   create.

## Deliberately not attempted

- **No IWA/NTLM/Kerberos auth support** — `RealAdoBackend` only does
  PAT-as-HTTP-Basic. Adding real Windows-integrated auth would mean a
  different HTTP stack (e.g. `httpntlm`/`node-expose-sspi`) and genuinely
  needs a real on-prem AD-backed TFS collection to test against, which
  isn't available. Flagging as a real gap, not building blind.
- **Real work-item *batch write* API** — task 4 above added a batch *read*
  (serves Point 8). Batching *creates* wasn't attempted: `confirm()`'s
  sequential create loop has a real per-node dependency (a child's
  `linkParentChild` needs its parent's real ADO id first), and that's
  Point 5's `confirm()`-concurrency task, not this one — kept scoped.

## Verification

- `mcp-ado-server`: `npx vitest run` — 68/68 passing (was 58 before this
  point; +10 new tests: batch-read empty/chunking/concurrency-bound
  coverage, retry-on-network-error, Retry-After honored/absent, tool
  registration).
- `orchestrator`: `npx jest` — 121/121 passing (was 120; +1 new test:
  configured initial state honored).
- Not re-verified against the live ADO org this round — every change here
  is either a pure logic fix (retry/version-message) or additive
  config/API surface with no existing call site altering current write
  behavior (default `ADO_INITIAL_STATE=Proposed` preserves exact prior
  behavior). A future live confirm-write round would still be worth doing
  once `ADO_INITIAL_STATE` is actually overridden for a real custom process.
