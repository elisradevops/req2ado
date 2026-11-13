# UX research: the daily review flow (upload → run → review → write)

Status: research input for the next implementation plan. Date: 2026-11-12. Nothing here is built yet.
Scope: Jobs list, New job wizard (steps 1–3), live run (phase rail + phase view), Diff Ready review (warnings, tabs,
`DiffTree`, `NodeDetailDialog`), Write to Azure DevOps, the written/audit state.
Inputs: DESIGN.md, `frontend/src/index.css` tokens, and the known-problem list from the two daily-user reviews
(`docs/handoff-ux-review-2026-11-12.md` did not exist when this was written, so the list in the request was used).

How sources are used: every non-obvious claim has a URL. "Primary" means a standards body, a design system's own docs,
a vendor's own product docs, or a peer-reviewed paper. Where only secondary support exists, or none, it says so.
No statistics in this file are estimates of our own; the only numbers are those quoted from the sources.

---

## Summary

1. **Review is triage, not reading.** Order the queue by "needs a human decision", not by tree order. Bucket items into
   a short *Fix before writing* queue, a *Check* queue and a *Clean* group that can be approved in one counted batch.
   A label that covers 16 of 17 items carries no information. Recalibrate it, or drop it.
2. **Put the requirement text first in the item dialog.** Show the draft beside the source sentence. Put scores, KB refs
   and metadata behind one disclosure level (NN/g: more than 2 levels loses users).
3. **Show confidence as categories with an action attached** (PAIR), not as raw numbers. Unscored items (Epics) must sort
   last, not first.
4. **Do not rely on explanations alone to stop rubber-stamping.** Buçinca et al. found that explanations do not reduce
   overreliance and that light "cognitive forcing" does. For req2ado that means requiring an explicit look at the
   *Fix before writing* items, not adding a confirm dialog to everything.
5. **Long runs: honest stages plus elapsed time, and a range only when it is grounded.** NN/g and Primer both say that
   anything over 10 s needs feedback the user can leave and come back to. Size the estimate from pages and sections,
   or don't show one. Report cache hits as "reused N sections from <date>".
6. **Failures must state the cause, what was kept and what the user can do next** (NN/g error guidelines, PAIR). A failed
   run that reads only "Failed" is the top trust problem in the list.
7. **Gate Write on readiness and keep it visible.** Use a sticky action bar that carries the blocking count. Write stays
   disabled, with the reason written in text, while any *Fix before writing* item is open. The confirm dialog names
   exact counts and the destination. After commit the job changes identity: a "Written" state label, ADO ids, and no
   proposed-styling anywhere.
8. **Reading ergonomics.** Cap requirement and source text at about 60–75ch with 1.5 line-height (WCAG 1.4.8 / 1.4.12),
   summary first, and a highlighted decision sentence. The app's 14px/20px body is below the 1.5 leading that WCAG
   1.4.8 (AAA) describes, so long reading surfaces need a reading-text token.
9. **Motion: few, short, productive.** 100–300 ms (NN/g), exits faster than entrances, nothing that loops on a screen the
   user reads for an hour. The existing duration/easing tokens already cover this. Section "Proposed visual and motion
   language additions" lists 8 specific micro-interactions, each with a reduced-motion fallback.
10. **Jobs list.** Group by day and state, start with a "Needs you" group, use short job ids, keep sticky filters and 2–3
    saved views, and mark stale jobs (proposed but superseded or not touched) explicitly.

---

## 1. Review efficiency (Diff Ready → Review view, DiffTree, NodeDetailDialog)

### Evidence
- **Triage inbox with one-key verdicts.** Linear Triage is a separate inbox. Each issue leaves it by Accept (`1`),
  Decline (`2`), Duplicate (`3`/`MM`) or Snooze (`H`), and "Triage is considered to be outside the normal workflow".
  https://linear.app/docs/triage
- **Per-unit "viewed" state with progress, reset on change.** In GitHub PR review a file can be marked Viewed, "the
  progress bar in the pull request header shows how many files you've viewed", and "if the file changes after you view
  the file, it will be unmarked as viewed". Line comments stay pending until the review is submitted as one batch.
  https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/reviewing-proposed-changes-in-a-pull-request
- **Confidence display.** PAIR: don't show confidence if it does not change the user's decision. Categorical buckets need
  "clear cutoff points" and explicit guidance on what the user should do at each level. Numeric percentages are easily
  misread. https://pair.withgoogle.com/chapter/explainability-trust/
- **Overreliance.** Buçinca, Malaya, Gajos (CSCW 2021): adding explanations did not reduce overreliance on AI
  suggestions. Cognitive forcing functions did reduce it, but users rated those designs least favourably.
  https://www.eecs.harvard.edu/~kgajos/papers/2021/bucinca2021trust.shtml
- **HAX guidelines** (Amershi et al., CHI 2019) that apply here: G2 make clear how well the system can do what it does,
  G9 support efficient correction, G11 make clear why the system did what it did, G16 convey the consequences of user
  actions. https://www.microsoft.com/en-us/research/publication/guidelines-for-human-ai-interaction/ (the guideline
  titles come from the paper. The landing page only links the PDF.)
- **Progressive disclosure.** Put up front what users frequently need, and "designs that go beyond 2 disclosure levels
  typically have low usability". https://www.nngroup.com/articles/progressive-disclosure/
- **Code review is mostly understanding.** Bacchelli & Bird (ICSE 2013) found that reviewers' main challenge is
  understanding the change and its context, not finding defects.
  https://www.microsoft.com/en-us/research/publication/expectations-outcomes-and-challenges-of-modern-code-review/
- **Estimated review time:** no primary source was found that validates showing a per-list "review time" estimate. The
  widely repeated "200–400 LOC per review" figures come from vendor and blog material and are not used here.

### Recommendation for req2ado
1. **Three review buckets with defined rules,** replacing the single "Needs review" label (now 16/17 items):
   - *Fix before writing* (blocking): any of hard warning, likely duplicate above the dedupe threshold, a missing
     source anchor, an invented-number guard hit, or a score below the floor. This list should be short. If it often
     holds more than a handful of items, the thresholds are wrong; that is a product-owner question (Q1).
   - *Check* (non-blocking): borderline score, a weak KB match, or a text the model edited heavily.
   - *Clean*: everything else. Approve them with one "Approve N clean items" action through the existing
     `BulkApproveDialog`. Its label carries the count, and the list stays expandable before confirmation.
   Unscored structural items (Epics, Features with no draft text) go into a fourth, collapsed group,
   "Structure (not scored)". They never lead the risk order.
2. **Default sort is "decision needed", then by section order.** Do not sort by the raw score. Show the score as a
   category chip ("Below floor", "Borderline", "OK") with a one-line reason, following PAIR's categorical guidance. Keep
   the numeric score in the dialog's detail disclosure.
3. **Review progress like GitHub's.** Show "Reviewed 7 / 12 that need you" in the Review header. Visiting an item marks
   it reviewed only after an explicit verdict (A/X/E), not on open. If the model regenerates an item, it returns to
   unreviewed (GitHub's reset-on-change rule).
4. **Keyboard triage loop.** Keep J/K/A/X/E. After a verdict, auto-advance to the next item *in the current bucket*,
   not the next row in the tree. Show the remaining count. Add `Shift+A`, "approve all remaining in this bucket"; it
   only works in *Check* and *Clean* and asks for a counted confirmation. There is no bulk approve in *Fix before
   writing*: that is the cognitive-forcing step from the Buçinca evidence, applied only where the risk is.
5. **Item dialog content order** (applies to `NodeDetailDialog` / `NodeDetailPanel`):
   1. Verdict bar: bucket chip, the reason in one sentence, A/X/E.
   2. Requirement text (the draft), at reading size.
   3. Source excerpt with the anchoring sentence highlighted, side by side with the draft at ≥1024px and stacked
      below that.
   4. One disclosure, "Why this verdict": scores, rubric, KB references, duplicate match, provenance.
   Metadata such as area path, iteration and tags moves to a compact footer line. This is one level of disclosure.
   Do not nest accordions inside it.
6. **AI summary.** The summary must not restate structure the tree already shows. It should give only what the tree
   cannot: "3 sections had no extractable requirements: §4.2, §7, Annex B" and "2 likely duplicates of existing ADO
   items". If nothing like that exists, omit the summary rather than fill it.

### Trade-offs / when not to
- Auto-advance can surprise users who opened an item only to read it. Advance only after a verdict, never on open.
- Bulk approval raises speed but also overreliance. That is why it is excluded from the blocking bucket, and why the
  bucket rules must be written down (G2/G11) so users can see what "Clean" means.
- Hiding numeric scores behind a disclosure will annoy power users who calibrate on numbers. Keep them one click away,
  not removed.

---

## 2. Run waiting and failure (phase rail, phase view, failed runs)

### Evidence
- **Thresholds.** 0.1 s feels instant, 1 s keeps the flow of thought, and 10 s is the limit of attention. Beyond 10 s
  "users will want to perform other tasks while waiting … they should be given feedback indicating when the computer
  expects to be done", and they "need reorientation when returning". https://www.nngroup.com/articles/response-times-3-important-limits/
- **Indicator choice.** Use a looped spinner for 2–10 s and percent-done for 10 s or more. The article reports a
  Nebraska-Lincoln study in which users with a moving bar were "willing to wait on average 3 times longer" (a
  secondary report of that study). https://www.nngroup.com/articles/progress-indicators/
- **Primer loading:** show no loader under 1 s. Use determinate indicators from 3 s and consider background processing
  past 10 s. Show items incrementally as they load. Use `role="status"` and `aria-busy`.
  https://primer.style/product/ui-patterns/loading/
- **Skeletons** suit full-page loads of about 2–10 s. Frame-only skeletons are not recommended.
  https://www.nngroup.com/articles/skeleton-screens/
- **Errors.** Describe the issue "concisely and precisely", "offer constructive advice", and "preserve the user's
  input". https://www.nngroup.com/articles/error-message-guidelines/ PAIR: "explain why a certain result couldn't be
  given and provide alternative paths forward". https://pair.withgoogle.com/chapter/errors-failing/
- **Live regions.** Status updates must be announced without moving focus (WCAG 4.1.3).
  https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html Auto-updating content that lasts more than 5 s
  needs a pause/stop/hide mechanism (WCAG 2.2.2). https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html
- No primary source was found that quantifies how accurate a time estimate must be before it helps. The NN/g "always
  allow for extra time" advice is the only guidance used.

### Recommendation for req2ado
1. **Stage-based progress with a determinate inner bar only where the denominator is real.** In SURVEY the denominator
   is the number of sections and is known after parsing, so "Drafting · section 14 of 41" is honest. The overall run
   gets a stage rail (done, current, pending) plus the elapsed time. There is no overall percentage unless it is
   computed from the per-stage denominators.
2. **Size-aware estimates or none.** Show a range ("usually 20–35 min for documents this size") only when it comes from
   recorded runs of similar page and section counts in this installation. Before there is enough history, show
   "No estimate yet: 41 sections queued", in line with the "no invented numbers" rule. Recompute after each section
   and never let the range move backward silently. If it widens, say why ("section 22 is a 40-row table").
3. **Make cache reuse visible.** Add a line in the phase view and a chip in the rail: "Reused 12 of 41 sections from
   the run on 2026-11-10 (document unchanged)". This explains why a run is fast, and reruns stop looking suspicious.
4. **Fill dead air with real events, not animation.** Throttle the `NarrationTicker` / `ActivityFeed` to milestones:
   section finished, duplicate found, a warning raised. Each event carries a timestamp. Give the feed a pause control
   (WCAG 2.2.2) and announce it through a polite live region at no more than one announcement per milestone, never per
   token.
5. **Return-to-tab reorientation.** When the tab regains visibility after more than 1 min, show a one-line
   "Since you left: 9 sections drafted, 1 warning" banner. Fire a browser notification on completion only if the user
   opted in. This applies NN/g's "reorientation when returning".
6. **Failure card, structured.** Every failed run shows:
   - **What failed:** the stage plus the section ("Drafting · §7.3 Interfaces").
   - **Why:** the mapped cause class, for example LLM timeout, LLM refused or returned an invalid schema, document
     parse error, ADO auth, or cancelled by user. Raw detail goes behind `ErrorDetailsDialog`.
   - **What is kept:** "34 of 41 sections drafted and saved".
   - **Next action:** "Retry from §7.3" (primary), "Retry whole run", "Open what was drafted".
   Never show a bare "Failed" chip on the Jobs list either. Include the cause class in short form ("Failed · LLM
   timeout").
7. **Empty and loading states.** Use skeleton rows that mirror the final layout for the Jobs list and the Review tree
   (2–10 s band), with an `EmptyState` that has one action ("No jobs yet: Upload a document"). Show no loader for
   loads under 1 s (Primer), using a 300–400 ms show delay before the skeleton appears.

### Trade-offs / when not to
- Percent-done bars that stall are worse than stage plus elapsed time. If per-section time varies a lot (tables, figures),
  prefer "section N of M" over a smoothed percentage.
- Browser notifications are intrusive for a daily tool. Make them opt-in per user.
- Resume-from-section needs backend support (idempotent stage restart). If that does not exist, show "Retry whole
  run" only and say what will be reused from cache.

---

## 3. Write decision and committed state

### Evidence
- **Confirmation dialogs** belong only before serious consequences. They must name specifics ("filenames or
  quantities"), use outcome-labelled buttons rather than Yes/No, and should not appear so often that they are
  ignored. For very dangerous actions, require a non-standard action. https://www.nngroup.com/articles/confirmation-dialog/
- **Consequences of actions:** HAX G16, "convey the consequences of user actions".
  https://www.microsoft.com/en-us/research/publication/guidelines-for-human-ai-interaction/
- **Unambiguous state labels.** Primer StateLabel gives each lifecycle state (Draft, Open, Merged, Closed) its own icon,
  color and text. https://primer.style/product/components/state-label/
- **Disabled buttons.** Primer advises against semantically disabling buttons during loading
  (https://primer.style/product/ui-patterns/loading/). No primary design-system source was fetched that covers
  "disabled with the reason shown". The pattern below (disabled plus a visible text reason) is a reasoned inference
  from NN/g's error-visibility guidance, not a cited rule.
- **Deploy-style "after commit" pages** (Vercel/Stripe): no primary documentation was fetched for this. Treat them as
  analogy only.

### Recommendation for req2ado
1. **Sticky write bar** at the bottom of the Review view, always in view. On mobile it is the last tab stop and after
   the tree in DOM order, which fixes "Write first" in the keyboard order. Contents:
   `[Fix before writing: 2 open → Go]  [Check: 5]  [Clean approved: 31]  ……  [Write 38 items to <Org>/<Project>]`.
   While *Fix before writing* > 0, the Write button is visually disabled (`aria-disabled="true"`, still focusable),
   with the reason in text next to it. Activating it jumps to the first blocking item. This keeps the signal-yellow as
   the only Write control while making the blocker obvious.
2. **Counted confirmation.** The dialog repeats the destination org/project/area path and gives counts by type
   ("Create 3 Epics, 9 Features, 26 Requirements; link 4 to existing items; skip 2 rejected"). The button reads
   "Write 38 items", not "Confirm". Do not add type-to-confirm: writes happen daily, and the NN/g overuse warning
   applies. Exception: a write that *updates* existing ADO items (backfill) could justify it (Q4).
3. **Committed state is a different identity, not a different badge colour.**
   - Job header StateLabel: "Written · 2026-11-12 14:32 · 38 items". It uses a check icon and the written colour,
     distinct from the proposed colour and not yellow.
   - Tree rows show the ADO id as a link (`#12345`). All proposed-only affordances (A/X/E, the write bar, proposed
     dashed/tinted styling) are removed, not dimmed.
   - The Review tab is renamed or replaced by "Written items" by default. A read-only "What was proposed" view stays
     reachable from the audit.
   - A partial write is its own state ("Partially written · 30 of 38 · 8 failed → Retry 8"). It never shows as
     "Written".
4. **During the write,** show determinate progress ("Writing 17 of 38"). Do not allow navigation-away without a
   warning. On completion, post a single toast and leave the page in the committed state; don't hand the user off to
   the Jobs list.

### Trade-offs / when not to
- `aria-disabled` plus a focusable button is better for discoverability but needs care so Enter does not submit. The
  handler must check readiness.
- If users routinely want to write despite open blockers ("I'll fix in ADO"), a hard gate pushes them to reject items
  just to proceed. An alternative is "Write anyway, excluding 2 blocked items" (Q2).

---

## 4. Reading ergonomics (item dialog, step 3 "Does this look right?", summaries)

### Evidence
- **WCAG 1.4.8 Visual Presentation (AAA):** lines no wider than 80 characters, line spacing of at least 1.5,
  paragraph spacing at least 1.5 × line spacing, no justified text. https://www.w3.org/WAI/WCAG22/Understanding/visual-presentation.html
- **WCAG 1.4.12 Text Spacing (AA):** no loss of content when users set line-height 1.5, paragraph spacing 2×,
  letter spacing 0.12em, word spacing 0.16em. https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html
- **Line length on screen:** Dyson & Haselgrove (IJHCS 2001) found comprehension highest around 55 characters per
  line. In related work, long lines (about 100 cpl) were read faster but rated harder, and preference did not track
  performance. https://doi.org/10.1006/ijhc.2001.0458 and Dyson & Kipping, Visible Language:
  https://journals.uc.edu/index.php/vl/article/view/5671 (seen through abstracts and search summaries, not the full
  text).
- **Scanning:** the "layer-cake" pattern (headings, then the relevant body) is "by far the most effective way" of
  scanning. Support it with meaningful subheadings, bullets and bolded keywords.
  https://www.nngroup.com/articles/text-scanning-patterns-eyetracking/
- **Progressive disclosure:** no more than 2 levels (see section 1).

### Recommendation for req2ado
1. **Reading-text token.** Requirement text, source excerpts and AI summaries use `--text-read`: 15px/24px (1.6) or
   16px/26px. Keep 14px/20px for chrome, tables and metadata. Cap width at `max-w-[68ch]`; `ProposalCard` already uses
   68ch, so make it the shared rule. Don't use justified text. Paragraph gap is ≥ 0.75em.
2. **Highlight the decision sentence.** In the source excerpt, highlight the sentence the draft was derived from
   (`<mark>` with a quiet background token, not yellow, which is reserved for Write). In the draft, bold the modal
   verb or acceptance clause only when the rubric flagged it. Do not highlight decoratively.
3. **Side-by-side source and draft** at ≥1024px: source on the left in a muted surface, draft on the right in the
   primary surface, top-aligned. Below 1024px the draft comes first and the source collapses under it.
4. **Step 3 "Does this look right?" becomes a summary, not a wall.** Use three short facts at the top: detected
   structure ("4 chapters → Epics, 23 sections → Features"), what will be skipped and why, and what needs the user's
   choice. Then a collapsed outline. Each item is one line with a count. Lead each paragraph with its conclusion
   (layer-cake). If a section has no decision, it does not render.
5. **WCAG 1.4.12 regression check:** add a test or Playwright check that injects the 1.4.12 bookmarklet styles into the
   item dialog and Review tree, and asserts no clipped text. Fixed-height virtualised rows in `DiffTree` are the
   likely failure point.

### Trade-offs / when not to
- Larger reading text means fewer tree rows per screen. Apply the reading token only to prose surfaces, never to the
  tree or the tables.
- Side-by-side halves the measure. At 1180px dialog width, two 68ch columns don't fit at 16px. Use about 55–60ch per
  column (still inside the Dyson & Haselgrove range) or a 40/60 split.

---

## 5. Motion

### Evidence
- **Duration:** "most animations should be in the range of 100–500 ms". Simple feedback is about 100 ms, modals 200–300
  ms, 500 ms starts "to feel like a real drag". Entrances should be slightly longer than exits. "The more frequent the
  animation, the more subtle and shorter." https://www.nngroup.com/articles/animation-duration/
- **Carbon productive vs expressive:** productive motion is "subtle", for task moments; expressive is for significant
  moments. Tokens are fast-01 70ms, fast-02 110ms, moderate-01 150ms, moderate-02 240ms, slow-01 400ms, slow-02 700ms.
  Productive entrance `cubic-bezier(0, 0, 0.38, 0.9)`, exit `cubic-bezier(0.2, 0, 1, 0.9)`.
  https://carbondesignsystem.com/elements/motion/overview/
- **Reduced motion:** motion triggered by interaction must be possible to disable unless essential (WCAG 2.3.3, AAA).
  `prefers-reduced-motion` in CSS (C39) or JS (SCR40) is a sufficient technique.
  https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html
- **Looping / auto-updating** content over 5 s needs pause/stop/hide (WCAG 2.2.2, link above).
- Material 3 easing/duration token pages did not render for fetching. Their values are not cited here.
- No primary evidence was found that FLIP or stagger animations improve task performance. They are recommended below
  only where they preserve object constancy (an item visibly moving to where it went), and this is labelled as design
  judgement.

### Recommendation for req2ado
The app already has the right primitives: `--duration-instant 90ms`, `--duration-fast 140ms`,
`--duration-base 190ms`, `--duration-exit 120ms`, `--duration-medium 240ms`, `--duration-slow 320ms`, `--ease-out`,
`--ease-in`, a global reduced-motion clamp, and `motionContract.test.ts`. Classify every animation as *productive*
(the default, ≤ 240ms) or *milestone* (≤ 320ms, at most a few per job). There is no expressive tier. Ambient loops
(`--duration-breathe`, `--duration-ambient`) are only allowed on a single liveness indicator, never on text the user is
reading.

Micro-interactions worth building (each solves a listed problem):

| # | Interaction | Problem it solves | Spec | Reduced-motion fallback |
|---|---|---|---|---|
| 1 | **Verdict settle**: on A/X/E the row's status chip cross-fades to the new state, then the row slides out of its bucket (height collapse) | "Did my key press register?" and keeping your place in the triage queue | chip 90ms `--ease-out`; collapse 190ms `--ease-in`, starting after 120ms | Instant swap. Focus moves to the next row and a polite live region says "Approved. 6 left in Check." |
| 2 | **Count tick** on bucket counters and the write-bar totals (`AnimatedNumber`) | Counts that change silently are not noticed | 240ms; no roll for changes > 99, just set | Snap (number-flow already snaps) |
| 3 | **Blocker pulse-once**: when Write is activated while blocked, the blocker chip draws one outline ring and the view scrolls to the first blocking item | Write enabled while blockers are open, and the blocker being out of view | ring 320ms, once; smooth scroll via `motion.ts` | No ring, `scroll-behavior: auto`; focus moves to the blocker; message in text |
| 4 | **Phase advance**: the finished rail step's connector fills, and the next step's label crossfades to "current" | Dead air and unclear stage changes during long runs | 240ms fill `--ease-out`, once per stage | Instant state change plus a polite announcement, "Drafting complete. Scoring started." |
| 5 | **Committed-state settle**: after the write, row badges change proposed → `#ADO id` in a top-to-bottom stagger (≤ 20ms per visible row, capped at 200ms total), then the header StateLabel changes | Written jobs still reading as proposed | per-row 140ms; total cap 200ms + 190ms | Single instant swap plus a toast "38 items written" |
| 6 | **Summary reveal**: the item dialog's "Why this verdict" disclosure expands with a height + opacity transition | Metadata dominating; disclosure needs a visible link between trigger and content | 190ms open, 120ms close | Instant expand |
| 7 | **Skeleton → content crossfade** on Jobs list and Review tree, shown only if the load is > 300ms | Blank empty/loading states; flash of loader on fast loads | 140ms fade; no shimmer loop | Static skeleton (no shimmer), instant swap |
| 8 | **New-event fade** in the activity feed: the new line fades in at the top and older lines don't move until the user scrolls | Dead air vs. distracting tickers | 140ms opacity only, no translate | Instant; feed has a Pause control regardless (2.2.2) |

When *not* to animate: tree expand/collapse in a virtualised list (re-measuring cost and jank, since an instant toggle
is fine at 100s of rows), tab switches, scrolling text or marquee tickers, number rolls on scores in the dialog (the
user is reading them), anything that moves the requirement text while it is being read, and spinners or shimmer on
regions the user is not waiting on.

### Trade-offs / when not to
- Every animation in the triage loop multiplies by the number of items per day. Measure that #1 never delays the next
  key press: input must be accepted during the collapse.
- Staggers look polished in demos and slow in daily use. Keep #5's total cap.

---

## 6. Jobs list and triage

### Evidence
- **Linear Triage** separates incoming items from the normal workflow and gives each a terminal action (link above).
- **GitHub "Viewed" and progress** (link above): show, for each unit, whether the user has dealt with it.
- **Primer StateLabel:** one status label per lifecycle state, with icon, colour and text together (link above).
- No primary source was fetched for saved views and sticky filters specifically. GitHub's issue filters and Linear's
  views are precedents, but they are not cited as evidence of benefit.

### Recommendation for req2ado
1. **Default grouping:** "Needs you" first, then the remaining jobs grouped by day.
   - *Needs you* = Diff Ready but not written, Failed, or Partially written.
   - Day groups: Today, Yesterday, This week, Earlier, each collapsible.
   - Within a group, sort by last activity.
   This replaces the undifferentiated 72-row list.
2. **Row identity:** a short job id (`J-4F2A`), the document name (truncated in the middle so the extension and
   version suffix survive), the project, the mode badge, a StateLabel with the cause for failures, item counts
   ("38 proposed" vs "38 written · #12000–#12037"), and relative time with an absolute tooltip.
3. **Sticky filters** (state, project, mode, mine/all) persisted per user in `localStorage` (convenience only). Provide
   2–3 built-in saved views: "Needs you", "Written this week", "Failed". Custom saved views can wait.
4. **Stale state.** A proposed job older than N days, or one whose document has a newer job, gets a "Superseded by
   J-…" or "Stale · proposed 9 days ago" chip. Its Write path warns that the ADO project may have changed since the
   diff (the diff is computed against the ADO state at run time). Users should never write an old diff unknowingly.
5. **Empty state** has one action (Upload). The loading state uses skeleton rows (section 2.7).

### Trade-offs / when not to
- Grouping by "Needs you" hides chronological context. Keep the day labels inside the group as well.
- A short id is only useful if the same id appears in the job header, the URL and the ADO history comment.

---

## Proposed visual and motion language additions

Fits the existing Tailwind v4 `@theme` + `@utility` setup in `frontend/src/index.css`. No new dependencies:
`AnimatedNumber` (number-flow) and Radix already cover this.

```css
@theme {
  /* reading prose: requirement text, source excerpts, summaries (section 4) */
  --text-read: 15px;
  --text-read--line-height: 24px;      /* 1.6, meets WCAG 1.4.8 leading */
  --measure-read: 68ch;                /* one shared measure; 58ch per column in side-by-side */
  --measure-read-split: 58ch;

  /* review state colours: each paired with an icon + text (never colour alone) */
  --color-state-proposed: <existing proposed/accent token>;
  --color-state-written: <new: a calm green/teal distinct from accent and from signal-yellow>;
  --color-state-partial: <warning family, not yellow-signal>;
  --color-state-failed: <existing danger>;
  --color-mark-source: <quiet tint for highlighted source sentence; not signal-yellow>;

  /* motion semantics: aliases onto existing rungs so code reads by intent */
  --motion-feedback: var(--duration-instant);   /* 90ms: chip change, press */
  --motion-reveal: var(--duration-base);        /* 190ms: disclosure open */
  --motion-dismiss: var(--duration-exit);       /* 120ms: disclosure close, row exit start */
  --motion-milestone: var(--duration-medium);   /* 240ms: phase advance, count tick */
  --motion-stagger-step: 20ms;                  /* cap total 200ms */
  --loader-show-delay: 300ms;                   /* no skeleton for fast loads */
}
```

Rules to add to DESIGN.md (§2.6/§8) and enforce in `motionContract.test.ts`:
- No animation on prose surfaces while visible (no translate or opacity on `--text-read` elements after mount).
- Ambient loop tokens are allowed only on `LivenessDot`.
- Any stagger uses `--motion-stagger-step` with a 200ms total cap.
- Every state change that is animated also has a text or live-region equivalent.
- The existing easing tokens are kept. `--ease-out` (0.22, 0.61, 0.36, 1) is close in character to Carbon's productive
  entrance curve, so no new curves are needed.

## Prioritised build order (S/M/L)

Ordered by safety first (proposed vs written, write gating), then daily time saved.

| # | Item | Size | Fixes |
|---|---|---|---|
| 1 | Committed-state identity: Written / Partially written StateLabel, ADO ids in rows, proposed affordances removed | M | Written jobs read as proposed |
| 2 | Sticky write bar with blocker count, `aria-disabled` + reason, jump-to-blocker; DOM/tab order after tree | M | Write enabled with open blockers; scrolls away; keyboard/mobile order |
| 3 | Counted, outcome-labelled write confirmation (counts by type, destination) | S | HAX G16 |
| 4 | Failure card: stage, section, cause class, what was kept, retry actions; cause in Jobs list chip | M (L if resume-from-section needs backend) | Failed runs give no cause |
| 5 | Review buckets (Fix before writing / Check / Clean / Structure) with written rules; recalibrated thresholds; unscored last | M | "Needs review" meaningless; Epics first |
| 6 | Item dialog reorder: verdict, draft, source side-by-side, single "Why" disclosure; reading token | M | Requirement text buried; text walls |
| 7 | Keyboard triage loop: per-bucket auto-advance, progress "7 / 12", Shift+A in non-blocking buckets | S | Review speed |
| 8 | Jobs list grouping (Needs you + day groups), short ids, sticky filters, 3 built-in views, stale chip | M | 72-row list |
| 9 | Honest run progress: "section N of M", size-based estimate or "no estimate yet", cache-reuse line, return-to-tab banner | M | Estimates ignore size; cache invisible; dead air |
| 10 | Skeleton/empty states with 300ms show delay | S | Blank states |
| 11 | Step 3 summary rewrite (three facts + collapsed outline) and AI summary "only what the tree can't show" | S–M | Text walls; summary restates structure |
| 12 | Micro-interactions #1–#8 plus motion contract rules | S each | Feedback, orientation |
| 13 | WCAG 1.4.12 text-spacing check on dialog and tree | S | Accessibility regression guard |

## Open questions for the product owner

1. **Blocking rules:** which conditions exactly make an item *Fix before writing*? The current rules put 16/17 items in
   "Needs review". What target share is acceptable (for example, "usually under 10%")?
2. **Hard gate or exclusion:** while blockers are open, should Write be impossible, or should "Write the rest, excluding
   N blocked" be allowed?
3. **Bulk approve:** is approving all *Clean* items in one counted action acceptable for audit purposes, or must each
   item get an individual verdict?
4. **Updates to existing ADO items (backfill):** do they warrant a stronger confirmation (type the project name) than
   creating new items?
5. **Estimates:** is it acceptable to show "no estimate yet" until there is enough local run history, rather than a
   generic range?
6. **Resume:** is "retry from the failed section" feasible in the pipeline, or is whole-run retry with cache reuse the
   realistic recovery path?
7. **Stale diffs:** after how many days, or after which ADO-side changes, should a proposed job be marked stale or
   need a re-diff before writing?
8. **Notifications:** should run completion notify (browser notification, email, Teams), and opt-in or opt-out?
9. **Mobile:** is review on mobile a real use case, or only status checking? This decides whether the side-by-side
   reading layout needs a mobile variant beyond stacking.
