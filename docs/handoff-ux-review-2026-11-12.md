# Handoff: daily-user UX review findings and the next plan (2026-11-12)

Written for the next session (engineer or Claude) that will plan and build the fixes below. Nothing here is committed. Source code and
`DESIGN.md` are authoritative; this file is a routing aid and a findings register.

A design-practice research file is being written alongside this one by a separate agent:
`docs/ux-research-daily-review-flow.md` (may not exist yet; read it before planning the visual and motion work).

## 1. Where the work stands

All changes are **uncommitted** in the working tree (`frontend/src`, `DESIGN.md`, `docs/user-guide.md`, one UI-only string in
`orchestrator/src/modules/pipeline/document-profile.ts` plus its tests). No Git approval has been given. Commit text rules: no work-item id,
no AI attribution, never the proxy brand name.

Done in this pass (details in `DESIGN.md` §11.2.5, §11.3.5 and the §18 ledger):
- Phase-centred job page: a phase rail beside one phase view, on the running screen **and** on every state after the run stops (Review is the
  phase in view for Diff ready; "Back to review" returns from another phase). One live region.
- New job step 2 rebalanced: decision path left, sticky "This run" rail right.
- Consistency pass: soft status chips, one date formatter, sentence case, glossary (Azure DevOps / work item; "Write to Azure DevOps";
  "Confirm" retired), page titles, 404, Help page, 24 px targets in the tree.
- Guards (zero-tolerance tests in `frontend/src/design/`): `signalColour`, `terminology`, `scale`.
- Bug fixed: the optional AI summary on step 3 vanished after about a minute because its 90 s give-up timer was never cleared when the
  result arrived (regression test in `NewJobWizard.test.tsx`).

Gates at last run: `cd req2ado/frontend && npx tsc -b && npx vitest run && npx vite build` -> 173 files / 2,521 tests passing, clean.
Orchestrator `npx jest` last passed (100 suites / 2,417) before the final one-line copy change; re-run it.

Local stack: rebuild only with `bash scripts/rebuild-app-services.sh`; app at `http://localhost:4082` (health `/api/health`). A stale
browser bundle can hide a rebuild: confirm the loaded script hash. `LIVE_PROGRESS=true` is set in the git-ignored `req2ado/.env` (user
approved) so the live run panel works locally; never print `.env` values.

Plan file with full history: `/Users/EdenZviSchwartz/.claude/plans/soft-launching-lynx.md` (PROGRESS sections at the top; the release plan
is parked at the bottom and is a separate topic).

## 2. How the findings were produced

Two Opus "daily user" reviews (a senior engineer who inserts a requirements tree from a new customer file every day, strict and annoyed),
using the signed-in Playwright browser, read-only with respect to Azure DevOps. Review A covered the BASELINE flow and finished jobs.
Review B covered SURVEY (most users use SURVEY). **Neither watched a live SURVEY run**: Review B's new job reused cached drafts and reached
Diff ready in about 6 s. **Nothing below has been independently verified by the main session**; treat each as a claim to reproduce first.

Test jobs created or kept (all unwritten, nothing was written to Azure DevOps): `129e4ca3`, `a93f1512`, `84bc265e`, `47420ba0`,
`07b2a3eb`, `4270e8be`, `de71b87f`, `b23e3d9b` (BASELINE, `mock_tv_remote.docx`), `c4f9a4da` (SURVEY, `mock_prd_flat.docx`). Ask the owner
before deleting. `107cb6a0` is a real written job (556 items): read-only. To exercise a live SURVEY run, upload a document that has not
been processed before (the server reuses saved overviews and drafts for a known file).

## 3. Findings register

Severity High/Med/Low; effort XS/S/M/L. "Where" says which package owns the fix. Items marked (server) need orchestrator/ingestion work,
which is outside the frontend-only scope used so far and needs explicit approval.

### 3.1 Write decision and committed state

| ID | Sev | Finding and evidence | Suggested fix | Effort | Where |
|---|---|---|---|---|---|
| W1 | High | A written job still reads as proposed. Job `107cb6a0` ("Written to Azure DevOps", "Written items (556)") still shows the destination chip "State: Proposed"; every row says "New"; no work-item IDs anywhere; "Needs review", "Fix in tree" and "0 of 433 reviewed" are still offered; Audit shows (0). Breaks DESIGN.md §0 item 3. | "Written" chip; work-item ID per row (mono); read-only "flagged at write time" view; Audit lists the writes. | M | frontend (+ check API returns ids/audit) |
| W2 | High | Write is enabled while "Fix before writing (1)" is open (job `129e4ca3`: 7 items without Customer ID, "0 of 7 reviewed"). The heading is advice, not a gate. What the confirm dialog says was NOT verified. | Check the confirm dialog first. Then disable Write or have it state the count ("7 unresolved"). Decide with the owner whether the gate is hard or soft. | S | frontend |
| W3 | Med | Write scrolls out of view once in the tree; header is not sticky. | Sticky action bar carrying the unresolved count next to Write. | S | frontend |
| W4 | Med | Keyboard: Write is tab stop 10 (before any warning or tree row), no skip link. At 390 px Reject and Write are the first thing, before any review content. | Skip link to the tree; Write later in tab order; mobile sticky bottom bar. | S | frontend |

### 3.2 Review efficiency (SURVEY-heavy)

| ID | Sev | Finding and evidence | Suggested fix | Effort | Where |
|---|---|---|---|---|---|
| R1 | High | "Weakest area" is often a lifecycle-metadata criterion ("Owner, approver, status, baseline, and change history… 10/100") under "Scored on wording only". It drags drafted items to about 40, pushes 16 of 17 into "Needs review", so the label means nothing. Job `c4f9a4da`; AirPro job: 556 items, 219 needs review, 19 clean, 318 in neither bucket. | Exclude lifecycle-metadata criteria from drafted-text scoring; choose the weakest area from wording criteria only. Needs a decision on the rubric. | S | (server) scoring |
| R2 | High | "Review in risk order" starts with unscored Epics/Features (Feature Synchronization, Epic, SW Safety, Connectors, then the first Requirement). Each shows "Low quality score… Decomposability 10/100" above "Features aren't scored". | Requirements first; drop the score banner from Epics and Features. | S | frontend |
| R3 | High | Item dialog buries the shall-statement: file, section, page, KB chips, weakest area, "source text is not stored" (contradicts "Check it against its source"), Edit, Parent, then the statement (about 380 px down). In Edit, Description is the fourth field. | Statement and source excerpt first, large; Description first in Edit; hide irrelevant KB hits ("Not relevant" red chip on every item) and criteria the item cannot satisfy. | M | frontend |
| R4 | Med | "Needs review · N" is a single toggle with no grouping and no review-time estimate. | Group by reason (needs author value / low score / possible duplicate / table-derived) with counts and "about N min to review". | M | frontend (+ server for reasons) |
| R5 | Low | Keyboard review: X ("Exclude and next") jumped to the first item instead of the next; no "n of N" counter; exit by Escape only. J/K/A/R/E/U and undo work (keep). | Advance to the next item; add a counter. | S | frontend |
| R6 | Med | Jargon: red "same tier" chip (unexplained), orange flag icons with no label, "criteria to review", icon-only Download/Validate/Resubmit, red Delete next to Refresh. | Plain labels or tooltips; Delete into an overflow menu. | S | frontend |
| R7 | Med | Titles truncated in the filtered tree ("Operat…") because chips eat the title while the desktop Status column stays empty; status shows on mobile only. | Status chips in the Status column; title flexes. | S | frontend |

### 3.3 Run waiting, estimates and failure

| ID | Sev | Finding and evidence | Suggested fix | Effort | Where |
|---|---|---|---|---|---|
| E1 | High | The estimate ignores document size: "11 min – 19 min, typically (n=50)" for an 8-block document that took about 3 min for real (`4270e8be`, 18:58 to 19:01) and 6 s when cached. Same card says "about 31% faster" on this model. | Scale by blocks/figures; say "seconds" when cached drafts will be reused. | S | (server) estimate + copy |
| E2 | High | A cache hit is invisible: "Reused a saved overview of this document" is log line 1 of 18, behind collapsed "Run details". Analyze still says "Inferring the work-item hierarchy…". Cannot tell whether anything was re-thought or KB changes were used. | Header line "Reused drafts from run X (3 h ago) · Re-run fresh". | S | frontend (+ server to expose it) |
| E3 | High | A failed run does not say why (job `b2690725`, AirPro): "The run failed", "No diff was produced… Check the audit trail"; cause at the end of a 97-line log, last line just "failed"; Jobs list shows a bare red "Failed" with 0 items; destination chip still "Proposed"; raw event names leak into the log (`parse`, `infer_hierarchy_start`). Dead air: log lines at 21:39, 21:45, 21:48 (one per 150-node chunk). | One-line cause and failed step at the top; Retry/"Resume from chunk 2"; per-node heartbeat ("node 37/150"); reason on hover in the Jobs list; plain-language log. | M | frontend + (server) |
| E4 | Med | Running screen contradicted itself: banner "Parsing complete" while the rail said "Dedup check · In progress"; the indeterminate bar drawn as a partly filled determinate bar. | Banner follows the rail; truly indeterminate bar. | S | frontend |
| E5 | Low | Run log noise: 17 identical "Checking for duplicates N of 17" lines at the same second. | Collapse repeats. | XS | frontend |
| E6 | Low | Console 404 on `/api/jobs/<id>/run-map` for finished jobs (the page polls it). Known and harmless but noisy. | Stop polling when the job is finished or the feature is off. | XS | frontend |

### 3.4 Jobs list and New job wizard

| ID | Sev | Finding and evidence | Suggested fix | Effort | Where |
|---|---|---|---|---|---|
| J1 | High | The list cannot answer "what is today's?": 72 rows, no paging, no grouping; "62 Awaiting review" is mostly stale Diff-ready jobs up to 14 days old; same-named files (`AirPro_tmp.docx` x7, `mock_prd_sensor.docx` x2) are indistinguishable (no job id, only "3 hours ago"); the card says "Awaiting review" while the status column says "Diff ready"; row actions only on hover. | Today/Yesterday/Older grouping; short mono job-id column (§0 rule 1); one word per state; "stale" labelling or archive. | M | frontend |
| J2 | Med | Step 2 defaults: BASELINE preselected though SURVEY is the team default; Area path empty though every recent job used `Customer Requirements`; the Area dropdown opens upward and covers Team Project; destination below the fold; nothing remembered. | Remember last mode and destination; fix dropdown placement; destination above the fold. | XS–S | frontend |
| J3 | Med | Step 1/2 copy contradicts results: "No headings found. Baseline groups the whole text under one Epic and one Feature" then BASELINE produced 3 Epics (including Epic-under-Epic) and 8 items; BASELINE card says "no completed runs yet" while many completed BASELINE jobs exist; re-uploading an already processed file gives no warning; "every row counts as its own block" for 5 tables yet 8 blocks. | Make the preview and ETA basis truthful; warn on re-upload of a known file. | S–M | frontend + (server) |
| J4 | Med | Step 3 ("Does this look right?"): the optional AI summary just restates structure and "Write it again" gives a longer copy; the "This run" rail disappears on step 3, next to Start; wording "1 Epics", "0 requirement statements" beside "11 Requirements". | Summarise requirement content (topics, counts of shall-statements) or cut it; keep the rail; fix the copy (UI string lives in `orchestrator/.../document-profile.ts`). | S | frontend + (server prompt/copy) |
| J5 | Low | At 390 px step 2's Continue is at about y=1500 with no sticky bar; the job page's yellow Write is the first thing, first item at y about 1050. No horizontal overflow. | Sticky action bar. | S | frontend |

### 3.5 Polish

| ID | Sev | Finding | Fix | Effort |
|---|---|---|---|---|
| P1 | Med | Destination "Iteration" pill is hatched/empty (intentional "unset" drawing, `DestinationBar` `hatchWhenUnset`) but both reviewers read it as a stuck loader; aria says "Iteration not set". | Show the words "Project default" (or "Not set"). | XS |
| P2 | Low | Blank loading states: job page empty canvas about 3 s; Knowledge base empty white card; "expires in 897 minutes". | Skeletons; "about 15 h". | XS–S |
| P3 | Low | Help has no search and does not mention the J/K/A/R/X shortcuts listed in Settings; Settings hides under the avatar as "Profile & connections". | Add shortcuts to Help; reconsider the entry point. | XS–S |
| P4 | Low | Breadcrumb "Jobs" link 31x20 px (under the 24 px floor); step-1 stepper says "Configure & review" while DESIGN.md says "Configure". | Hit area; align copy or spec. | XS |

## 4. What works and must not be touched

- Signal yellow only on "Write to Azure DevOps" (guarded by `design/signalColour.test.ts`); the lock line "Nothing has been written to Azure
  DevOps…" present on wizard and job pages.
- Warning grouping "Fix before writing / Review / For your information" with "Fix in tree" producing a filtered tree plus "Hide reviewed" /
  "Mark all reviewed".
- The item dialog's keyboard review (J/K next/previous, A/R mark, E edit, U undo) and Customer ID in the edit form.
- The tree is a real ARIA tree with roving tabindex; mono index numbers; Epic/Feature/Requirement badges.
- "Needs author input" placeholders instead of invented values; honest step-1 document map; BASELINE is fast (about 10 s).
- The optional, non-blocking AI summary behaviour (now stays on screen once shown).

## 5. Not verified (do these early in the next session)

- A live SURVEY run on a never-processed document: rail, headline, percent, clock, "Now" card, outline, clicking other phases and "Back to
  live", contradictions between rail, banner and bar; at 390 px too.
- The Write confirm dialog and whether it enforces the Fix group (agents were not allowed to click Write; neither should you in a real
  project without the owner's explicit go-ahead).
- Real Tab-key focus rings (tab order was counted from the DOM); keyboard use of the phase rail on a finished job; the Audit tab with real
  entries; the batch ("New batch") flow; dark mode; screen-reader behaviour; Parse/Analyze views of a finished job in a browser.

## 6. Out-of-scope findings still open (report only)

- Medium/Low, XS–S: Knowledge Base stores the last SharePoint folder URL under one global localStorage key (`req2ado-kb-browse-url`), not per
  user and not cleared on logout. Only the URL leaks (access is decided by the token).
- Low: the Knowledge Base page shows the full SharePoint sharing link with its token; `/api/kb/documents` carries an identity claim as `userId`
  in the query string.
- Content (ingestion): the top risk-first SURVEY item on one fixture was the document's own mock-data disclaimer (quality 5/100).
- About 50 untracked screenshots sit in the workspace root; check `.gitignore` before any commit (workspace root is the umbrella repo).

## 7. Decisions needed from the product owner before building

1. Is the Write gate **hard** (disabled while Fix items are open) or **soft** (count shown, confirm dialog warns)? (W2)
2. May the next phase change the orchestrator/ingestion (rubric criteria R1, estimate E1, cache signal E2/E3, grouping R4)? Frontend-only
   work cannot fix R1/E1 and only half of E2/E3/R4.
3. Which "Needs review" semantics: confidence-based triage with "clean" counted, or the current union? (R1/R4)
4. Keep or cut the step-3 AI summary? (J4)
5. Stale Diff-ready jobs: archive automatically after N days, or only label them? (J1)
6. Spec reversal sign-off: `DESIGN.md` §11.3 now prescribes the two-column phase page for every job state.
7. Git: propose commit groups (spec, bug fixes, step 2, phase page and Diff Ready rail, consistency/glossary/guards); each needs separate approval.

## 8. Suggested build order (frontend-first, then server with approval)

1. **Write decision:** W1, W2 (after checking the dialog), W3, W4, P1. All frontend; fixes the largest trust gap.
2. **Review efficiency:** R2, R3, R5, R6, R7. Frontend; biggest daily time saver for SURVEY users.
3. **Jobs list and failure:** J1, E3 (frontend part: cause at top, Retry, hover reason), J2, E4, E5, E6.
4. **Wizard truth:** J3, J4 (copy), J5, P2–P4.
5. **Server (approval needed):** R1 scoring criteria, E1 size-aware/cache-aware estimate, E2 reuse signal, R4 reasons, E3 heartbeat and resume.
6. **Visual and motion language:** apply `docs/ux-research-daily-review-flow.md` once it lands (tokens, durations, specific micro-interactions),
   behind `prefers-reduced-motion`.

Every slice: tests first, `tsc -b`, full vitest, `vite build`, ratchets, live check at 1440x900 and 390x844 after a stack rebuild, and a
`DESIGN.md` §18 row. Independent Opus review after each group; give reviewers the signed-in Playwright access explicitly (a reviewer without
it produced no findings last time), and tell them not to touch `.env`, cookies or tokens.

## 9. Design research (read `ux-research-daily-review-flow.md` before planning the visual and motion work)

Written by a separate Opus agent from primary sources (about 400 lines; it marks what it could not support). Headline recommendations,
mapped to the findings above. Treat them as proposals; several depend on the decisions in section 7.

- **Review groups (R1, R4):** replace the single "Needs review" label with four groups with written rules: Fix before writing (blocks
  Write), Check, Clean, Structure (unscored, last). Clean items approved in one counted action via the existing `BulkApproveDialog`; no bulk
  approval inside Fix before writing. Progress as "7 / 12 that need you"; an item counts as reviewed only after a decision; J/K moves within
  the group (R5).
- **Item dialog order (R3):** decision bar, requirement text, source beside it with the matching sentence highlighted, then one "Why this
  verdict" panel (scores, KB references, duplicates).
- **Long runs (E1-E3, E5):** stage plus "section N of M" plus elapsed; show a time range only when it comes from recorded runs of similar
  size, otherwise "no estimate yet"; cache reuse shown as "Reused N sections from <date>"; pausable activity feed (WCAG 2.2.2); a "since
  you left" line on return. Failed run card: stage, section, cause type, what was kept, retry options; cause also on the Jobs list.
- **Write (W1-W4):** a fixed bottom bar carrying the blocker count; Write visible but disabled with the reason in text and a jump to the
  first blocker; after the tree in keyboard and mobile order; the confirmation gives counts by type and the destination, button "Write 38
  items"; after writing, a separate Written / Partially written state, Azure DevOps ids on rows, review controls removed. **This leans to a
  hard gate: confirm with the owner (decision 1).**
- **Reading ergonomics:** reading-text style 15 px / 24 px leading, lines capped at 68 characters (58 side by side), never justified; step 3
  becomes three short facts plus a collapsed outline (J4); add a Playwright check for WCAG 1.4.12 text spacing (fixed-height `DiffTree`
  rows are the likely failure).
- **Motion:** 90-240 ms for work, 320 ms only for milestones, existing duration/easing tokens suffice (no new curves), 8 specific
  micro-interactions each with a reduced-motion fallback, and a "do not animate" list; skeletons only after a 300 ms delay (P2).
- **Jobs list (J1):** "Needs you" group first, then by day, short job ids, sticky filters, 3 built-in saved views, a stale/superseded marker.
- **New tokens proposed:** reading-text size, line-width caps, proposed/written/partial/failed colours, named motion aliases, the 300 ms
  placeholder delay. No new dependencies.
- **Unsupported by primary sources (do not cite as fact):** review-time estimates or ideal review size, Material 3 motion values,
  Vercel/Stripe deploy patterns, saved views as beneficial, FLIP/stagger improving task performance, "disabled button with a visible reason"
  (the agent's own inference). Line-length findings come from abstracts, not full text.
- **Extra product-owner questions raised** (9 in the research file, beyond section 7): exact blocking rules, hard block versus "write the
  rest", whether bulk approve is acceptable for audit, and stale-diff rules.

## 10. Decisions made by the product owner (2026-11-12, end of session)

1. **Write gate: hard block.** While "Fix before writing" items are open, Write stays visible but disabled, with the reason in text and a
   jump to the first blocker (W2). Still verify what the existing confirm dialog does today before changing it.
2. **Server scope: yes, with a plan the owner approves first.** The next plan may change the orchestrator and ingestion (R1 scoring criteria,
   E1 size-aware estimate, E2 reuse signal, R4 review reasons, E3 heartbeat and failure cause). List every server change in the plan and wait
   for approval before editing any of it.
3. **"Needs review": four groups** (Fix before writing, Check, Clean, Structure) with a written rule for each; Clean approved in one counted
   action; no bulk approval inside Fix before writing (R1, R4).
4. **Step-3 AI summary: rewrite it.** Summarise requirement content (topics, counts of shall-statements), not structure; keep the "This run"
   rail on step 3 (J4).

Still open, default if the owner does not say: stale Diff-ready jobs are **labelled only** (grouped by day, marked stale), not archived or
deleted (J1); Git commit groups still need approval (decision 7); spec reversal sign-off (decision 6); the nine product-owner questions at the
end of `ux-research-daily-review-flow.md` (blocking rules in detail, bulk-approve and audit, stale-diff rules).

## 11. Reproduction and live SURVEY run (2026-11-13, main session)

Signed-in Playwright, read-only with respect to Azure DevOps. The Write dialog was opened and cancelled; nothing was written. Two local test jobs were created from a copy of `mock_prd_flat.docx` with one changed paragraph: `e3a64c76` (cache miss) and `cc5dccfc` (same file again, cache hit). Both are unwritten Diff ready jobs; ask the owner before deleting them.

### Confirmed live
- **W2:** Write is enabled with "Fix before writing (1)" open. The confirm dialog says "1 warning to fix and 1 to check are still open. You can still write." Its only gate is an "I understand" checkbox. The server's `POST /jobs/:id/confirm` checks only job status and that there is work to write.
- **W1:** the written job `107cb6a0` shows "Written to Azure DevOps" next to "State: Proposed", "Fix in tree" and "0 of 433 reviewed". The job API has no Azure DevOps ids (only `writtenLocalIds`).
- **W4 / J5 at 390 px:** Write is at y=138 and comes before the tree (y=882) in DOM order. No horizontal overflow.
- **R1:** 9 of 11 Requirements on `c4f9a4da` have "Owner, approver, status, baseline, and change history…" (10/100) as weakest area.
- **R2, R3:** risk order opens on a Feature scored 10/100 "Decomposability"; in the dialog the requirement text starts about 440 px down.
- **E1:** `GET /jobs/estimate?mode=survey` returns the same 15 min (11-19) for 8, 50 and 200 blocks. Cause: `SURVEY_MIN_MINUTES = 15` at `eta.service.ts:437`. The fresh run of an 8-block file took about 5 minutes against the displayed "11 min - 19 min".
- **E2:** the cached re-run reached Diff ready within seconds. Nothing on screen says drafts were reused. The only "reused" text is "0 reused", which counts Azure DevOps items.
- **E3:** the failure cause exists only as an audit line ("Pipeline failed: terminated (UND_ERR_SOCKET: other side closed)"); the job API has no failure field.
- **J1:** 76 jobs, 64 Diff ready, aged 0-95 days.
- **J2:** after a finished SURVEY job the wizard is back on BASELINE with no project or area path.
- **J3:** the BASELINE card says "no completed runs yet"; re-uploading a processed file shows no warning.
- **J4:** step 3 has no "This run" rail; it reads "1 Epics" and "0 requirement statements" beside "11 Requirements".

### New findings from the live run
| ID | Sev | Finding | Effort | Where |
|---|---|---|---|---|
| E4a | High | Banner and rail disagree for the whole Score stage: headline "Resolving trace links -- 17 of 17 blocks" at 89% while the rail says "Score · In progress" and Dedup check is still pending. The percentage stays at 89% through Score and Dedup, then jumps to 100%. | S | frontend (banner follows the rail; percent from stage denominators) |
| E6a | Medium | The `/run-map` 404 is polled about every 15 s **during a live run** (7 console errors in about 100 s), not only on finished jobs. | XS | frontend |
| E3a | High | Dead air in a short run: Parse showed 4 log lines for about 56 s; Score showed one line ("Checking requirement wording") for 80 s or more. The headline said "Waiting for the model's next answer." with "Estimating time left…". | M | frontend + server (S8) |
| T1 | Low | 10 tree "Exclude" checkboxes measure 15x15 px at 390 px. DESIGN.md §5 requires 24x24 targets; whether a hit-area expander covers it is not verified. | XS | frontend (needs a pointer-hit test) |
| S11 | Medium | `GET /jobs/107cb6a0` is 1.67 MB with no `content-encoding`; the list is 20 KB. A proxy in front could compress; not checked. | S | server |

### Still not verified
- Run view at 390 px while a run is live (the run finished before the resize; only the Diff ready page was checked at 390 px).
- Tab-key focus rings, dark mode, screen readers, the batch flow, the Audit tab entries.
- Whether "resume from chunk" is feasible in the pipeline; whether a "run fresh" flag exists.
