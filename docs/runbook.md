# Runbook

## Real ADO Write — Verification Steps (CR7, gated on production access)

**Status: UNVERIFIED.** Every existing test in this repo exercises `mcp-ado-server`'s
`RealAdoBackend` (`mcp-ado-server/src/backends/realAdo.ts`) only against mocked HTTP
(`vi.spyOn`) or against `MockAdoBackend` (SQLite/JSON). No work item has ever been
created against a live Azure DevOps / TFS server from this codebase. This cannot be
run inside this repo's sandboxed environment — it requires network access to a real
on-prem ADO/TFS instance and a scratch project the operator is willing to write test
data into. This is a manual runbook for whoever has that access, not a script that
runs itself.

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
   curl -s -X POST http://localhost:4100/mcp \
     -H "Authorization: Bearer <a-bearer-you-choose>" \
     -H "Content-Type: application/json" \
     -H "X-Ado-Org-Url: https://<your-tfs-host>/tfs/<Collection>" \
     -H "X-Ado-Pat: <your-real-PAT>" \
     -d '{"tool": "ado_discover_fields", "args": {"workItemType": "Epic"}}'
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

### If something breaks

This is expected to be the first real-world exercise of `RealAdoBackend`'s retry/
backoff, api-version fallback ladder (`7.1 -> 5.1 -> none`), and batch-size-200
chunking — none of which have been proven against a live server's actual error
responses (429 shapes, TLS quirks, field-name conventions that differ from this
repo's assumptions). Treat a failure here as a real bug report, not a configuration
mistake, and file it against `mcp-ado-server/src/backends/realAdo.ts` with the exact
request/response that failed.
