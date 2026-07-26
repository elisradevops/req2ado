# Frontend visual language upgrade — design

Date: 2026-07-26
Status: approved (design), pending implementation plan

## Context

The frontend was just migrated from MUI to Tailwind v4 + Radix (full replace, ground-up rebuild of 19 components + 7 pages). That migration was a faithful 1:1 behavior port — every component/page carries the same logic and roughly the same visual weight it had under MUI, just on the new stack. Nothing was redesigned; the goal was zero regressions.

Separately, in an earlier session, a visual direction was designed and approved via mockup + interactive prototype: navy (`#0F1B3D` rail) + signal yellow (`#FDE134`, reserved strictly for "this needs your decision" surfaces), a mono identifier type class for clause numbers/ADO ids/job ids/hashes/timers (the "clause spine" thesis — the app's real artifact is a traceability ledger, clause `3.2.1` → work item `WI-1234`), tuning B (navy rail only, tinted canvas, white cards). That direction lives in `themeTokens`/`index.css`'s `@theme` block and in the primitives (`Button`, `Card`, `Chip`, etc.) built during the Tailwind migration, but the *execution* is still close to MUI's default visual weight — correct colors and type, minimal depth, minimal motion, functional but not confident.

The user now wants creative latitude to execute this identity more fully now that Tailwind removes the constraint of working within MUI's component defaults. Confirmed via three scoping questions: keep the approved palette/thesis (don't reopen it), apply the upgraded language to everything going forward (not just a retrofit pass), and aim for "confident and refined" — real depth and purposeful motion, not maximalist risk-taking, not minor polish either.

## What this is not

Not a new palette, not a new thesis, not a new component architecture. The primitives (`src/ui/*`), the token system (`src/index.css`'s `@theme`), and the page/component structure from the migration all stay. This is about how those things render and behave — depth, motion, type contrast, interaction feedback — not what they are.

## Design

### 1. Three-tier elevation, used with intent

Today every `Card` uses one shadow (`shadow-card`) regardless of state. Tokens already define three (`shadow-card`, `shadow-popover`, `shadow-dialog` in `index.css`); only `shadow-dialog` is actually used (Radix `Dialog`/`Toast`/`DropdownMenu`).

- **Resting**: `shadow-card` — unchanged, the default for any card/tile at rest.
- **Raised**: `shadow-popover` — applied on hover/selected for interactive surfaces: `StatTile` hover, table rows on hover, the clause-spine's selected node, `ModeCards`' selected card. Paired with a 1-2px `-translate-y-px` for physicality, not just a shadow swap.
- **Floating**: `shadow-dialog` — already correct, no change.

Implementation: add `hover:shadow-popover hover:-translate-y-px transition-[transform,box-shadow]` (duration/easing from existing `--ease-out`/motion durations) to `Card`/`StatTile` as an opt-in variant prop (`interactive?: boolean`), not a blanket default — static display cards (e.g. a read-only summary tile) shouldn't lift.

### 2. Motion with a reason, not motion everywhere

Current motion inventory: page-enter fade (`fadeIn`), dropdown/tooltip fade+scale (Radix defaults), toast slide, indeterminate progress bar. Extending:

- **List entrance**: rows in `JobsList`'s table and the future clause-spine tree stagger in on first paint (short, ~30ms per-row delay via CSS `animation-delay`, capped so a long list doesn't take visibly long to settle — cap at ~8 rows of stagger, rest appear together).
- **Dialog/menu motion**: replace the current plain opacity fade on `Dialog`/`DropdownMenu` with a subtle scale+fade (`scale-95 → scale-100` alongside opacity) — already Radix's recommended data-state pattern, just add the transform.
- **The decision affordance**: once `ConfirmDialog` is wired into `JobDetail`'s Confirm button (Phase 4, already planned), the confirm CTA gets a slow breathing glow (`shadow` pulsing between two signal-yellow-tinted values, ~2.6s cycle) once its acknowledgement checkbox is ticked — matches the approved prototype. Never applied to any other button; this is the one place motion signals "waiting on you."
- **Explicitly not doing**: hover-triggered motion on every icon/link, decorative background animation, anything that fires on mount without a state-change reason. `prefers-reduced-motion` kill-switch (already in `index.css`) covers all new motion automatically since it's implemented via the same transition/animation utilities.

### 3. Type contrast sharpened — and the type family itself reconsidered

**Refinement (post-review):** the original migration's Inter Tight + Inter pairing is exactly the "safe AI-generated default" this app should avoid — Inter/Inter Tight is the pairing any similar B2B review-tool brief would produce regardless of subject. Since the palette and mono face (IBM Plex Mono) are locked, the fix is to stop mixing an unrelated display/body family with a bolted-on mono, and instead unify the whole system under the **IBM Plex superfamily**: Plex Sans (display, restrained heavy use — page titles only), Plex Sans (body, regular weight), Plex Mono (identifiers, unchanged). One type family designed as a coherent system, with a technical/engineering heritage that actually matches the subject, replaces three families glued together for convenience.

Add a fourth, narrowly-scoped utility role: **Plex Sans Condensed** for genuinely dense tabular content that has a real overflow problem today — long ADO area paths and iteration paths in table cells and the destination bar. This is justified by an actual content constraint (these strings routinely run 30-50 characters), not decoration.

`h1`-style page titles (via `PageHeader`) currently differ from body text mainly by size/weight. Push the display/body contrast harder: heavier weight + tighter negative tracking on `PageHeader`'s title specifically (not all headings — section headings inside cards stay closer to body weight, so the contrast reads as "this is the page," not "everything is loud").

Mono identifiers (job ids, clause numbers) get a subtle treatment where they're structural content rather than incidental — e.g. in the future clause-spine, the clause-number column gets a faint tabular/monospace visual rhythm (tabular-nums already applied; add a subtle vertical guide/tick per depth level per the approved prototype's "spine" gutter) instead of being just another text color.

### 3a. Signature sharpened: the document-control margin

**Refinement (post-review):** the clause-spine thesis was correct but under-executed — the last mockup pass rendered it as a generic dashboard with mono accents, not something a systems/requirements engineer would recognize from their own world. Sharpening it around three real artifacts of that world:

- **Title-block strip.** Engineering drawings and controlled specs carry a title block: document, revision, date, approval state, laid out as small-caps labels over mono values with hairline dividers between fields. The review-gate header's document identity (name, job id, revision/hash, analysed-in time) adopts this convention directly instead of a generic breadcrumb-and-badge row — it's a layout this audience reads instinctively because they see it daily on the documents themselves.
- **Verification-method badges, real shorthand.** Systems engineering verifies each requirement by one of four canonical methods — Inspection, Analysis, Demonstration, Test (the "IADT" verification matrix, a real and universal convention in this discipline). Where the diff tree shows a requirement's verification method, use the actual single-letter engineering shorthand (I/A/D/T) in a small mono badge, not a generic colored tag with a made-up label.
- **Redline convention for superseded content.** Near-duplicate/rejected clauses in the diff tree use strikethrough + a muted red-adjacent tone — this already existed loosely; make the connection explicit: it's borrowed from the red-pen redline convention on a physical markup, not an arbitrary "danger" color choice.

These three are the one place this design spends its boldness; everything else (elevation, motion, buttons) stays quiet and disciplined per the restraint principle.

### 4. Primitive interaction states

`Button`, `Card`, `Chip` currently have correct but minimal hover states (background/border color shift only). Add:
- `Button`: active/pressed gets a small scale-down (`active:scale-[0.98]`) alongside the existing `active:translate-y-px`, so a click reads as a physical press, not just a color change.
- Disabled states get slightly more visual demotion where it matters most (destructive/CTA buttons) so "you can't do this yet" is unambiguous at a glance, not just lower contrast text.

### 5. Where this lands

Everything remaining in the original Phase 4 plan gets built directly in this upgraded language rather than plainly ported then revisited: the destination bar (JobsDetail/running state), the banded quality gauge with animated needle (`NodeDetailPanel`), the KB folder-tree view, chat panel polish (model picker, streaming indicator), `ConfirmDialog` wired into Confirm/Reject, Wiki markdown styling. None of these exist as functioning UI yet in the real app (only in the earlier mockup/prototype) — they get built once, in the upgraded language, not built plain and redone.

Already-migrated screens (Login, JobsList, AppShell, NewJobWizard, KnowledgeBase, JobDetail's existing tabs/tree) get the elevation/motion/interaction-state upgrades (items 1, 2, 4) applied directly — this is a small, mechanical pass (opt into the new `Card`/`Button` variants) since the components already exist and only need the new tier/behavior wired in.

The type-family swap (item 3) touches every screen at once since it's a token-level change: `@fontsource/ibm-plex-sans` and `@fontsource/ibm-plex-sans-condensed` replace `@fontsource-variable/inter-tight` and `@fontsource-variable/inter` in `main.tsx`, and `--font-display`/`--font-sans` in `index.css`'s `@theme` update accordingly. `IBM Plex Mono` (identifiers) is already in place and unchanged. Both new packages confirmed available on the npm registry (`@fontsource/ibm-plex-sans@5.3.0`, `@fontsource/ibm-plex-sans-condensed@5.3.0`).

## Testing

No new testing strategy needed beyond what the migration already established (vitest + RTL). Motion/elevation are visual-only changes; existing tests assert content/behavior, not shadow classes, so they should be unaffected. Any new interactive behavior (e.g. a `Card`'s `interactive` prop changing hover classes) gets asserted via className presence only if a future bug specifically regresses it — not proactively unit-tested, since visual regression here is better caught by the browser verification pass (Playwright, as done after the migration) than by snapshot/class assertions.

## Open questions

None — all three scoping questions were answered with the recommended option, and this design stays inside those answers.
