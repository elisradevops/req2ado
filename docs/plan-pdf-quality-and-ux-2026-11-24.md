# Plan: PDF result quality and the wizard / running-job UX (2026-11-24)

Status: **for the owner's approval. No product code has changed.** The only additions are a test fixture builder that makes
synthetic look-alikes of a customer specification PDF (`ingestion/tests/fixtures/build_spec_pdf_fixture.py`) and screenshots of the
local app.

The owner's two PDFs were not used, read or uploaded. Every failure below was reproduced on synthetic files built to the same shape.
The owner confirms on the real files by reporting counts and structure only (see "Measurement").

## 1. What the owner reported

1. CSV exports work (keep them as they are).
2. In two PDFs, the table of contents became a Feature.
3. The PDF item tree is wrong: requirements are merged into one item or garbled, and cover-page confidentiality text became items.
4. The wizard is bloated. BASELINE's "Does this look right?" does not explain the structure. SURVEY shows three cards for one
   subject.
5. The running-job screen looks static or looks like it is looping, and the user waits without being told why.

## 2. The short answer

- **It is not a 0.3.30 regression.** The loader and structure code is identical to 0.3.29: `git diff ingestion-v0.3.29 HEAD` over
  the loaders, `tree_builder`, `id_hierarchy`, `depth`, `numbering`, `autodetect`, `baseline_structure`, `id_tree_builder`,
  `hierarchy_rules` and `root_regrouping` is empty. These are long-standing PDF structure faults. The Study, added in 0.3.30, never
  reached the structure step.
- **The Study already understands the file.** On the synthetic spec it reported "How it states requirements: Numbered REQ statements
  using 'shall'". In the same run, the structure step merged every REQ of a section into one item. Nothing in the structure step
  reads what the Study learned. That is the design gap the owner named.
- **The rules pre-study cannot help a PDF as built.** For documents it learns only "label" prefixes ("Feature: …") and heading-depth
  types. A normal spec has neither, so it ends with "Nothing the model could verify" after about 95 s, every time.

## 3. Results quality: each failure, its cause, the fix

Fixture variants (each shape alone, plus `all_together`): `cover`, `header_footer`, `revision_history`, `toc_loose`, `toc_tight`,
`abbreviations`, `plain`, `no_id`, `tight_requirements`, `tight_requirements_no_id`.

Counts below are from the loader plus BASELINE and SURVEY, with the SURVEY model replaced by the structure-contract fakes. SURVEY's
item count is fixed by structure code, not the model.

| # | Failure (variant) | Confirmed cause | Proposed fix |
|---|---|---|---|
| Q1 | **Table of contents copied as a second outline** (`toc_loose`): 7 extra Features/Requirements titled "Introduction ......", in both modes | Each TOC line is a paragraph that starts with a number, so `depth.py` gives it a depth. `tree_builder._split_into_branches` and `autodetect.classify_numbering_branch` then build it like a real section | The document layout (§4) marks the TOC as front matter. A loader guard also gives no depth to a line that ends in dot leaders plus a page number |
| Q2 | **Table of contents as one item** (`toc_tight`) | `pdf_loader._lines_to_paragraphs` merges tightly set TOC lines into one paragraph, which takes depth 1 from its first number | Same as Q1 |
| Q3 | **Cover page becomes items** (`cover`): the confidentiality notice sits inside a "Power Distribution Unit Specification" item. SURVEY makes the notice its own Requirement | The PDF loader never produces a TITLE block, so the large cover title is read as a heading. The existing front-matter folding (`tree_builder`, before the first heading) therefore never runs | The layout marks the cover and notice as front matter. A loader rule reads a title-size line before the first numbered section as the title |
| Q4 | **Revision history and abbreviations become items** (`revision_history`, `abbreviations`). In SURVEY, the "Abbreviations" Feature also took section 3's requirements | Unnumbered headings at size rank 1 open a node and their table folds into it | The layout marks them as front matter. They are listed once in the wizard as "left out", never built as items |
| Q5 | **Running header and footer text inside items** (`header_footer`). SURVEY turns each leaked line into its own Requirement ("garbage") | Two-line headers and footers: only each page's first and last line are removal candidates, so the inner line ("PDU-SPEC-0042 Rev 2.0", "Acme Proprietary - Do not distribute") survives on every page | Repeated-margin detection over every line in the top and bottom margins, not just the first and last. The layout also confirms it |
| Q6 | **BASELINE merges requirements** (`plain`, a clean file): each section with "REQ-001: …" paragraphs becomes one Requirement holding them all | The "REQ-001:" prefix matches the label-cell pattern, so `id_hierarchy.is_standalone_statement` is false and the statement split skips them. Without the prefix (`no_id`) BASELINE splits correctly: 7 of 7 requirements | Cut requirements at the boundaries the layout states (requirement IDs, numbered "shall" paragraphs). The split treats an ID prefix as the start of a requirement, not as a label |
| Q7 | **SURVEY loses headings and merges requirements** (`plain`, `no_id`): of 7 numbered headings, only "Power Requirements" becomes an item, holding REQ-001 to REQ-005. The other headings vanish, and their text falls to the residual path with no parent | The heading-ID detector (`rows_from_id_headings`, D2) was built for documents whose requirement is the heading ("1.1.2 The unit shall …"). It claims every numbered heading but builds a node only for a heading with 2 or more numbered children, or "shall" in its own text. Every other heading is claimed and dropped | D2 builds every claimed heading as a section node. The requirement paragraphs in its span are split by the same rule as BASELINE (Q6), so both modes give the same items (the existing structure contract, extended to PDFs) |
| Q8 | **Requirements merged by spacing** (`tight_requirements_no_id`) | `_lines_to_paragraphs` joins tightly set paragraphs. There is no break at a line that starts a requirement ID or a new "shall" sentence | Paragraph break at a requirement-ID start, and hyphenation repair |
| Q9 | **"How this file is read" cannot verify a PDF** | Document rules hold only labels and depth types. Labels must cover at least 50% of headings, and depth comes from font-size rank. It learns nothing about front matter, sections or boundaries. An empty answer is never stored, so it re-runs | The pre-study learns the document layout (§4). A layout with no labels is a real, stored answer |

**Gibberish not yet reproduced:** two-column pages (same-row text merged), watermarks and OCR pages are known loader limits. They are
not in the fixtures yet; the owner's counts (§7) say whether they matter.

## 4. The structural fix: a document layout used by the structure step

The owner's expectation, "study the file first to see the structure", becomes one artifact, the **document layout**. It is learned
before structure and used by it. (The name "document map" is already used for two display-only outlines, so it is not reused.)

**What it holds**
- **Front matter, by block:** cover, notice, revision history, contents, abbreviations, repeated header or footer, each with its
  pages.
- **Where the requirement sections start and end.**
- **The numbering scheme:** "1.2.3" headings, and "REQ-nnn" or "SRS-nn" requirement IDs.
- **How one requirement is delimited:** an ID at the start, a numbered "shall" paragraph, or a list item.

**How it is learned (grounded: the model never writes text)**
1. **Code proposes candidates:** TOC lines (dot leaders plus a page number), text before the first numbered section, tables whose
   header reads like a revision or abbreviations table, and text repeated in page margins.
2. **The model confirms or corrects them by block id only,** in the existing pre-study call for documents (3 votes, majority kept).
3. **Code checks the answer against the whole file:**
   - every id exists and every range is ordered;
   - the numbering pattern matches the blocks it claims;
   - no block holding a requirement ID or "shall" is marked front matter;
   - otherwise the answer is rejected.
4. **It is stored in the file's rulebook** (hashed, versioned, reused for the same file). This also stops the repeated pre-study (U6).

**How the structure step uses it (both modes)**
- **Front-matter blocks never become items.** They are reported once ("Left out: cover, revision history, contents, abbreviations,
  repeated header/footer — pages 1–2").
- **Requirements are cut at the layout's boundaries.** SURVEY's heading detector builds every section heading, so BASELINE and SURVEY
  produce the same items. SURVEY only rewrites wording.
- **Without a model** (BASELINE with no connection), the loader guards (Q1, Q3, Q5, Q8) still remove the worst failures. The layout
  improves on them but is not required for a sane tree.

**Unchanged on purpose**
- CSV/xlsx stated tables. Their accuracy scorecard must stay identical.
- Epic → Feature → Requirement, with only Epics as roots.
- No text the document does not contain.

## 5. UX/UI: what the live app shows today

Walked on the local stack (2026-11-24) with the synthetic `all_together` PDF: BASELINE wizard, SURVEY wizard, and one SURVEY job on
the dev model. Screenshots are in `.playwright-mcp/synthetic/` (workspace root, not committed).

### Wizard
| # | Finding | Evidence |
|---|---|---|
| U1 | **Step 1's "Document map" numbers the front matter as sections:** "1 Power Distribution Unit Specification", "2 Revision History", "3 Table of Contents", "3.1 Abbreviations". The real sections get "–". The user's first view of the structure is backwards | `b-step1-1440.png` |
| U2 | **"Does this look right?" repeats the faults instead of explaining the structure.** The quoted purpose ends with leaked footer text ("Acme Proprietary - Do not distribute PDU-SPEC-0042 Rev 2.0"). The section list has two "1"s, two "2"s and two "3"s ("1 Power Distribution Unit Specification … 1 Introduction"). Abbreviations is filed under the contents page as "3.1". Nothing says what will be left out or how items will be built | `b-step2-baseline-cards-1440.png` |
| U3 | **Three or four cards describe one subject.** SURVEY step 3 shows the overview plus AI summary, the knowledge base, "How this file is read" and "Reading and analyzing the document". Three of them describe what the document is: the quoted purpose, the AI summary and the Study's purpose. "It never writes the items" and "The job can start once it is read" each appear twice. There are two timers and two status regions | `b-step3-survey-top-1440.png` |
| U4 | **"How this file is read" ends in a non-answer.** "NOTHING THE MODEL COULD VERIFY … found no type the document states (0 of 3 answers usable)", then the same sentence ("read by its recognised headings and its shape") twice in a row. The same wording also appears when the model could not be reached at all, so a broken connection looks like an unreadable file | page text, step 2 |
| U5 | **The AI summary reads front matter as content:** "covers general power distribution unit details, revision history, and a table of contents" | step 3 |
| U6 | **The user waits for repeated model work:** the rules pre-study took ~95 s in the wizard and ran **again** in the job (~134 s: an empty result was never stored), during which "Parse" showed nothing about it. (Correction: the Study itself read the document once; the wizard's second request after switching mode and the job's request were cache hits.) | ingestion log for job `ffc97b64` |
| U7 | **At 390 px the reason for waiting is off screen.** Start shows "Reading the file…" (disabled). The explanation and "Stop waiting" are about 1.7 screens further down. The Study has no "Stop waiting" at all | `b-step2-baseline-waiting-390.png` |

### Running screen
| # | Finding | Evidence |
|---|---|---|
| R1 | **"Parse" says nothing about what it waits on:** "No update for 1m 38s. Still working", "Working — no progress estimate for this step yet", "Now: Waiting for the model's next answer." All the while, it is the pre-study and Study re-run (U6) | `b-running-parse-wait-1440.png` |
| R2 | **"Now" never changed in the whole 5-minute run.** It read "Waiting for the model's next answer." from Parse to Dedup. Batched steps (scoring, grouping, trace links) create no live lane, so the card falls back to its fixed sentence (`liveCopy.ts` `NO_ACTIVE_WORK_COPY`) | page sampler, every 2 s |
| R3 | **Four regions state the same activity.** During scoring: the header ("Scoring requirement quality (batch 1 of 1)…"), "Still working on Score", the Now card and "Waiting on the model, scoring requirement batch 1 of 1 — 59s so far". DESIGN.md §11.3.5 allows two | `b-running-score-1440.png` |
| R4 | **Scoring sat at 36% for about 110 s** with "No update for 1m 13s". Its second vote runs inside the batch and is never announced. Meanwhile the bar was about half full while it read "0 of 11 requirements in this step" | sampler 72 s → 182 s |
| R5 | **Counters that start full or disagree:** "Grouping … 17 of 17 blocks" and "Resolving trace/coverage links — 17 of 17 blocks" appear when those passes *start*, while the same panel says "0 of 20 items in this step", then "0 of 8 items". The rail keeps all of this under "Score". NN/g: never "hang on the last percentage" | sampler 182–190 s |
| R6 | **The job's own result shows the structure fault live.** The outline line read "1 outline item: Power Requirements (9)" for the whole run (Q7). Scoring listed "Power Distribution Unit Specification, Revision History, Table of Contents, Scope ......" as drafted requirements. The review tree opens on "Introduction ......", "Power Requirements ......" and "Built-In Test ......" Features, plus filler items named after the file ("spec all together", including two nested Epics) | `b-review-1440.png` |

## 6. UX/UI: proposed changes

Each decision cites a primary source, fetched 2026-11-24, and `req2ado/DESIGN.md`.

**Sources**
- NN/g, Progress indicators: use percent-done for 10 s or more, explain the work ("3 of 50"), never hang on the last percentage, no
  static "Loading…".
- NN/g, Response-time limits: over 10 s, users need an expected end time and a clearly signposted way to interrupt.
- WCAG 2.2 SC 4.1.3: status and progress are announced without taking focus.
- Carbon, Loading pattern: for processes taking minutes, show progress, not a loading indicator, and say if it is stuck.

**W1. One card, "This file and how it will be read", identical in BASELINE and SURVEY.** It replaces "Does this look right?", "How
this file is read" and "Reading and analyzing the document". Its content, in order:
1. **Structure found:** sections, how deep, and how requirements are numbered.
2. **Left out:** front matter by role and pages.
3. **How items are built:** "each REQ-nnn paragraph becomes one Requirement under its section".
4. **One disclosure for the Study's findings:** terms, standards, open values.

It has one status region, one timer and one "Stop waiting" that covers both the rules and the Study (NN/g 10 s rule; WCAG 4.1.3;
DESIGN.md §11.2, §16.15 no card in a card, §16.20 one bar per quantity). The AI summary becomes the card's one-line opening sentence,
not a separate box, and it may not describe front matter as content.

**W2. Step 1's document map** shows front matter as "Left out" with its role and pages. Only real sections are numbered (fixes U1).

**W3. Waiting:**
- The layout is stored, so the pre-study runs once per file, not once per session and again in the job.
- The Study is keyed by file and model, not by mode, and the job reuses the wizard's Study.
- While anything holds Start, the sticky Start bar says why ("Reading the file's layout — 1:12 so far") and offers "Stop waiting"
  at every width (fixes U6, U7).

**W4. A model that cannot be reached is an error with a remedy** ("Your model connection did not answer. Check it in Settings"). It
must not show the same message as an unreadable file (fixes U4).

### 6b. Running screen

**L1. Every pass has a name, a reason and a real count.** Each pass the job runs gets one structured field set: `pass`, `index`,
`count` and a one-line purpose. The rail's Score phase becomes a small checklist of its passes:
- scoring (vote 1, vote 2 — "a second, independent vote, so one answer cannot decide the score");
- grouping;
- trace links (each pass named);
- criteria.

A pass is "Finished" at its end, with its own result line (DESIGN.md §11.3.5; NN/g "explain what is happening"). No counter starts
at N of N: the start event carries 0 of N.

**L2. The "Now" card shows the current pass's real subject or is absent.**
- Batched step: the batch's sample titles plus "vote 2 of 2, 0:41". This comes from the narration the job already publishes, so it
  needs no new model call.
- Nothing to show: the card is not drawn, rather than drawn static (DESIGN.md §16.22, absent not greyed; §16.12, no motion without a
  state change).

**L3. One place says what is happening, one place says waiting.** The phase header and the Now card only (§11.3.5). The "No update
for …" note and the separate waiting line merge into the one 60 s waiting note.

**L4. Progress carries a per-stage `complete` flag,** and updates where only the count changes are no longer dropped
(`progress.service.ts`). A stage at 100% turns "Finished" at once. If the job then waits on something else (criteria waiting on the
Study), that wait is named: "Waiting for the document reading to finish".

**L5. Parse names its sub-steps:** "Reading the file's layout (stored for next time)" and "Reading the document". After W3 they are
usually skipped, and the screen says "reused".

**Mocks:** [`docs/mocks/pdf-quality-ux-2026-11-24.html`](mocks/pdf-quality-ux-2026-11-24.html) shows the one wizard card (ready, desktop; still reading, 390 px) and the running screen (scoring vote 2, desktop; trace links, 390 px), each next to what the same file shows today. They are for the owner's review before anything is built.

## 7. Measurement

**Per failure class, a fixture check (TDD, failing first)**
- Zero items or text from cover, notice, revision, contents, abbreviations, header or footer blocks (Q1–Q5).
- Every REQ-nnn and every numbered "shall" paragraph is exactly one item, in BASELINE and SURVEY (Q6–Q8).
- Every heading of a requirement section is an item in both modes, and SURVEY items equal BASELINE items (Q7).
- No item text that is not a contiguous run of source text after whitespace normalisation.

**No regressions**
- The accuracy scorecard is unchanged, including CSV/xlsx byte-identical.
- All package suites pass: ingestion pytest, orchestrator, frontend vitest, e2e.

**The owner's real PDFs (counts and structure only, no content)** — per file, before and after:
- items per type;
- items that come from front matter (cover, TOC, revision, abbreviations, header/footer);
- items that hold more than one requirement ID;
- headings with no item.

**UX**
- Before/after screenshots at 1440 px and 390 px.
- A wizard walkthrough on the synthetic files.
- The owner reviews the mocks before any UI is built.

## 8. Order of work (after approval)

1. Fixtures plus failing checks for Q1–Q8 (the fixture builder exists).
2. Loader guards: TOC lines, title before the first section, repeated margins, paragraph break at a requirement ID, hyphenation.
3. SURVEY heading detector builds every section, with the same statement split as BASELINE (Q6, Q7).
4. Document layout in the pre-study: candidates, model by block id, code check, stored in the rulebook.
5. Structure step uses the layout (front matter out, boundaries in), and the "Left out" report.
6. Wizard: the one card, the step 1 map, the waiting changes (W1–W4).
7. Running screen (L1–L5).
8. Owner's counts on the real PDFs; then release.

Steps 1–3 already fix most of the visible damage without any model. Steps 4–5 make "study first, then structure" real.

## 9. Out-of-scope findings (reported, not part of this plan)

Found during this work. None is fixed here. Severity is Blocker / High / Medium / Low; effort is XS–XL.

| # | Finding | Severity | Effort | Note |
|---|---|---|---|---|
| O1 | **Filler items named after the file.** The real-model SURVEY tree had items titled "spec all together": one Epic, two nested Epics and Features. They are added by the ladder repair and root regrouping when the real sections are lost. | High | M | Probably goes away once Q7 keeps every section. If not, it belongs in this plan as a result-quality item. Recommend checking it at step 3 of the order of work |
| O2 | **Live progress may be off in production.** `LIVE_PROGRESS` defaults to false in both ingestion (`config.py` `live_progress`) and the orchestrator (`config.schema.ts`), and nothing under `deploy/` sets it. The local walkthrough had it on (`.env`). Production may show a different, sparser running screen than §5 describes | Medium | XS | Confirm the production value before building L1–L5. The running-screen plan assumes it is on |
| O3 | **Model quota spent on front matter.** The job scored "Power Distribution Unit Specification", "Revision History", "Table of Contents" and "Scope ......" as requirements, against the knowledge base. Trace links and dedup ran on them too | Medium | — | A consequence of Q1–Q4; it goes away with them. Listed so the owner sees the cost, not as separate work |
| O4 | **Outdated developer guide.** `docs/handoff-frontend-rebuild.md` still describes seeding sessionStorage to skip login. Auth is now a server-side session, so the bypass no longer works. Local UI testing needs a real PAT entered by a person | Low | XS | Update the doc. A mock sign-in path for local testing would be a separate decision |
| O5 | **Knowledge base: "SharePoint token expired"** shown in the wizard and the system status ("1 needs attention") | Low | XS | Operational: reconnect SharePoint in the knowledge base. Not a code issue |
| O6 | **Ingestion answers unauthenticated calls on its host port** (local `8010`). The direct `/prestudy` call worked with no user | Low | S | Check that production keeps ingestion internal-only, reachable only from the orchestrator. Not verified here |
| O7 | **Pending from earlier sessions:** PR #52 (eval report keeps a failing repeat's checks) is merged; the probe re-runs are tracked in the probes hand-off | — | — | Not part of this work |

## 10. Implementation status (2026-11-24, uncommitted)

Steps 1–7 are implemented in the working tree. Nothing is committed or released.

| Item | Where | Status |
|---|---|---|
| Fixtures and checks for Q1–Q8 | `ingestion/tests/fixtures/build_spec_pdf_fixture.py`, `tests/test_spec_pdf_structure.py` | 86 pass. 2 strict xfails record the known limit: a one-line requirement that fills its line, set tight, with no code |
| Loader guards | `pdf_loader.py` | Running header/footer: every margin line. New paragraph at a coded requirement. Paragraph end at a short sentence-ending line (body right edge). Hyphen join |
| SURVEY heading detector | `id_hierarchy.rows_from_id_headings` | Claims headings only when a leaf heading states a requirement. Otherwise the shared structure builds every section |
| Statement split with codes | `id_hierarchy.is_standalone_statement`, `customer_id.leading_requirement_code` / `opens_a_requirement` | "REQ-001: … shall …" splits. "ISO-9001 …", "RS485 …" and document numbers do not |
| Document layout | `app/leveling/document_layout.py` | Contents entries. Everything before the first numbered section, but only when nothing there states a requirement or is titled as content. Cover title promoted to the document title. Left out once, as `front_matter_left_out` |
| Layout learned by the pre-study | `study/model_rules.py`, `study/rulebook.py`, prompt `study_file_rules_document.v2` | Headings by number only, checked by code (no requirement code in the section, at most half the document), voted, stored. The outline the model reads leaves out what code already found. Re-study is deliberate (code pass "4") |
| Stored empty readings | `orchestrator/.../file-rulebook.service.ts` | A settled empty reading is kept and reused. A transient one (the model could not be reached) is not |
| Wizard (W1–W4) | `frontend/src/components/FileReadingCard.tsx`, `NewJobWizard.tsx`, `FileRulesCard.tsx` (embedded) | One card. "Left out" list. One status region. "Stop waiting" in the Start bar stops both readings. Model unreachable reported as cause and remedy. Step 1 "Front matter left out" note. Preview overview built from content only |
| Running screen (L1–L4) | ingestion narration, live emitter, `progress.service.ts`, `WorkingOnCard`, `ProgressBanner` | The second vote is announced (`pass`). Criteria and its wait for the Study are named. Whole-tree passes no longer show the document's block count. Trace is marked complete. Count-only changes are sent. "Now" shows the current batch or is absent. One waiting line |
| L5 (Parse sub-steps) | — | Not built. With stored readings the job usually skips the pre-study. The Study already narrates its parts |

**Verified:**
- Ingestion, orchestrator, frontend and shared suites (results in the session summary).
- The Playwright desktop e2e run fails the same 31 tests on an untouched copy of HEAD as with these changes, so those failures pre-date this work.
- An independent code review: no Blockers. Its High and Medium findings are fixed, with regression tests.

**Live check (local stack, dev model qwen3.6:35b, synthetic `all_together` PDF, job `86f1a79c`):**
- Step 1 lists only the 7 real sections, plus "Front matter left out (pages 1–2)".
- Step 3 is one card.
- The job made 15 items in 106 s: Epic "Power Distribution Unit Specification", 6 section Features, 1.1 Scope and REQ-001 to REQ-007. Before the change, job `ffc97b64` made 20 items in about 5 minutes, with contents-page Features and filler Epics.
- The job made no pre-study call (stored reading reused), and its Study was a cache hit.
- Trace links counted from "0 of 15". Criteria was a named step. The Now card named each pass.

**Not verified:** the owner's real PDFs (counts only, still to be run). Prompt v2 has no prod-model eval yet. The prod value of `LIVE_PROGRESS` (O2).


### 10b. Follow-up fixes (2026-11-24, after the owner's review)

| Item | Fix | Verified |
|---|---|---|
| **Owner example:** "1.1 Scope" became a Requirement, and SURVEY wrote "The system shall define the requirements of ..." | `app/leveling/informational.py`: a leaf whose title is a context title (Introduction, Scope, Purpose, ..., in English and Hebrew) and whose text states no obligation and no requirement code is folded, word for word, into its parent's description. It is reported as `informational_section_folded` and is never a Requirement, so SURVEY never rewrites it | Fixture checks in both modes. Live job `c6c7865f`: 14 items, Scope text kept in "1 Introduction" |
| **Owner:** Customer IDs not visible | The title no longer repeats its own ID (the description keeps the document's words). The ID chip leads the title in the tree and in the item dialog. The tree opens the Features nested inside the first open Feature, so its requirements are on screen | DiffTree tests. Live: "REQ-001 \| The PDU shall ..." rows visible on arrival |
| Live progress off in production | `LIVE_PROGRESS: "true"` in `deploy/helm/req2ado/values.yaml` (read by the orchestrator and ingestion). No chart version bump | Config only: takes effect on the next deploy |
| Parse sub-step (L5) | The worker passes the job id to `/prestudy`. Ingestion publishes `learn_layout` ("Reading the file's layout -- stored for the next run of this file") on the job's live channel | Endpoint and orchestrator tests |
| Step 1 counted front-matter tables | The preview counts tables, figures, blocks, TBDs, tokens and the estimate from the document's content | Live: "2 tables detected" gone |
| "7 of 7 headings carry no clause number" | `document-profile.hasClauseNumber`: a number printed in the heading counts (the loaders leave `number_label` empty then) | Live: the note is gone, and heading detection now reads "reliable" |
| Wizard switched to SURVEY by itself | **Not reproduced.** Watched the selected mode every 0.5 s for 45 s after "Check and start": it stayed on BASELINE. The only path that sets the mode is the mode cards; the saved draft is written on every change. The first sighting followed a frontend container restart | Open: needs a second sighting with steps |
| Real-PDF counts | `ingestion/scripts/pdf_structure_counts.py`: numbers only (items per type, front matter left out, Customer IDs, merged IDs, lost sections, contents lines as items). Runs offline; a test proves no document text is printed | For the owner to run |
| Pre-study v2 on production models | Offline eval cases `front_matter_by_heading`, `scope_is_not_front_matter` (good passes, bad fails). Hand-off: `docs/handoff-prod-prestudy-v2-eval-2026-11-24.md` | For the production run |


### 10c. Production check (2026-11-24, ingestion 0.3.33 / orchestrator 0.3.29 / frontend 0.3.26)

The owner's two real PDFs, counted with `scripts/pdf_structure_counts.py` (numbers only):

| | File 1 | File 2 |
|---|---|---|
| Items | 2 Epics, 28 Features, 110 Requirements | 3 Epics, 27 Features, 167 Requirements |
| Front matter left out | 4 parts (page 1), 73 blocks | 4 parts (page 1), 107 blocks |
| Contents lines as items | 0 | 0 |
| Requirements holding several IDs (merges) | 0 | 0 |
| Numbered sections with no item | 0 of 44 | 0 of 20 |
| Descriptive sections kept as context | 1 | 1 |
| Requirements with a Customer ID | 19 | 80 |

The pre-study v2 eval passed 3/3 on both production models (see the eval hand-off). `LIVE_PROGRESS` was already `true` in production.
Still to confirm by eye in the wizard: that the "Left out" list of each file holds only cover, notice, revision history and contents.
