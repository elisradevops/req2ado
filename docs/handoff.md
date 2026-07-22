# Handoff — req2ado (this worktree)

**Scope note:** this worktree (`.claude/worktrees/req2ado-phase10`, branch
`worktree-req2ado-phase10`) is a separate, divergent checkout from the
`elisradevops/req2ado` repo at `/Users/EdenZviSchwartz/Repos/Projects/elisradevops/req2ado`
(branch `main`, has the GitHub remote, further along with Phase 4 trace-links
and beyond). The two share an early common history but have not been merged
back into each other. Nothing in this doc describes that other repo — see its
own `docs/handoff-frontend-rebuild.md` for that lineage. This doc is this
worktree's own record.

## What's done here

**Phase 10 — SURVEY mode + embedding-dedup wiring**
(`docs/superpowers/plans/2026-07-06-phase10-survey-and-dedup-wiring.md`) is
**complete** — all 10 tasks have a matching commit (the plan file's own
checkboxes were never ticked, that's cosmetic, not a status signal):

1. `OrchestratorLlmClient.infer_hierarchy` + batched whole-document
   requirement generation — `9a652d1`
2. Folded into `build_survey_tree`, per-node title-distillation LLM call
   dropped, real `fidelity_hash` for SURVEY nodes — `881edb3`
3. Ingestion config module + `mode` branch in `/level` — `e55db99`
4. `mode=baseline|survey` threaded end-to-end, Upload → ingestion — `7d63909`
5. SURVEY golden E2E scenario — `9c24ed6`
6. `POST /dedup/check` + `POST /dedup/upsert` — `76bc7f9`
7. Embedding dedup check wired into the dry-run diff, fail-open — `705ecee`
8. Real creates upserted into the dedup vector store, `dedup_skip`
   re-parenting guarded — `2455a6f`
9. Dedup golden E2E scenario (near-duplicate → `dedup_skip`) — `9b47804`
10. Frontend renders `dedup_skip` as its own visual state — `03214b6`

Whole-branch review findings addressed in `d494a08` (SURVEY tag tolerance,
golden-e2e vector store isolation).

**Post-Phase-10 hardening/hygiene**, in order:
- Leveling edge cases: headingless-document grouping rule (`9804b44`),
  context-dependent leveling resolution + known ICD sub-requirement gap
  documented (`9a3d966`), mock ICD/TV-Remote/headingless golden fixtures
  (`661a678`)
- Login simplified to the DocGen pattern — dropped JWT session, Azure AD,
  `User` table (`125f0ff`)
- PDF figure/drawing placeholder extraction (`2d04b56`)
- SURVEY's full 11-tag taxonomy proven, `infer_hierarchy` tolerates a
  non-array response (`ec01ed6`)
- LLM call timeouts raised, golden-e2e swapped to a capable local model
  (`7259462`)
- `docs/runbook.md` (CR7: real-ADO-write verification steps) added (`212a8cc`)
- CORS enabled for local frontend dev (`39f1d24`)
- Auth login walks the real api-version ladder against a real on-prem ADO
  Server 2022.1, found via manual verification (`4436da2`)

**This session — CR7 runbook executed against a real ADO org**
(`https://dev.azure.com/elisradevops/`, project `elisradevops-project`),
docker-compose with `ADO_BACKEND=real`. All 5 runbook steps passed: field
discovery, dry-run diff, a real write, and the idempotency re-run. Six real
bugs found and fixed along the way (`7e3508b`), verification debris cleaned
up (`5f7fa05`) — see `docs/runbook.md` for full details on each bug:

1. `discoverFields` read the wrong JSON key (ADO's real list responses are
   `{count, value: [...]}`, not `{fields: [...]}`)
2. `resolveApiVersion` swallowed 401s instead of failing fast (same bug class
   as the login-path fix in `4436da2`, left unfixed on the write path)
3. **Root cause of the write failure:** `resolveApiVersion` probed org-level
   `_apis/connectionData`, which falsely rejected 7.1/7.0/5.1 on this org —
   the real `wit/workitems` endpoint accepts 7.1 fine and, unlike
   connectionData, hard-requires an explicit version. Fixed to probe
   `{project}/_apis/wit/fields` instead, the same endpoint family every
   write call actually uses.
4. Orchestrator's `McpClient.parseToolTextResult` ignored MCP's `isError`
   flag, masking real tool errors as an opaque `SyntaxError`
5. `JobsService.confirm()` had no failure handling — a failed write left the
   job stuck in `'writing'` forever; now reverts to `diff_ready` (safe
   retry, nothing written yet) or `failed` (partial write)
6. Write-path tool handlers surfaced only axios's generic status-code
   message instead of ADO's real error body — added `adoErrorMessage()`

`docs/runbook.md`'s status is now **VERIFIED** (was UNVERIFIED going into
this session).

## Multi-node real-ADO write verification (CR7 follow-up, this session)

Closed the two gaps CR7's single-node round left open — see
`docs/runbook.md`'s "Multi-node write verification" section for full detail:
- **`linkParentChild` proven live** — a real Feature→Requirement parent/child
  tree was created and the `System.LinkTypes.Hierarchy-Reverse` relation
  verified in ADO. Previously only unit-tested against mocked HTTP.
- **Customer ID field population proven live, better than expected** — this
  project's `Requirement` type has `Custom.CustomerRequirementId` (missed
  earlier since only `Epic` was checked); a real create populated it
  correctly. `Feature`/`Epic` still lack any candidate field, so that no-op
  fallback path is exercised too, on the same job's parent node.
- Idempotency re-run holds for a tree, not just a single node.

No code changes were needed — both gaps closed by verification alone, no new
bugs found this round.

## What's next

No open plan file in this worktree beyond Phase 10 (complete) and CR7
(complete, including its multi-node follow-up). Candidates for a next round,
not yet scoped as a plan:
- This checkout has no Phase 4 (trace-links) work at all — if that's wanted
  here, it would need porting from the other `req2ado` repo's `main`
  (commits `d25b6f8`→`689e95d`), not reimplementing from scratch.
- SharePoint/Graph token in `.env` was exposed in a chat session this round
  and should be rotated (flagged mid-session, not yet confirmed done).
