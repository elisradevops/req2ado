# req2ado — Design Language

**Status: normative.** This file is the single source of truth for the visual
system. `frontend/src/index.css`'s `@theme` block is its machine-readable
projection. Where the two disagree, §1.8 names the disagreement explicitly —
an unrecorded divergence is a bug, not a style choice.

Two enforcement tests keep this document from drifting into fiction:
`frontend/src/design/palette.test.ts` and `frontend/src/design/tokens.test.ts`.
Both are ratchets: they fail on an *increase* in violations, never on the
existing baseline. See §15.

**This revision** folds in the four-screen design pass (New Job step 1, New Job
step 2, the running-job screen, the work-item detail panel + chat) and promotes
its hover/lift behaviour to an app-level interaction system (§6). It supersedes
the previous DESIGN.md wholesale. Sections were renumbered; do not cite section
numbers from the old revision.

Still superseded, still deleted, do not restore from `git log`:
`CLAUDE-DESIGN.md` (a tool-brief), the pre-rewrite Stitch `DESIGN.md` (its
screen inventory lives on in `docs/ui-inventory.md`), and
`docs/design-decisions.md` §"Visual language: Deep Indigo Enterprise" (stale:
MUI 6, a deleted `theme/tokens.ts`, cyan as the interactive accent). The rest of
`docs/design-decisions.md` — app-shell shape, split-view Job Detail, the
two-step wizard, area-path picker rationale, SSE approach — is unaffected and
remains current.

---

## §0 — What this app is, and why that constrains everything below

req2ado is a **traceability ledger** whose terminal action writes irreversibly
into a customer's Azure DevOps server. Three non-negotiables follow directly
from that sentence, and every rule in this document is downstream of them.

1. **Identifiers are set in mono, always.** A clause number, an ADO work-item
   ID, an area path, a job UUID, a model name — anything a human or a script
   might copy-paste and expect to match exactly — is `font-mono`. Prose is never
   mono; identifiers are never proportional.
2. **Exactly one colour means "this cannot be undone."** Signal-yellow
   (`--color-signal`). It appears nowhere else. If it appeared elsewhere, a user
   would habituate to it and stop reading it as a warning.
3. **No visual state may be ambiguous between "proposed" and "written."** A diff
   row, a lifecycle step, a status chip — each must be unambiguously readable as
   either a draft the system is proposing or a fact that now exists in ADO. This
   is the single most important thing the design protects, because the cost of
   confusing the two is a customer's production work-item tracker.

Every screen in §11 carries an explicit, always-visible restatement of (3). On
the wizard it is the footer line "Nothing reaches Azure DevOps until you approve
the proposed diff." On the running-job screen it is the locked note "Nothing has
been written to Azure DevOps. Writing only starts after you approve the diff."
These are not decorative reassurance — they are the product's core safety claim,
and removing them is a design regression.

### §0.1 — Two settled decisions. Do not re-litigate.

The design pass that produced §11 raised two conflicts with the existing system.
Both are resolved. They are recorded here so a future session finds the
resolution before it finds the temptation.

**Icons: `lucide-react` wins.** The mockup drew its own inline SVG symbol set.
The product already imports `lucide-react` in 29 files and this document has
mandated it as the only icon source since the previous revision. The custom set
is **not** adopted. §10 maps every icon the mockup invented onto a real
`lucide-react` export; use that table, do not hand-author SVG.

**The ETA is never capped. Only its presentation is softened.** See §11.2.3 for
the full rule. The short version: `frontend/src/utils/eta.ts` deliberately
removed its 40-minute upper clamp on 2026-08-05 (`docs/ui-progress-review.md`
§1) because for this product's real target case — 500+ page documents —
underselling wait time is worse than an intimidating honest number. The calmer,
ranged presentation this revision adopts derives its range **from the real,
uncapped estimate**. It must never clamp the underlying value.

> The mockup's own caption copy reads "Scaled from block and figure counts, then
> capped". **The second half of that phrase is wrong.** It is a bug in the
> mockup's prose, not a decision. Do not carry it into the product, the code
> comments, or a future revision of this file. (The *first* half becomes true
> under §11.2.3, which finally gives `figureCount` a real weight — as a fitted
> coefficient over this deployment's own completed runs, not a hand-picked
> constant. It was never true of the shipped code, which reads `blockCount`
> alone.)

**And the number is now measured, not guessed.** The revision that specified a
static `15 + blocks×0.5 + figures×2.0` formula plus a name-parsed model
multiplier is **reversed** — it predicted 434–564 minutes for a document that
really completed in ~90. §11.2.3 replaces it with a least-squares fit over real
completed-job durations, which requires persisting document size on the `Job`
row. That is a schema change, not a frontend tweak. Read §11.2.3 in full before
touching anything about the ETA.

---

## §1 — Token layer (normative)

**A value not in this section does not exist.** No component may introduce a
hex, a pixel size, a radius, a shadow, or a duration outside it.

### §1.1 — Colour

```css
@theme {
  /* 0. DELETIONS — make the system enforceable, not aspirational. */
  --color-*: initial;   /* deletes red-500, slate-200, etc. (~280 utilities) */

  /* 1. PRIMITIVES (restored after --color-*: initial) */
  --color-white: #ffffff;
  --color-transparent: transparent;
  --color-current: currentColor;
  --color-inherit: inherit;

  /* 2. SURFACES — four levels, no more. Depth beyond this is hairlines,
   *    never a fifth surface tone. */
  --color-canvas: #f1f4fa;          /* page background, behind everything */
  --color-surface: #ffffff;         /* cards, dialogs, popovers, inputs */
  --color-surface-alt: #f6f8fc;     /* recessed-inside-a-card / row hover */
  --color-surface-sunken: #eaeff7;  /* table headers, code blocks, track fills */
  --color-scrim: rgba(11, 18, 32, 0.45); /* dialog overlay */

  /* 3. HAIRLINES & CONTROL BOUNDARIES */
  --color-hairline: #dde4ee;         /* decorative dividers — exempt from 3:1 */
  --color-hairline-strong: #c9d2e2;  /* emphasised dividers, table rules */
  --color-field-border: #8494ab;     /* every input/select/checkbox border — 3.09:1 */

  /* 4. INK */
  --color-ink-1: #0b1220;            /* 14.2:1 on white — headings, primary text */
  --color-ink-2: #334155;            /* 10.4:1 — body, secondary */
  --color-ink-3: #5b6a80;            /*  5.49:1 on surface, 5.00:1 on canvas */
  --color-ink-on-dark: #e6eaf5;      /* text on rail / tooltip / toast / log */
  --color-ink-on-dark-dim: #c6d0e8;  /* secondary text on dark surfaces */

  /* 5. ACTION — primary affirmative action. Ink-black.
   *    Hover LIGHTENS: an ink-black button cannot meaningfully darken. */
  --color-action: #0b1220;
  --color-action-hover: #1b2438;
  --color-action-active: #05090f;
  --color-action-ink: #ffffff;       /* 14.2:1 */

  /* 6. ACCENT — indigo. The ONE interactive/selected colour. */
  --color-accent: #4f46e5;           /* 6.31:1 on white, 5.74:1 on canvas */
  --color-accent-hover: #4338ca;
  --color-accent-active: #3730a3;
  --color-accent-soft: #eef2ff;      /* selected-row / selected-card fill */
  --color-accent-soft-border: #c7d2fe;
  --color-accent-ink: #3730a3;       /* 8.85:1 on accent-soft */
  --color-accent-on-dark: #a5b4fc;   /* 8.4:1 on rail-900 */

  /* 7. FOCUS — aliases, so "focus ring colour" is one token, not a choice. */
  --color-focus: #4f46e5;
  --color-focus-on-dark: #a5b4fc;

  /* 8. RAIL — the app shell's nav rail. Nothing else. See §2. */
  --color-rail-900: #0f1b3d;
  --color-rail-hover: #17306b;
  --color-rail-active: #1b458f;
  --color-rail-indicator: #3b60c0;

  /* 9. SIGNAL — irreversible / confirm-to-ADO ONLY. Never a focus ring
   *    (#fde134 on white measures 1.31:1, failing WCAG 2.2 SC 1.4.11's 3:1
   *    floor). Never a stat-tile accent, never a status chip, never a toast. */
  --color-signal: #fde134;
  --color-signal-hover: #ffe95c;
  --color-signal-border: #e3c821;
  --color-signal-deep: #7a5c00;      /* 4.74:1 on signal */
  --color-signal-ink: #0b1220;       /* 14.2:1 on signal — CTA label */

  /* 10. SEMANTIC STATUS — fill / soft / border / ink quad per severity, so an
   *     Alert, a chip, and a toast at the same severity are provably the same
   *     colour. */
  --color-ok: #15803d;
  --color-ok-soft: #ecf7f0;
  --color-ok-border: #b7e0c3;
  --color-ok-ink: #15603a;

  --color-danger: #d1434b;
  --color-danger-hover: #b8323a;
  --color-danger-soft: #fbe9ea;
  --color-danger-border: #efc4c7;
  --color-danger-ink: #8a2229;

  --color-warning: #b45309;
  --color-warning-soft: #fdf6ec;
  --color-warning-border: #eed8b4;
  --color-warning-ink: #7a4f0b;

  --color-info: #2563eb;
  --color-info-soft: #eef3fd;
  --color-info-border: #c6d6f3;
  --color-info-ink: #1d4ed8;

  --color-live: #06b6d4;             /* streaming / in-flight ONLY */
  --color-live-soft: #ecfeff;

  --color-shimmer-highlight: #e6ebf4;

  /* 11. DATA PALETTES — real ADO values, fallback only; the app fetches them
   *     live per project. Allowlisted for raw hex in exactly four files. */
  --color-wt-epic: #ff7b00;
  --color-wt-feature: #773b93;
  --color-wt-requirement: #009ccc;
  --color-state-new: #b2b2b2;
  --color-state-proposed: #b2b2b2;
  --color-state-active: #007acc;
  --color-state-resolved: #ff9d00;
  --color-state-closed: #339933;
  --color-state-removed: #7f7f7f;
```

### §1.2 — Type families

```css
  --font-display: 'IBM Plex Sans', 'Inter Variable', -apple-system, 'Segoe UI', sans-serif;
  --font-sans:    'IBM Plex Sans', 'Inter Variable', -apple-system, 'Segoe UI', sans-serif;
  --font-mono:    'IBM Plex Mono', ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
```

**Built — see §18.** The migration to one Plex family closes the seam between a
mono identifier and its proportional label: in a ledger UI those two sit
adjacent constantly (`§3.2.1` next to *Target acquisition time*, `WI-8842` next
to *Acquisition timing test*), and three unrelated families make that seam
visible. IBM Plex Sans and IBM Plex Mono share metrics and drawing, so the
identifier reads as the same voice as the sentence around it.

### §1.3 — Type scale

Eight rungs, numeric, closed set. `text-[Npx]` does not exist. `xs`/`sm`/`base`
keep Tailwind's exact px so existing call sites need no edit — only their
line-heights are pinned to integers.

```css
  --text-micro: 10px;   --text-micro--line-height: 14px;
  --text-micro--letter-spacing: 0.06em;  --text-micro--font-weight: 600;
       /* eyebrow labels, stat-tile captions, section eyebrows */

  --text-meta: 11px;    --text-meta--line-height: 15px;
  --text-meta--letter-spacing: 0.04em;
       /* field labels, badge text, mono ids in rows, the run meta line */

  --text-xs: 12px;      --text-xs--line-height: 16px;
       /* helper text, chips, dense table cells, map-row section titles */

  --text-sm: 14px;      --text-sm--line-height: 20px;
       /* DEFAULT UI TEXT — buttons, rows, labels */

  --text-base: 16px;    --text-base--line-height: 24px;
       /* prose only: Markdown body, the ADO-preview body, Wiki, Help */

  --text-title: 17px;   --text-title--line-height: 24px;
  --text-title--letter-spacing: -0.01em;  --text-title--font-weight: 600;
       /* dialog titles, card section headers, the run phase headline */

  --text-display: 22px; --text-display--line-height: 28px;
  --text-display--letter-spacing: -0.022em;  --text-display--font-weight: 700;
       /* PageHeader — the only page-level title */

  --text-metric: 24px;  --text-metric--line-height: 28px;
  --text-metric--letter-spacing: -0.02em;  --text-metric--font-weight: 600;
       /* StatTile / QualityGauge / ETA numerals only */
```

### §1.4 — Spacing

**Decision: adopt Tailwind v4's dynamic scale explicitly. No named spacing
tokens.**

```css
  --spacing: 0.25rem;               /* 4px base; n and n.5 both legal */
```

Named tokens (`--spacing-cozy`, `--spacing-tight`) would create a *second*
vocabulary alongside the numeric one Tailwind cannot suppress — exactly the
drift this document exists to prevent. There is no arbitrary-spacing debt to
migrate: `(p|m|gap|space)[trblxy]?-\[[0-9.]+px\]` returns zero hits across
`frontend/src/**/*.tsx`.

**Permitted rungs:** `0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 8, 10, 12, 16`
(0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 32, 40, 48, 64 px).

**Banned:** `p-7`, `p-9`, `p-11`, `p-13`, `p-14`, any `n.5` above `4.5`, and
every `p-[Npx]`. Above 16px the jumps are perceptual, not incremental — in a
dense tabular app, `p-7` vs `p-8` is noise a reviewer cannot adjudicate.

One named exception, so it does not read as an oversight: `ui/EmptyState.tsx`'s
`py-11` — an empty state is deliberately the least dense surface in the app.
Migrate to `py-12` in the next pass that touches that file.

### §1.5 — Radius

```css
  --radius-sm: 6px;      /* buttons, inputs, chips-that-are-not-pills, menu items */
  --radius-md: 10px;     /* cards, tiles, dialogs, popovers, alerts */
  --radius-lg: 16px;     /* full-bleed panels, the dropzone, hero surfaces */
  /* rounded-full stays a static Tailwind value, not a theme key — pills, dots,
     avatars, and progress-track caps only. */
```

Exactly four radius values exist app-wide: `sm`, `md`, `lg`, `full`. **Bare
`rounded` and `rounded-[Npx]` are banned** — bare `rounded` silently resolves to
Tailwind's deprecated 4px fallback, a fifth radius nobody chose.
`tokens.test.ts` enforces this.

### §1.6 — Elevation

```css
  --shadow-sm:      0px 1px 2px rgba(15, 27, 61, 0.05);
  --shadow-card:    0px 1px 2px rgba(15, 27, 61, 0.05),
                    0px 8px 20px rgba(15, 27, 61, 0.055);
  --shadow-raised:  0px 2px 4px rgba(15, 27, 61, 0.07),
                    0px 12px 26px rgba(15, 27, 61, 0.09);
  --shadow-popover: 0px 2px 4px rgba(15, 27, 61, 0.07),
                    0px 16px 34px rgba(15, 27, 61, 0.10);
  --shadow-dialog:  0px 24px 64px rgba(11, 18, 32, 0.32);
  --shadow-cta:           0px 1px 0px rgba(122, 92, 0, 0.22);
  --shadow-cta-attention: 0px 2px 8px rgba(200, 164, 0, 0.34),
                          0px 0px 0px 4px rgba(253, 225, 52, 0.28);
```

Seven values, six tiers of meaning. §9 states what each one *means*; a tier may
only be used for its stated meaning, never borrowed because it looks about
right.

### §1.7 — Duration & easing

```css
  --duration-instant: 90ms;      /* colour-only: chip/row/menu-item tint */
  --duration-fast: 140ms;        /* default: button colour, press, .liftable */
  --duration-base: 190ms;        /* entrance: dialog, popover, list row */
  --duration-exit: 120ms;        /* ALL exits. Exits are always faster. */
  --duration-slow: 320ms;        /* layout: rail collapse, height, tab travel */
  --duration-progress: 900ms;    /* determinate progress width settle */
  --duration-ambient: 1500ms;    /* shimmer, indeterminate loop */
  --duration-breathe: 2600ms;    /* confirm-CTA attention cycle */

  --ease-out:     cubic-bezier(0.22, 0.61, 0.36, 1);   /* entrances, presses */
  --ease-in:      cubic-bezier(0.4, 0, 1, 1);          /* exits */
  --ease-in-out:  cubic-bezier(0.4, 0, 0.2, 1);        /* layout, bidirectional */
  --ease-linear:  linear;                              /* ambient loops only */
}
```

**Never inline a `cubic-bezier(...)` or a bare `Nms`** in `duration-[…]` or
`animate-[name_Nms_…]`. Always reference the token.

### §1.8 — Reality check: where this document leads the code

This table is the honest diff between §1 and `frontend/src/index.css` as it
stands. Every row is a prescription the code has not caught up to yet. **Do not
silently delete a row — close it by changing the code, then move it to §18.**

| # | This document prescribes | `index.css` currently has | Impact |
|---|---|---|---|
| A | `--font-display` / `--font-sans` = IBM Plex Sans | `'Inter Tight Variable'` / `'Inter Variable'` | Cosmetic; the mono/proportional seam in §1.2 stays visible until migrated. Requires adding the Plex Sans package alongside the existing `@fontsource` Plex Mono. |
| B | `--text-*: initial`, `--radius-*: initial`, `--shadow-*: initial`, `--duration-*: initial`, `--ease-*: initial` in `@theme` | only `--color-*: initial` is present | The colour scale is mechanically deleted; the other scales are not. Today they are enforced by `tokens.test.ts`'s regex ratchet instead of by the cascade. Adding the `initial` lines would make `text-3xl`, `rounded-2xl`, `duration-500` compile-time impossible rather than test-time detectable. |
| C | `.liftable` / `.hoverable-row` as `@layer components` utilities (§6) | neither class exists; `.lift` exists only as a reduced-motion marker, with the transition and hover spelled out per call site (see `ui/StatTile.tsx`) | Until §6 lands, hover behaviour is re-decided per component — the exact problem §6 exists to end. |

Nothing else in §1 diverges. Every colour, spacing, radius, shadow, duration and
easing value above matches `index.css` exactly.

---

## §2 — Colour role table

| Role | Token(s) | Permitted surfaces | Forbidden |
|---|---|---|---|
| Page background | `canvas` | Body, behind all content | Inside a card |
| Card / dialog / input surface | `surface` | Cards, dialogs, popovers, inputs, table cells | Page background |
| Recessed inside a card | `surface-alt` | Row hover, sub-panels inside a card | Standalone page sections |
| Deepest recess | `surface-sunken` | Table headers, code blocks, progress tracks, quality-bar tracks | Any clickable element's rest state |
| Primary action | `action`, `action-hover`, `action-active` | The one affirmative CTA per view (Start job, Save, Configure) | Two `action`-coloured buttons competing in one view |
| Interactive / selected | `accent` family | Focus rings, selected rows/cards, active nav, links, checked inputs, the `.hoverable-row` rail, progress fills, stat-tile icons | Anything not currently interactive-or-chosen |
| Irreversible-write CTA | `signal` family | **Exactly one class of element**: the confirm-to-ADO CTA and its acknowledgement affordance | Focus rings, stat tiles, status chips, toasts, lifecycle steps, any other button |
| Nav rail | `rail-*` | `components/AppShell.tsx`'s `<nav>` and its children — **and nothing else** | Buttons, inputs, selected table rows, progress bars — anywhere else |
| Dark status strip | `ink-1` as a background | **Exactly one element**: `components/NarrationTicker.tsx`'s bar (§11.3) | Any other dark surface; `ink-1` stays a text token everywhere else |
| Streaming / in-flight | `live` | A chip or icon **only while a stream is actually open** | A terminal status; anything static |
| Success | `ok` family | Completed steps, positive deltas, succeeded status, the BASELINE marker on the ETA band | Ambient decoration |
| Destructive / error | `danger` family | Failed status, delete actions, validation errors, the Stop control while streaming | Anything reversible-and-safe |
| Caution | `warning` family | Risk flags, quality categories below the passing band, non-blocking parse notes | Errors (use danger) |
| Informational | `info` family | Neutral system messages, the file-type badge, the ETA scope chip | Success or caution |
| ADO type/state colours | `wt-*`, `state-*` | Badges that mirror real ADO metadata | Anything not sourced from ADO data |

**The dark-surface exception, corrected.** An earlier revision of this document
claimed the running-job **activity log** sat on `rail-900` as the one permitted
use of `rail-*` outside `AppShell.tsx`. That is not what the code does, and the
activity log it described no longer exists (§11.3). The one real dark surface
outside the nav rail is `components/NarrationTicker.tsx:22` —
`bg-ink-1 text-white`, the status strip welded to the bottom of the lifecycle
card.

**Direction chosen: document `bg-ink-1` as the exception; do not migrate
`NarrationTicker` to `rail-900`.** The two candidate fixes are (a) change one
class in `NarrationTicker.tsx` or (b) change one row in this table. Both are
small, but (a) is not actually free: the ticker's own text tokens (`text-white`,
`text-ink-on-dark-dim`) are contrast-measured against whichever ground they sit
on, so the migration would also require re-measuring and re-landing two §3 rows,
and `rail-*` is semantically "the navigation chrome" — a status strip inside the
content column is not navigation. `ink-1` (`#0b1220`) is already the app's
darkest ink and is *darker* than `rail-900` (`#0f1b3d`), so every existing
on-dark contrast pair only improves against it. Documenting reality costs zero
real-code churn and loses nothing, so that is the direction this revision takes.

The intent the old paragraph carried is still correct and still binding:
**surfaces of different kinds do not share a skin.** The narration ticker is
dark because it is live machine status; the cards below it (`FigureDescriptions`,
`SectionResults`, `CollapsibleWarnings`) stay on `surface` because they are
content. Adding a *third* dark surface requires an §17 change.

---

## §3 — Contrast ledger

Floors, WCAG 2.2:

- **Body text:** 4.5:1 against both `surface` and `canvas` (SC 1.4.3).
- **Focus rings, input/control borders, state-bearing icons:** 3:1 (SC 1.4.11).
- **Accent fill vs. either light surface:** 3:1.

Measured pairs in use. Any new colour pairing added under §17 must add a row
here with its computed ratio **before merge**.

| Pair | Ratio | Passes |
|---|---|---|
| `ink-1` / white | 14.2:1 | yes |
| `ink-2` / white | 10.4:1 | yes |
| `ink-3` / `surface` | 5.49:1 | yes |
| `ink-3` / `canvas` | 5.00:1 | yes — retuned from `#64748b`, which was 4.33:1 on canvas, a real SC 1.4.3 failure on the app's own page background. Fixed with zero call-site churn since every use was already `text-ink-3`. |
| `accent` / white | 6.31:1 | yes |
| `accent` / `canvas` | 5.74:1 | yes |
| `accent-ink` / `accent-soft` | 8.85:1 | yes |
| `field-border` / white | 3.09:1 | yes — replaces `hairline-strong` at 1.52:1, a real SC 1.4.11 failure as an input border. |
| `signal-deep` / `signal` | 4.74:1 | yes |
| `signal-ink` / `signal` | 14.2:1 | yes |
| `accent-on-dark` / `rail-900` | 8.4:1 | yes |
| `focus` (`accent`) / white | 6.31:1 | yes — replaces the old `signal` focus ring at 1.31:1, a real SC 1.4.11 failure. |
| `ink-on-dark` / `rail-900` | 13.1:1 | yes — on-dark body text in the nav rail. |
| `ink-on-dark-dim` / `rail-900` | 9.9:1 | yes — on-dark secondary text in the nav rail. |
| `white` / `ink-1` | 18.4:1 | yes — `NarrationTicker`'s sentence (§2 dark-surface exception). |
| `ink-on-dark-dim` / `ink-1` | 11.6:1 | yes — `NarrationTicker`'s elapsed timer. `ink-1` is darker than `rail-900`, so every on-dark pair measured above `rail-900` also passes here. |

`--color-hairline` is exempt from the 3:1 floor: it is a decorative divider, not
a control boundary. The moment a hairline is load-bearing — an input edge, a
focus indicator — it must be `--color-field-border` instead.

---

## §4 — Typography rules

- Sentence case everywhere. No ALL-CAPS body copy. `text-micro` eyebrow labels
  are the sole exception and use `letter-spacing: 0.06em` rather than case to
  read as a label, not as shouting. Mode names (`BASELINE`, `SURVEY`) are the
  one other capitalised form, because they are enum values the API returns, not
  prose.
- `text-display` is reserved for `PageHeader` — one per page.
- `text-title` is the only size for dialog titles, card section headers, and the
  running-job phase headline. Do not reach for `text-display` inside a dialog.
- `text-metric` is for numerals only: `StatTile` values, the `QualityGauge`
  score, the ETA range. Never for a word.
- **Mono-identifier rule.** Any ADO work-item ID, job UUID, area or iteration
  path, clause number, model name, block index, or field name renders
  `font-mono`.
- **Tabular-numerals rule.** Any number that changes in place — elapsed timers,
  live counters, block/section/figure counts, percentages, quality scores —
  renders `tabular-nums` so digit width does not jitter as it updates.
- **Long hierarchical identifiers** (area paths, iteration paths, clause paths)
  render `font-mono text-meta` with `truncate` and a `Tooltip` carrying the full
  value. Never a condensed face; never smaller than `text-meta`.
- Prose columns cap at roughly 62–66 characters. The ADO-preview body (§11.4)
  and the ETA rationale line both hold to this; a requirement description set
  full-bleed across the detail dialog's `max-w-[1180px]` is unreadable. This is
  why the dialog's chat pane is a fixed `w-[400px]` rather than a fraction —
  see §11.4.

---

## §5 — Layout, density, and category geometry

- **Page frame:** `main` content area `p-5`. App header is a fixed 52px bar. Nav
  rail is 220px expanded / 64px collapsed with `transition-[width] duration-slow`.
- **Card nesting cap:** a `Card` may never contain another `Card`. Depth beyond
  one level is carried by hairlines and `surface-alt`, never by stacked shadows.
- **Panes own their height.** A step, panel, or screen that is given the
  viewport must have at least one child that *wants* vertical space and grows to
  fill it (`flex:1; min-height:0`). A short stack floating in a tall column is
  the failure mode §11.1 exists to fix; capping the width only moves the void
  around.

A new component picks a **category** from §7, not a look. Concrete geometry per
category:

| Category | Geometry |
|---|---|
| Action | height `h-9` default / `h-8` compact / `h-10` CTA. Icon `h-4`. Radius `sm`. |
| Surface | radius `md`. `p-4` default card body, `p-5` page-level panel. |
| Input | height `h-9`. Radius `sm`. Leading/trailing icon `h-4`. |
| Navigation | rail item `h-10`. Tab trigger `h-9`. Stepper node 28px (`h-7 w-7`). |
| Chip / Badge | height `h-5` (`text-xs`) / `h-6` (`text-sm`). Radius `full`. |
| Row | `h-11` default table row / `h-9` dense-view row / `h-8` log line. |
| Overlay | Dialog / Popover / DropdownMenu / Tooltip: radius `md`; Dialog may use `lg` for full-bleed variants. Elevation per §9. |
| Feedback | Alert / Toast: radius `md`. Left accent bar 4px in the severity's fill colour. |

---

## §6 — The interaction system (`.liftable` / `.hoverable-row`)

**This is the app-level answer to "I do not see any row effects."** Hover
feedback is a system decision, not a per-component one. Exactly two classes
exist. Every repeated interactive surface in the product uses one of them, and
**nothing invents its own hover.**

The split is not stylistic, it is structural:

- **`.liftable` — elevation.** Answers *"this whole thing is one target."* Used
  on things with no neighbours to align against: mode cards, stat tiles, the
  dropzone, file-type affordances, chat suggestion buttons, the Add-child
  button.
- **`.hoverable-row` — fill plus a 2px accent rail.** Answers *"this is one of
  many, and it can also be selected."* Used on things in a list: document-map
  rows, parse-note rows, ADO path segments, `SectionStepList` rows, figure rows,
  quality-category rows, fact rows, diff-tree nodes. **Not** on
  `JobLifecycleSteps` — that is a horizontal `Stepper`, not a row list (§7).

A row cannot lift without shoving its neighbours, and a card has no neighbours
to align a rail against. Both read selection through the same accent, so
selection looks like one idea across the whole app.

### §6.1 — The CSS. Paste as-is.

Append to `frontend/src/index.css` after the `@theme` block. These values are
tuned; do not re-derive them.

```css
@layer components {
  .liftable {
    transition:
      transform    var(--duration-fast) var(--ease-out),
      box-shadow   var(--duration-fast) var(--ease-out),
      border-color var(--duration-fast) var(--ease-out);
  }
  .liftable:hover {
    transform: translateY(-2px);
    box-shadow: var(--shadow-raised);
    border-color: var(--color-hairline-strong);
  }
  .liftable:active {
    transform: translateY(0);
    box-shadow: var(--shadow-sm);
    transition-duration: var(--duration-instant);
  }
  .liftable:focus-visible {
    transform: translateY(-2px);
    box-shadow: var(--shadow-raised);
  }
  .liftable[aria-pressed='true'],
  .liftable[aria-checked='true'],
  .liftable[aria-selected='true'] {
    border-color: var(--color-accent);
  }

  .hoverable-row {
    position: relative;
    transition: background-color var(--duration-fast) var(--ease-out);
  }
  .hoverable-row::before {            /* the 2px accent rail */
    content: '';
    position: absolute;
    inset-block: 0;
    inset-inline-start: 0;
    width: 2px;
    border-radius: 2px;
    background: var(--color-accent);
    transform: scaleY(0);
    transform-origin: center;
    transition: transform var(--duration-fast) var(--ease-out);
  }
  .hoverable-row:hover { background-color: var(--color-surface-alt); }
  .hoverable-row:hover::before,
  .hoverable-row:focus-visible::before { transform: scaleY(1); }

  .hoverable-row[aria-selected='true'] { background-color: var(--color-accent-soft); }
  .hoverable-row[aria-selected='true']::before { transform: scaleY(1); }

  /* rows on a dark ground — the nav rail today; any future dark surface
     admitted under §2 */
  .hoverable-row.on-dark:hover { background-color: var(--color-rail-hover); }
  .hoverable-row.on-dark::before { background: var(--color-accent-on-dark); }
}

@media (prefers-reduced-motion: reduce) {
  .liftable,
  .liftable:hover,
  .liftable:active,
  .liftable:focus-visible { transform: none; }
  .liftable,
  .hoverable-row,
  .hoverable-row::before { transition-duration: 1ms; }
}
```

### §6.2 — Rules that come with the classes

1. **`.hoverable-row` never lifts.** No `translateY`, no `box-shadow`, no
   `scale`, ever. Rows live inside virtualised scroll containers
   (`react-virtuoso` / `react-window`), where a per-row shadow or transform
   causes a repaint storm. The rail grows on the `::before` pseudo-element via
   `scaleY`, which composites and does not touch layout. This rule predates the
   design pass and the design pass independently arrived at the same answer.
2. **`.liftable` never appears on a row.** If something is one of a repeated
   set, it is a row, regardless of how card-like it looks.
3. **Selection is never colour-only.** `.hoverable-row[aria-selected='true']`
   changes fill *and* pins the rail — two channels — and `aria-selected` must be
   set for real, not faked with a class. `.liftable[aria-pressed]` /
   `[aria-checked]` / `[aria-selected]` likewise drives its accent border off
   the real ARIA state.
4. **`.liftable:focus-visible` lifts.** Keyboard users get the same affordance
   as pointer users, in addition to — never instead of — the §7 focus ring.
5. **`.on-dark` is a modifier of `.hoverable-row`, not a separate class.** It
   swaps only the hover fill and the rail colour, so a dark-surface list behaves
   identically to a light one.
6. **Reduced motion means no displacement, not instant displacement.** The
   media query above zeroes the transform outright rather than only clamping the
   duration. See §8.

### §6.3 — Relationship to the existing `.lift`

`.lift` exists today only as a marker inside `index.css`'s reduced-motion block;
the actual transition and hover are spelled out at each call site (see
`ui/StatTile.tsx`'s `interactive` branch). `.liftable` supersedes it. Migration:
replace `lift transition-[transform,box-shadow,border-color] duration-base
ease-out hover:shadow-raised hover:-translate-y-px hover:border-hairline-strong`
with the single class `liftable`, then delete `.lift` from the reduced-motion
block once no call site references it. Note the deliberate value changes in the
new class: `duration-fast` (140ms) rather than `duration-base`, and `-2px`
rather than `-1px`. Both were tuned in the design pass; keep them.

---

## §7 — Interaction-state contract

Every interactive element declares all applicable states: rest, hover, active,
focus-visible, disabled, loading, selected. **A component missing one where the
category calls for it is a defect, not a style choice.**

Base transition on every interactive element:
`transition-colors duration-fast ease-out`, unless a row below overrides it or
§6 supplies it.

**Universal focus rule, all categories:**

```
Light surfaces:  outline: 2px solid var(--color-focus);         outline-offset: 2px;
Dark surfaces:   outline: 2px solid var(--color-focus-on-dark); outline-offset: 2px;
```

Applied in `@layer base` via `*:focus-visible`, with `.on-dark` scoping the dark
form. Offset is 2px, not 1px, so the ring clears the 6px `radius-sm` corner.
**Never `focus:outline-none` without a replacement ring.**

### Action — `Button`, icon buttons, `InfoTip` trigger, `DropdownMenu` trigger

| Variant | Rest | Hover | Active | Disabled | Loading | Selected |
|---|---|---|---|---|---|---|
| `primary` | `bg-action text-white shadow-sm` | `bg-action-hover shadow-raised -translate-y-px` | `bg-action-active scale-[0.98] shadow-sm` | `bg-canvas text-ink-3 border border-hairline shadow-none cursor-not-allowed pointer-events-none` | `<Spinner/>` prepended, label kept, `aria-busy="true"`, `pointer-events-none` | n/a |
| `outline` | `bg-surface text-action border border-field-border` | `bg-accent-soft border-accent text-accent-ink` | `bg-accent-soft-border scale-[0.98]` | as above | as above | `bg-accent-soft border-accent text-accent-ink` (toggle buttons only) |
| `ghost` | `bg-transparent text-ink-2` | `bg-surface-alt text-ink-1` | `bg-surface-sunken scale-[0.98]` | `text-ink-3 pointer-events-none` | as above | `bg-accent-soft text-accent-ink` |
| `danger` | `bg-surface text-danger border border-danger-border` | `bg-danger-soft border-danger` | `bg-danger-soft scale-[0.98]` | as `primary` disabled | as above | n/a |
| `cta` (irreversible only) | `bg-signal text-signal-ink border border-signal-border font-semibold shadow-cta` | `bg-signal-hover shadow-cta-attention -translate-y-px` | `bg-signal scale-[0.98] shadow-cta` | `bg-canvas text-ink-3 border border-hairline shadow-none` **plus a `Tooltip` naming the unmet precondition** | `<Spinner className="text-signal-ink"/>` | **attention** (§8) — only after the acknowledgement checkbox is ticked |

Transition property list:
`transition-[color,background-color,border-color,box-shadow,transform] duration-fast ease-out`.
Minimum hit target 24×24 CSS px.

### Surface — `Card`, `SectionCard`, `StatTile`, `ModeCards`, `FileDropzone`, `EmptyState`

| State | Non-interactive (default) | `interactive` / `selectable` |
|---|---|---|
| Rest | `bg-surface border border-hairline rounded-md shadow-card` | same, plus `.liftable` |
| Hover | no change (banned) | handled by `.liftable` (§6) |
| Active | n/a | handled by `.liftable` |
| Focus-visible | only if focusable | universal ring **and** `.liftable`'s lift |
| Disabled | `opacity-60 pointer-events-none` | same |
| Loading | body → `<Skeleton/>`; border and shadow persist so layout does not jump | same |
| Selected | n/a | `border-accent bg-accent-soft shadow-raised` + `aria-checked`/`aria-selected` set for real |

`.liftable` is opt-in, never a default. A `StatTile`'s accent bar and icon are
`accent`, never `signal`.

### Input — `TextField`, `TextArea`, `Select` trigger, `Combobox` input, `Checkbox`, `FileDropzone`

| State | Utilities |
|---|---|
| Rest | `bg-surface border border-field-border rounded-sm text-sm text-ink-1 placeholder:text-ink-3` |
| Hover | `border-ink-3` (border only) |
| Focus-visible | `border-accent outline-2 outline-accent outline-offset-0` |
| Disabled | `bg-canvas text-ink-3 border-hairline cursor-not-allowed` |
| Loading | `Combobox` only: a "Loading…" row in the popover — never a spinner inside the field |
| Selected | `Checkbox` checked: `bg-accent border-accent` + white check. `Select` item: `bg-accent-soft text-accent-ink` + check |
| Invalid | `border-danger` + `aria-invalid="true"` + helper text `text-danger-ink` |

Label rung: `text-meta uppercase text-ink-2`.

The dropzone is the one input that is also a Surface: rest
`border-1.5 border-dashed border-hairline-strong rounded-md bg-surface`, hover
`border-accent bg-accent-soft`, and it carries `.liftable`.

### Navigation — rail items, `Tabs` triggers, breadcrumb links, `Stepper` nodes, `JobLifecycleSteps` rows

| State | Rail item (dark) | `Tabs` trigger (light) | `Stepper` node |
|---|---|---|---|
| Rest | `text-ink-on-dark-dim bg-transparent` | `text-ink-3 border-b-2 border-transparent` | `border-hairline-strong bg-surface text-ink-3` |
| Hover | `bg-rail-hover text-white` | `text-ink-1 border-hairline-strong` | `border-accent` (only if navigable) |
| Active | `bg-rail-active` | `border-accent/60` | n/a |
| Focus-visible | `outline-accent-on-dark offset-2` | universal | universal |
| Disabled | `text-ink-on-dark-dim/50 pointer-events-none` | `text-ink-3 pointer-events-none` | pending steps are not focusable |
| Loading | n/a | n/a | current step: `<Spinner/>` replaces the numeral |
| Selected | `bg-rail-active text-white font-semibold` + 3px `bg-rail-indicator` left edge | `border-accent text-ink-1 font-semibold` | done: `bg-ok border-ok` + check; current: `bg-accent border-accent scale-[1.09]` + `pulse-ring` |

`ui/Stepper.tsx`'s `StepState` union is `'done' | 'current' | 'awaiting' |
'pending' | 'failed' | 'skipped'`. Every one of those six must map to a distinct
visual — `awaiting` (blocked on the user) and `pending` (not reached yet) are
different facts and may not share a paint.

`components/JobLifecycleSteps.tsx` is **not a row list at all**, and an earlier
revision of this document was wrong to say its rows carry `.hoverable-row`. It
is a thin wrapper around `ui/Stepper.tsx` rendered **horizontally** inside an
`overflow-x-auto` container with a right-edge mask fade, plus one trailing
`InfoTip` held outside the scroll container. Its nodes are therefore governed by
the **`Stepper` node** column of the table above — filled circles and the six
`StepState` paints — not by the Row category. It has no hover affordance today
and needs none: the nodes are not navigable. See §11.3.

### Chip / Badge — `Chip`, `StatusChip`, `ModeBadge`, `ActionBadge`, `TagChips`, `IssueChips`, `TraceLinkChips`, `KbCitationChips`, `WorkItemTypeBadge`

| State | Utilities |
|---|---|
| Rest | `inline-flex rounded-full px-2 py-0.5 text-xs font-semibold` + its semantic `{soft, border, ink}` triple. **Never `shadow-*`.** |
| Hover | only if clickable or tooltipped: `brightness-[0.97] transition-colors duration-instant`. A static chip has no hover state. |
| Active | clickable filter chips only: `scale-[0.97]` |
| Focus-visible | clickable only: universal ring |
| Disabled | `opacity-50` |
| Loading | renders as a `Skeleton` pill of identical geometry |
| Selected | filter chips: `bg-accent text-white border-accent` |

`--color-live` on a chip is permitted only while a stream is actually open. A
terminal status must never be cyan.

### Row — every list, tree, log, and table row

| State | Utilities |
|---|---|
| Rest | `bg-transparent border-t border-hairline` (`border-t-0` on the first row) |
| Hover | `.hoverable-row` (§6). **No lift, no shadow, no scale.** |
| Active | `bg-surface-sunken` |
| Focus-visible | `.hoverable-row`'s rail **plus** the universal ring **inset** (`outline-offset: -2px`) so it is not clipped by the scroll container |
| Disabled | `text-ink-3 cursor-not-allowed`, hover suppressed |
| Loading | `Skeleton` row of identical height |
| Selected | `.hoverable-row[aria-selected='true']`. `aria-selected` is mandatory — colour alone may not carry selection. |

---

## §8 — Motion contract

Five named roles. Every animation in the app is exactly one of them. A new
`@keyframes` requires a new row here.

| Role | Meaning | Duration | Easing | Permitted properties | Banned |
|---|---|---|---|---|---|
| **Entrance** | An element that did not exist now exists | `--duration-base` (190ms). List stagger +24ms/item, capped at 8 items, remainder at delay 0. | `--ease-out` | `opacity`, `translateY(≤4px)`, `scale(0.97→1)` | On anything already on screen. On whole-page route change. On virtualised rows during scroll-recycle (first mount only). More than one nesting level animating at once. |
| **Exit** | An element ceases to exist | `--duration-exit` (120ms) — always shorter than its entrance | `--ease-in` | `opacity`, `scale(1→0.97)`, `translateY(≤4px)` | On unmount without user intent (an SSE data replacement is not an exit). On list items removed by a filter change — those disappear instantly. |
| **State-change** | The same element becomes different | `--duration-instant` (colour-only) / `--duration-fast` (colour + shadow + press + `.liftable` + `.hoverable-row`) / `--duration-slow` (layout) / `--duration-progress` (determinate bar width) | `--ease-out` (pointer-driven) / `--ease-in-out` (layout) | `color`, `background-color`, `border-color`, `box-shadow`, `opacity`, `translateY(≤2px)`, `scaleY` on the row rail, `scale(0.97–1.09)`, `width` / `height` / `grid-template-rows` for disclosure | On a virtual-scrolled row's background. On any unenumerated property. Via bare `transition`. Never `filter` / `backdrop-filter`. |
| **Ambient / live** | Something is genuinely happening on a server right now | `--duration-ambient` (shimmer, indeterminate), `2600ms` (`pulse-ring`), `1.1s` (typedot), `0.7s` (spin) | `--ease-linear` (spin, shimmer) / `--ease-in-out` (typedot, indeterminate, `pulse-ring`) | `translateX`, `rotate` (Spinner only), `scale`, `opacity`, `background-position`, `box-shadow` (`pulse-ring` only) | **Whenever nothing is actually in flight** — an outliving spinner or shimmer is a correctness bug. No ambient decoration: no idle pulsing, no breathing outside Attention. |
| **Attention** | The app is blocked on an irreversible human decision | `--duration-breathe` (2600ms), infinite | `--ease-in-out` | `box-shadow` only — `--shadow-cta` ↔ `--shadow-cta-attention` | Everywhere except the confirm-to-ADO CTA post-acknowledgement. Never more than one element at a time. Never on reversible-destructive actions (delete, cancel). Never on a toast. |

Existing keyframes, mapped: `fadeIn` / `dialogIn` / `listItemIn` / `popIn` →
Entrance. `fadeOut` / `dialogOut` / `popOut` → Exit. `shimmer` / `spin` /
`typedot` / `indeterminate-progress` / `pulse-ring` → Ambient. `ctaBreathe` →
Attention. `animate-pulse` (Tailwind's builtin) is removed — it double-animates
alongside the inline `shimmer`.

`popIn` / `popOut` are `dialogIn` / `dialogOut`'s scale-only counterparts for
Radix-anchored popovers, which carry their own `translate()` from Radix's popper
positioning; reusing the dialog keyframes would fight that transform.

**`pulse-ring` needs room.** The current-lifecycle-step ring animates *outside*
its own box. Its container must not clip it — `overflow: visible` on the card
that holds it, and enough padding on the row that the expanded ring does not
collide with a neighbour. A flattened ring reads as a rendering bug.

### §8.1 — Reduced motion

The `@layer base` kill-switch (`0.001ms !important` on `animation-duration` and
`transition-duration`, `animation-iteration-count: 1`) is retained and
normative, plus three clauses:

1. **`transition-duration` is clamped, `transition-property` is not** — a
   `-translate-y-px` hover would still apply instantly. All lift routes through
   `.liftable`, whose reduced-motion block (§6.1) zeroes the transform outright,
   so "no motion" means no displacement rather than instant displacement.
2. **Attention has a non-motion fallback.** Freezing `ctaBreathe` at an
   arbitrary point in its cycle would leave the confirm-to-ADO CTA looking like
   its rest state as often as its attention state. Under reduced motion it
   renders a static `--shadow-cta-attention` plus a persistent
   `ring-2 ring-signal-border`. The one element the whole product hinges on may
   never silently degrade to nothing.
3. **Ambient loops keep `iteration-count: 1`,** so a `Spinner` freezes. A frozen
   spinner must therefore always be paired with `aria-busy` and visible text,
   never `aria-hidden` alone. The same applies to the running-job pulse: the
   phase headline and the meta line's freshness stamp carry the liveness claim
   in text, so the pulse is decoration on top of a fact, not the fact itself.

---

## §9 — Elevation semantics

Each tier has exactly one meaning. Using a tier for any other reason is a defect.

| Tier | Meaning |
|---|---|
| `shadow-sm` | Rest state of a flat interactive control (input, non-elevated chip-button, file-type affordance), and `.liftable`'s pressed state |
| `shadow-card` | Rest state of a surface sitting above canvas (Card, StatTile, SectionCard, the ETA card) |
| `shadow-raised` | That same surface, lifted because a pointer is over it or it is focused — i.e. `.liftable:hover` / `:focus-visible` |
| `shadow-popover` | A floating, anchored surface (Select / Combobox / DropdownMenu popover, Tooltip) |
| `shadow-dialog` | A floating, modal surface that blocks the page (Dialog, ConfirmDialog, the item-detail panel) |
| `shadow-cta` / `shadow-cta-attention` | The confirm-to-ADO CTA's rest / attention states — nowhere else |

No shadow on any element smaller than 24px in either dimension. No shadow on
chips, badges, inputs, or table rows.

---

## §10 — Iconography

**`lucide-react` is the default icon source.** Do not hand-author inline SVG, do
not add a *third* icon package, do not adopt the mockup's custom symbol set (see
§0.1). Every symbol in §10.1 resolves to a `lucide-react` export.

**`react-bootstrap-icons` is a second, deliberately-scoped source — it is in
use and stays.** A previous revision of this document asserted it was an unused
dependency that "must be removed in the same PR that next touches icon usage."
That was factually wrong and the instruction is withdrawn. Two components import
it today, both with a stated rationale in the code:

| File | Imports | Why not lucide |
|---|---|---|
| `components/FileTypeIcon.tsx:1` | `FiletypeDoc`, `FiletypeDocx`, `FiletypeMd`, `FiletypePdf`, `FiletypeTxt`, `FiletypeXls`, `FiletypeXlsx` | Bootstrap ships a *distinct pictogram per extension* (a "W" mark for docx, a grid for xlsx). Lucide has no `filetype-*` family, so the lucide version was one generic file glyph recoloured seven ways — undifferentiated at a glance, which is the exact complaint the current code replaced. The file carries this reasoning as a comment; read it before changing it. |
| `components/WorkItemTypeBadge.tsx:1` | `Award`, `Trophy`, `ListCheck`, `Circle` | Mirrors Azure DevOps' own work-item-type marks. |

**The scope rule:** `react-bootstrap-icons` is permitted **only** for
file-type glyphs and ADO work-item-type marks — i.e. only inside those two
components. Everything else is `lucide-react`. Reaching for a Bootstrap glyph
anywhere else is an §17 change, not a judgement call.

Three permitted sizes: `h-3.5` (inline with `text-xs` / `text-meta`), `h-4`
(default, inline with `text-sm`), `h-5` (headers, empty states). Default
`strokeWidth={1.75}`, or `2` where a component needs legibility at `h-3.5`.

Icons never animate on hover. An icon's colour may change with state; its
geometry may not.

### §10.1 — Mockup symbol → `lucide-react` export

Every symbol the design pass invented, mapped to the real import. The right-hand
column is what you type. Names marked **in use** already appear somewhere in
`frontend/src`; prefer them over synonyms so the codebase stays consistent.

| Mockup symbol | Meaning in the mockup | `lucide-react` export | Notes |
|---|---|---|---|
| `i-upload` | Drop / browse for a document | `Upload` | **in use** |
| `i-doc` | A document, a file, the Wiki nav item | `FileText` | **in use** |
| `i-blocks` | Blocks stat tile (paragraphs, list items, table rows) | `LayoutGrid` | Four squares. `Blocks` also exists but reads as toy bricks. |
| `i-sections` | Sections stat tile, document-map header, provenance | `AlignLeft` | Three decreasing rules — the same glyph the mockup drew. |
| `i-figure` | Figures stat tile, figure rows, figure thumbnails | `Image` | **in use** |
| `i-depth` | Depth stat tile (deepest heading nesting) | `Layers` | |
| `i-pulse` | Job is running; the Start-job button | `Activity` | |
| `i-check` | Completed step, done state, passing verdict | `Check` | **in use** |
| `i-terminal` | — | **none** | Withdrawn. It headed the activity-log card, which was superseded before it was built (§11.3). Do not introduce it. |
| `i-chat` | Chat panel header | `MessageSquareText` | **in use** — prefer over `MessageSquare`. |
| `i-stop` | Stop a streaming reply | `Square` | **in use**, rendered `fill-current`. |
| `i-chip` | Model selector; Settings nav item | `Cpu` | Use for the model selector. Settings nav keeps its existing icon. |
| `i-alert` | Parse warnings, active flags, "worth knowing" header | `TriangleAlert` | **in use** — this repo uses the new name, not the `AlertTriangle` alias. |
| `i-spark` | SURVEY mode mark; "suggest a better title" | `Sparkles` | **in use** |
| `i-target` | Dedup check; Requirement work-item mark; "make it testable" | `Target` | |
| `i-flag` | Starting state; missing-rationale prompt | `Flag` | |
| `i-pencil` | Edit item, edit text | `Pencil` | **in use** |
| `i-send` | Send a chat turn | `SendHorizontal` | **in use** |
| `i-refresh` | Replace document; "markdown becomes ADO HTML" note | `RefreshCw` | **in use** |
| `i-arrow` | Next step, breadcrumb separator | `ArrowRight` | |
| `i-link` | Relationships, trace links | `Link2` | **in use** |
| `i-tag` | Classification chips | `Tag` | |
| `i-folder` | KB / SharePoint folder | `Folder` | **in use** — this is a *folder in the knowledge base*, not the ADO team project. The two were conflated in an earlier revision; see `i-project` below. |
| `i-project` | Team project, destination, the Jobs nav item | `Briefcase` | **in use** — `components/DestinationBar.tsx:1`, `components/AppShell.tsx:3` (Jobs nav), `pages/JobsList.tsx:3`. This, not `Folder`, is the project/destination glyph. Use it anywhere a destination is named. |
| `i-clock` | Run time, iteration path | `Clock` | |
| `i-list` | BASELINE mode mark; `.md` file type | `List` | |
| `i-close` | Close the detail panel | `X` | **in use** |
| `i-plus` | Add child item; "will be created" | `Plus` | **in use** |
| `i-lock` | Nothing written yet; the Write step | `Lock` | |
| `i-book` | Knowledge base | `Book` | |
| `i-route` | ADO path preview; the Lifecycle card header | `Route` | |
| `i-gauge` | Quality group; judged-against provenance | `Gauge` | |
| `i-tree` | Area path, Epic mark, hierarchy | `Network` | The hierarchy idea. The Jobs nav item is **not** this — it is `Briefcase` (`i-project`). |
| — | Knowledge-base file tree | `FolderTree` | **in use — one site only**: `pages/KnowledgeBase.tsx:3`. An earlier revision claimed it was in use for the diff tree and the Jobs nav item; it is used by neither. The diff tree (`components/DiffTree.tsx`) uses per-row disclosure chevrons, not a tree glyph. |
| `i-sun` / `i-moon` | — | **none** | Mockup-document chrome only. The product has no theme toggle (§16.18). |

**Missing but load-bearing.** These carry real meaning in shipped code and were
absent from the table above, which meant a designer reading only this document
would have invented substitutes for glyphs that already have an answer.

| Meaning | `lucide-react` export | Where |
|---|---|---|
| Disclosure — expanded / collapsed | `ChevronDown` / `ChevronRight` | **in use, and the app's single most-used pair** (9 and 8 sites). `CollapsibleWarnings.tsx:3`, `FigureDescriptions.tsx`, `SectionResults.tsx:2`, `ProgressBanner.tsx`, `NodeDetailDialog.tsx:2`. Down = open, right = closed. Never rotate one glyph with a transform (§10: icon geometry does not animate) — swap the element. |
| Step / list item not yet reached | `Circle` | **in use** — `ProgressBanner.tsx`'s `SectionStepList`, at `text-ink-3/50`. The "pending" counterpart to `Check`. |
| Neutral explanatory note | `Info` | **in use** — the `other` warning taxonomy in `CollapsibleWarnings.tsx:3`; general non-risk notices. Not `TriangleAlert`, which asserts risk. |
| Content the parser read but the model may have dropped | `FileSearch` | **in use** — `CollapsibleWarnings.tsx:3`, for both the `dropped-block` and `external-reference` taxonomies. |
| Prev / next through a filtered list | `ChevronUp` / `ChevronDown` | **in use** — `NodeDetailDialog.tsx:2`'s stacked header pager. |

---

## §11 — Screen specifications

These four screens are the design pass's structural output. Each entry names the
real files that implement it. Where a section says a thing "changes," it changes
relative to what is on `main` today.

### §11.1 — New Job, step 1: Upload

**Files:** `pages/NewJobWizard.tsx` (`step === 1` branch),
`components/FileDropzone.tsx`, `ui/StatTile.tsx`, `ui/Stepper.tsx`.

**The problem being fixed.** Step 1 was a short vertical stack floating in a
full-viewport column, so the page read as mostly empty and capping the width
only moved the void around. And four bare totals (`682 · 24 · 39 · 4`) never
answered the question a reviewer actually has, which is *what did the parser
actually read?* **Built (§18).**

**The structure.** A **two-pane split that owns the viewport by construction.**
Both panes want vertical space, so none is left over.

```
┌─ PageHeader "New job" ────────────────── Stepper (1 of 2) ─┐
├───────────────────────────┬───────────────────────────────┤
│ LEFT  (grows)             │ RIGHT (fixed-ish)             │
│                           │  ┌──────────┬──────────┐      │
│  no file yet:             │  │ Blocks   │ Sections │      │
│    ┌───────────────────┐  │  ├──────────┼──────────┤      │
│    │   dropzone,       │  │  │ Figures  │ Depth    │      │
│    │   flex:1          │  │  └──────────┴──────────┘      │
│    └───────────────────┘  │  ┌───────────────────────┐    │
│                           │  │ Worth knowing before  │    │
│  parsed:                  │  │ you run it            │    │
│    file identity row      │  │  · note rows          │    │
│    ─────────────────────  │  └───────────────────────┘    │
│    Document map           │                               │
│    §n · bar · n · figs    │  safety line ──── [Configure] │
│    (scrolls, flex:1)      │                               │
└───────────────────────────┴───────────────────────────────┘
```

**Left pane** is the dropzone before a file lands and the **document map** after
it. The map is the honest answer to "what did it read": one `.hoverable-row` per
section, four columns — `§n` clause number (`font-mono text-meta text-ink-3`),
section title (`text-xs text-ink-2`, truncated), a relative block-count bar
(`h-[7px] rounded-full bg-surface-sunken`, fill `bg-accent` at 72% opacity so it
reads as data rather than as a control), the block count (`font-mono
tabular-nums`), and a figure count with an `Image` icon, dimmed to 28% opacity
when zero. Above the map sits the file identity row: filename and a `font-mono
text-meta` line, with a `Replace` outline button pinned right. **Built (§18),
with one real data gap:** the meta line originally specified "size, parse
duration, and section count" — parse duration is not tracked anywhere in this
stack (no timestamp captured around the `/ingest` call, nothing on `Job`) and
was not fabricated to fill the gap; shipped as size + section count. No
file-type badge either — `FileTypeIcon` (already used elsewhere in this same
row) covers that signal without a second, redundant badge chip.

**Right pane** is the parse readout, in a real two-pane grid alongside the
left pane now (not pinned to a literal floor via `margin-top: auto` inside
its own column — the Next Step button sits at the bottom of the right
column's own flex stack, which reads the same in practice). Four `StatTile`s
in a 2×2 grid, **built (§18)**, each carrying:

- an **icon** in the tile's eyebrow row, `h-3.5` in `--color-accent`, per §10.1;
- a **one-line meaning** below the numeral, `text-xs text-ink-3` — "Paragraphs,
  list items and table rows." / "Heading-level groups." / "Images the vision
  model will describe." / "Deepest heading nesting found."

This is a deliberate reversal of "explain it in a tooltip." A number a reviewer
must hover to understand is a number they will misread. `StatTile`'s props grew
accordingly: `icon?: LucideIcon` and `hint?: ReactNode`, alongside the existing
`value` / `label` / `accent` / `tone` / `interactive`. All four tiles carry
`.liftable` (built, §6/§18).

Below the tiles, a **"Worth knowing before you run it"** card, **built (§18)
with one presentational simplification**: a plain icon+sentence list rather
than `.hoverable-row` rows (nothing in this card is clickable or navigable,
unlike the document map's rows, so the hover affordance `.hoverable-row`
implies would be a fake one — DESIGN.md §12's own rule against implying an
action that does nothing). The load-bearing fact renders `font-semibold
text-ink-1`, the explanation `text-ink-2`, matching the spec. These are real
derived facts, not raw counts or invented risk — exactly 3 possible notes,
each only when its underlying count is nonzero: table count ("N tables
detected. Every row counts as its own block..."), figure count ("N figures
found. Survey mode describes each one with a separate vision-model call..."),
and open-TBD placeholder count, which carries real risk and is the one note
using `TriangleAlert`/`--color-warning`; the other two use a neutral `ink-3`
glyph. The card never renders empty: with no file it shows the exact copy
this paragraph specifies, "Drop a document and this fills with what the
parser found in it" (a plain conditional render, not a literal `EmptyState`
component — same visual result).

**Placeholders read as `--`, never as `0`.** A zero claims a real, confirmed
answer. `StatTile` renders `--` in `tone="dim"` while `parseStatus` is
`'idle'` or `'parsing'`. This is already the behaviour in `NewJobWizard.tsx`
(`preview?.blockCount ?? '--'`) and it is now normative.

**Footer.** Built, with one deliberate naming deviation: the primary button
stays labelled **Next Step**, not renamed to **Configure**. This step's real
action is "advance to the next screen" — destination/mode configuration
genuinely lives on step 2, so relabeling it to match this section's mockup
would describe a capability the button doesn't have in this app's real
two-step IA. No separate "§0.3 safety line" was added — that section doesn't
exist in this document (a dangling cross-reference, not a built-or-not
question); the button's own disabled state (`disabled={!preview}`) already
gates on the same precondition a safety line would have named.

### §11.2 — New Job, step 2: Configure

**Files:** `pages/NewJobWizard.tsx` (`step === 2` branch),
`components/ModeCards.tsx`, `utils/eta.ts`.

**The problem being fixed.** The step read as a two-column form, which made the
mode choice — the one decision that changes both the output shape and the run
time by an order of magnitude — look the same size as picking an iteration path.

**The structure.** Not a form. A decision with three parts, stacked, each under
its own question heading:

1. **"How should it read the document?"** — the hero.
2. **"Where do the items land?"** — an ADO path, read left to right.
3. The cost, as a calibrated range.

A thin **document strip** runs above all three: file icon, filename, a
`font-mono` summary (`682 blocks · 24 sections · 39 figures · depth 4`), and a
ghost `Change document` button. It carries step 1's answer forward so the
reviewer never has to go back to check it.

#### §11.2.1 — Mode as hero

`ModeCards` stays a `role="radiogroup"` of two stacked cards, each `.liftable`
with `aria-checked` driving the accent border. Each card gains a **live output
preview** — the same source clause, rendered the way that mode would write it
into ADO, under a `sample-cap` eyebrow reading "What lands in Azure DevOps":

- **BASELINE** shows the clause verbatim, mono, clause number and all —
  demonstrating "the document is the requirement set."
- **SURVEY** shows a synthesized title, rewritten requirement prose, and a
  `font-mono text-meta` provenance line (`quality 82 · well-formed · from
  §3.2.1`) — demonstrating what distillation actually produces. `well-formed`
  is deliberate, not a placeholder: see §11.4.3 for why no requirement-writing
  standard's name (or its acronym) ever appears in product copy, including here.

This is the single highest-value change on the screen: the difference between
the two modes is a *shape* difference, and no amount of description copy
communicates it as fast as showing both shapes.

Each card ends with a cost row: a `Clock` icon plus the mode's time range, and a
model-cost chip (`ok` "No model cost" for BASELINE, `warning` "Uses your model
quota" for SURVEY). **The SURVEY model picker lives inside the SURVEY card,** not
in a separate Options box — an option that only applies to one mode belongs to
that mode. It is labelled `Model`, uses the `Cpu` glyph, and carries the hint
"Fetched live from the LLM backend. Change it only if you know why."

#### §11.2.2 — Destination as a breadcrumb, not a field stack

The four destination inputs (team project, area path, iteration path, starting
state) become a single horizontal **path bar** of `.hoverable-row` segments,
each showing an uppercase `text-micro` key with its icon and the chosen value
beneath. Read left to right, it mirrors how Azure DevOps itself reads.

**Extend `components/DestinationBar.tsx` — do not build this fresh.** The
component already exists (35 lines) and already implements most of the idea: a
bordered `bg-surface-alt` strip, a `Briefcase` glyph in `--color-accent`, a
`text-micro uppercase` key, the team project in `text-ink-1`, a `›` separator,
the area path in `font-mono text-xs` (the §0.1 identifier rule, already
honoured), and an `InfoTip` explaining that reuse-matching is scoped to that
exact area path. Its own header comment says it was written to be shared by
**both** the wizard and `JobDetail` — but it is currently rendered at exactly
one site, `pages/JobDetail.tsx:737`, and the wizard never imports it. That is
the gap to close.

**Built (§18), single shared implementation preserved** — the wizard's
Destination card and `JobDetail.tsx` both render the same `DestinationBar`,
not independent copies.

- The area-path segment's value is `font-mono` (§0.1, identifier rule).
- The **optional** iteration segment, when unset, renders hatched rather than
  blank — a repeating-gradient fill in `accent-soft`/`accent-soft-border` — so
  an optional gap does not read as a missing answer.
- Directly beneath, a **path preview** strip restates the resolved destination
  as one `font-mono` string (`Radar Systems \ Radar Systems\EW Suite \ Rev C ·
  state Proposed`). *Shipped without the one-sentence-of-consequence clause
  this paragraph originally specified* ("Proposed keeps new items out of
  sprint metrics...") — starting state is fetched live per-project from ADO's
  own configurable workflow (`StatePicker.tsx`/`getStates`), an open,
  org-defined list, not a small fixed enum a sentence could safely be written
  for. A destination the reviewer cannot read back is a destination they
  cannot check; that part is built.

#### §11.2.3 — The estimate: measured, not guessed, and still uncapped

**This is a hard rule. Read all of it before changing anything about the ETA.**

`frontend/src/utils/eta.ts` computes **today**:

```
BASELINE: 1 minute, flat
SURVEY:   max(15, 15 + blockCount * 0.5) minutes   — floor only, NO ceiling
```

The 40-minute ceiling that used to sit on the SURVEY branch was **deliberately
removed on 2026-08-05** (`docs/ui-progress-review.md` §1), and that removal
stands. For this product's stated target case — 500+ page documents — a capped
estimate is not imprecision, it is misdirection: an engineer who expects 40
minutes and is still waiting three hours later will cancel a job that was
working correctly the whole time. **Underselling wait time is worse than
overselling it.** The presentation may soften how the number *reads*. It may
never change what the number *is*.

What changes in this revision is **where the number comes from**. It is no
longer a hand-picked formula. It is a least-squares fit over this deployment's
own completed SURVEY runs, blended against a conservative default while there
is not yet enough real data to fit anything. The no-cap rule is untouched.

##### §11.2.3.a — Why the hand-picked formula was reversed, and why it is not being re-tuned

The previous revision of this section specified a static linear formula with
hand-picked coefficients — `raw = 15 + blockCount×0.5 + figureCount×2.0`, then
a `0.85×–1.3×` model multiplier parsed out of the model *name*. Against the
same 682-block / 39-figure document this document uses throughout, it predicted
**434 minutes** on an unknown model and **564 minutes** on `qwen2.5:32b`.

That document is `AirPro_BP_ICD_Revision_0.3.docx`. It really ran, in SURVEY
mode. It **really completed in about 90 minutes.** The formula was wrong by
roughly **5×**, in the intimidating direction.

This is the *second* time a hand-picked constant in this section has been shown
wrong against reality — the first was an audit finding that the mockup's own
displayed placeholder numbers did not match the output of the formula the same
mockup claimed to implement. Two independent falsifications of the same
technique is enough evidence about the technique, not about the constants.
**Therefore this revision does not pick a third set of coefficients from a
single data point.** Fitting `0.5` down to `0.13` because one document came in
at 90 minutes would be exactly the same mistake with a better-looking number:
one observation, no error bars, presented to the user as though it were
knowledge.

The system already has the only thing that can settle this — it runs the real
pipeline, on real documents, and records when each run started and finished.
What it does not do is **write down what the document was**. That is the whole
gap, and §11.2.3.b closes it.

**The name-parsed model multiplier is removed outright**, not re-tuned.
`MODEL_SIZE_PATTERN`, `MODEL_SIZE_SMALL_MAX_B`, `MODEL_SIZE_LARGE_MIN_B`,
`MODEL_SPEED_MULTIPLIERS` and `modelSpeedMultiplier()` are all superseded. The
argument that killed them was already sitting in the previous revision's own
justification: `qwen3:4b` parses as `small` and would earn `0.85×`, and
`llm-client.interface.ts:53-59` records it producing **40+ minute calls**. A
heuristic whose own supporting evidence includes a counterexample is not a
signal. Guessing a model's speed from the characters in its name is strictly
worse than observing how long that model actually took (§11.2.3.d), and
strictly worse than a neutral `1.0×` when it has never been observed at all.

##### §11.2.3.b — What the `Job` row must persist, and where

**Nothing about a job's size is written down today.** Verified, not assumed:
`orchestrator/prisma/schema.prisma`'s `Job` model has no `blockCount`, no
`figureCount` and no `model` column; `blockCount`/`figureCount` are computed
transiently in `jobs.controller.ts`'s `preview()` handler and thrown away with
the HTTP response; and `SubmitJobInput.model` carries a comment
(`jobs.service.ts:43`) that says so in as many words — *"Per-job LLM model
override (SURVEY only). Not persisted on the Job row."* A duration can be
computed for a finished job; nothing correlates it with what was processed.

**Five new nullable columns on `Job`.** All nullable, following the same
convention `userId`, `warnings` and `figureDescriptions` already use in this
model — historical rows predate the column and must keep loading, so the
absence of a value is data ("this job is not a usable sample"), never an error.

```prisma
// Document size as measured by ingestion's own parse, persisted so a
// finished job can be used as a real training sample for the wizard's
// ETA (§11.2.3.c) -- previously these were computed for /jobs/preview's
// response and thrown away, leaving no way to correlate a job's actual
// duration with what it actually processed. Written by pipeline.worker.ts
// from the SAME CanonicalDoc the pipeline goes on to level, never from a
// client-supplied number. Nullable: historical jobs predate this column,
// same convention as warnings/userId/figureDescriptions.
blockCount   Int?
figureCount  Int?
// The EFFECTIVE model this job ran under -- job.model ?? the orchestrator's
// configured default, i.e. the value pipeline.worker.ts already resolves at
// its `const model = job.model ?? deps.defaultLlmModel` line, not the
// possibly-empty per-job override. The override alone would record `null`
// for every job that used the default and make the largest, most useful
// cohort invisible to the per-model adjustment. Always null for BASELINE,
// which runs no model at all. Nullable: historical jobs predate this column.
model        String?
// Real pipeline wall-clock boundaries, in the ONE interval the wizard's
// estimate actually predicts: from the worker picking the job up to the
// diff being ready for review. Deliberately NOT createdAt -> completedAt --
// see §11.2.3.b's "what interval" note; completedAt is set only by
// confirm(), so that span includes unbounded human review time.
startedAt    DateTime?
diffReadyAt  DateTime?
```

**Where they are written: the pipeline worker, not the submit handler.** The
brief for this section assumed job-creation time. That is the wrong place, and
the code says why:

- **At submit, the counts are not in hand.** `JobsController.submit()` receives
  a file buffer and form fields. It has no block or figure count. It could
  accept them from the client — the wizard *did* call `/jobs/preview` a moment
  earlier — but those numbers would then be client-supplied and unverified,
  attached to a file the server never re-checked. A user could submit document
  A with document B's counts, or any number at all, and poison the fit for
  every other user. The alternative, having `submit()` call
  `ingestionClient.ingest()` itself, buys trustworthiness by paying a full
  parse — including figure extraction on a large PDF — synchronously inside
  the upload request, and then paying it *again* in the worker.
- **At the worker, they are already there, for free.** `pipeline.worker.ts`
  already awaits `deps.ingestionClient.ingest(...)` and holds the resulting
  `doc`; it already reads `doc.figures` to build `figureDescriptions`.
  `doc.blocks.length` and `doc.figures.length` are two property reads on an
  object it has anyway. It already resolves the effective model at
  `const model = job.model ?? deps.defaultLlmModel`. And it already issues a
  `prisma.job.update` at the `status: 'running'` transition and another at the
  `status: 'diff_ready'` transition — the exact two moments the timestamps
  belong to. **The entire change is added fields on updates that already
  happen. No new query, no new parse, no new round trip.**

So: `startedAt` **and `model`** join the `{ status: 'running' }` update;
`blockCount`, `figureCount` and `diffReadyAt` join the `{ status: 'diff_ready',
… }` update that already writes `warnings`, `kbCitations` and
`figureDescriptions`. **`model` is deliberately written at `running`, not
`diff_ready`** — this deviates from an earlier draft of this section, which
put it at `diff_ready` alongside the other three. A job that fails mid-`/level`
(the longest, most failure-prone stage) never reaches `diff_ready` at all, so
that placement would leave every such job's `model` permanently null — and a
later resubmit of exactly that job (the one a user is most likely to want to
resubmit) would silently drop the override it's supposed to preserve. Both
`job.model` and `deps.defaultLlmModel` are already in scope at the earlier
`running` transition, so moving the write costs nothing. See §18's ledger for
the closed-migration record of this deviation.

**What interval — and why `completedAt` is the wrong end of it.** This is the
single most important correction in this section, and it invalidates the
obvious implementation. `Job.completedAt` is set in **exactly one place** —
`jobs.service.ts:1201`, inside `confirm()`, alongside `confirmedAt` — a fact
`job-retention.service.ts:16` already states in its own comment
(*"`completedAt` is only ever set on confirm()"*). `confirm()` runs when a
**human clicks approve**, after reading the diff. `completedAt - createdAt`
therefore measures *pipeline time + however long the reviewer took*, and a
reviewer may take three minutes or three days. Fitting a document-size
regression on that quantity would be fitting human lunch breaks. It would also
be systematically biased upward, which the range presentation would then
faithfully render as a confident, terrible number.

The interval the wizard's card is actually promising is **"how long until I can
review this"** — submit to `diff_ready`. Hence `diffReadyAt`.

`startedAt` is separate from `createdAt` for the matching reason at the other
end: a job sits in BullMQ until a worker frees up, and queue wait scales with
*system load*, not with the document. Fitting on `diffReadyAt - startedAt`
models the work; `startedAt - createdAt` is a real part of the user's wait but
belongs to a different question (queue depth), and folding it in would smear
load noise into coefficients that are supposed to describe documents. Note this
honestly rather than hiding it: on today's single-user deployment queue wait is
effectively zero, so the two definitions currently agree; if that stops being
true, the card gains a queue term, it does not quietly redefine this one.

**Sample eligibility is `diffReadyAt IS NOT NULL`, not `status = 'succeeded'`.**
A second correction with real consequences. Because `succeeded` is only ever
reached through `confirm()`, filtering on it would discard every job whose diff
was **rejected** — even though that job ran the full pipeline and produced a
perfectly valid duration measurement. Rejection is a judgement about the
*output*, not about how long the machine took. Excluding those runs would throw
away real samples in a system that has almost none, and would bias the
remaining set toward documents the model happened to handle well.

**One live bug this exposes, worth fixing alongside:** `JobsService.resubmit()`
reconstructs a `submit()` call from the stored `Job` row and **does not pass
`model`** — the field is simply absent from its argument object. A resubmitted
job therefore silently reverts to the default model, which is a bug today
(before any of this) and becomes a data-integrity bug afterwards, since the
`Job` row would record a model the user did not choose. Once `model` is
persisted, `resubmit()` has the value available and must pass it through. This
is a real defect found while verifying this section, not a consequence of it.

##### §11.2.3.c — The computation: ordinary least squares, shrunk toward a conservative default

This stays a **pure, deterministic computation.** No LLM is asked to guess a
duration. It is a database aggregation followed by arithmetic that fits in a
screen, and it is fully specified here.

**Sample set.** SURVEY jobs only (BASELINE has no estimate to fit — §11.2.3.e),
with `diffReadyAt` and `startedAt` both non-null and `blockCount` and
`figureCount` both non-null, ordered newest first, limited by **both** a
trailing window of `ETA_WINDOW_DAYS = 90` **and** a cap of
`ETA_WINDOW_MAX_SAMPLES = 50` — whichever admits fewer rows.

*Why 90 days:* infrastructure moves. A GPU swap, an Ollama upgrade, a different
default model — each invalidates older timings, and none of them announces
itself to this code. A quarter is long enough for a low-volume deployment (this
one) to accumulate a usable `n`, and short enough that last year's hardware
stops anchoring today's estimate. Old data **fades**; it is never permanently
authoritative. *Why the 50-cap on top:* one busy week must not outvote the
three quieter months around it.

A consequence to accept rather than engineer around: if the deployment goes
quiet for a quarter, `n` decays back toward zero and the estimate drifts back
to the conservative default. That is correct — a stale fit is worse than an
admitted absence of data — and the shrinkage below makes it a slope, not a
cliff.

**The fit.** For each sample `i`, let `y_i` be the observed duration in minutes
(`(diffReadyAt - startedAt) / 60000`), `b_i` its block count, `f_i` its figure
count. Fit

```
y ≈ a + β·b + γ·f
```

by ordinary least squares. With three unknowns this is one 3×3 linear system —
the normal equations `(XᵀX)·θ = Xᵀy`, written out in full:

```
| n     Σb     Σf   |   | a |     | Σy   |
| Σb    Σb²    Σbf  | · | β |  =  | Σby  |
| Σf    Σbf    Σf²  |   | γ |     | Σfy  |
```

Six sums and three cross-sums, accumulated in a single pass over the rows, then
a 3×3 solve by Cramer's rule or plain Gaussian elimination. **No matrix library,
no ML dependency, no iterative solver.** Any backend engineer can implement this
from the block above in about forty lines.

**Three guards, in order.** OLS on real data can and will produce nonsense here,
and the failure modes are predictable enough to name:

1. **Singular / near-singular system.** If `|det(XᵀX)|` is below a relative
   epsilon, there is no unique solution — every sampled document was
   effectively the same size, or worse, `f` is a near-perfect linear function of
   `b`. That second case is not hypothetical: **bigger documents have more
   figures**, so `b` and `f` will be strongly collinear in almost any real
   sample, and collinear inputs make the individual coefficients wildly
   unstable even when the fit as a whole is fine. Treat the 3-parameter fit as
   unavailable and fall to guard 2.
2. **Any coefficient non-positive** (`β ≤ 0`, `γ ≤ 0`, or `a < 0`). More blocks
   cannot mean less time; a negative intercept is a fit extrapolating through
   the floor. This is the specific pathology small samples produce, and it must
   never reach a user. Fall back to a **two**-parameter fit on a single work
   term: let `u_i = b_i + r·f_i`, where `r` is the figure-to-block ratio the
   bootstrap below itself asserts (`BOOTSTRAP_FIGURE_BLOCK_RATIO`, derived from
   the two constants rather than written out as a literal — Part B moved the
   block weight and deliberately left the figure weight alone, so `r` is no
   longer the 4 this section used to spell out). The *ratio* claim — a figure is
   a separate vision call, a whole round trip on a slower modality — survives
   the reversal of the *scale*. Fit `y ≈ a + μ·u`. A 2×2 solve is far more
   stable under collinearity and is still entirely data-driven.
3. **The 2-parameter fit also degenerate** (`μ ≤ 0`, or fewer than 2 distinct
   `u` values). Then there is no usable fit at all: treat the effective sample
   count as **0** and return the bootstrap unmodified.

**The bootstrap default.** Used alone when `n = 0`, and blended in whenever `n`
is small:

```
bootstrap(b, f) = BOOTSTRAP_BASE_MINUTES
                + b × BOOTSTRAP_MINUTES_PER_BLOCK
                + f × BOOTSTRAP_MINUTES_PER_FIGURE
```

| Constant | Value | Why |
|---|---|---|
| `BOOTSTRAP_BASE_MINUTES` | `10` | Fixed per-run overhead that does not scale with the document: upload, parse, the area-path backfill check, the work-item-type catalog fetch. |
| `BOOTSTRAP_MINUTES_PER_BLOCK` | `0.175` | Calibrated so the one document whose real duration is known lands near it (`0.10`), then re-derived ×1.75 for Part B's three-stage per-branch generation — see the recalibration paragraph below. |
| `BOOTSTRAP_MINUTES_PER_FIGURE` | `0.40` | ~`2.3×` the block weight (it was `4×` before Part B raised the block side alone). The **ratio** is the surviving claim from the previous revision: a text block is one span of an already-batched text pass, a figure is a separate vision-model call. Its current value is *derived* from these two constants, never re-typed. |

Calibration, shown in full so the next session can check it rather than trust
it — the 682-block / 39-figure document that really ran in **~90 minutes**,
under the pre-Part-B pipeline it was measured on:

```
10 + 682×0.10 + 39×0.40  =  10 + 68.2 + 15.6  =  93.8 min
```

93.8 against a real 90 — **4% high**, which is the correct direction to be wrong
(§0.1: underselling is worse than overselling).

**Part B recalibration.** Part B split SURVEY's per-branch generation from one
LLM call into three ordered stages (skeleton → whole-document figure/table
mapping → content authoring), so that same document now costs meaningfully more.
Not 3× more, though: decode — the dominant term — is *split* between stages
rather than repeated, while prefill is paid ~3× and two new document-wide
barriers replace what used to be end-to-end branch parallelism. That works out
to ~1.6×, rounded up to **1.75×** for the barrier effect and for §0.1's
direction-to-be-wrong-in. Hence `0.10 → 0.175`, and the same document projected
forward:

```
10 + 682×0.175 + 39×0.40  =  10 + 119.35 + 15.6  =  145.0 min
```

`BOOTSTRAP_MINUTES_PER_FIGURE` deliberately does **not** move: the per-figure
cost is vision captioning, which happens during parse and which Part B never
touched, and the new mapping stage batches per *branch*, not per figure. That
145 is a projection, not a measurement — the self-tuning fit is what replaces it
with real numbers. No pipeline-version column was added to discriminate pre- and
post-Part-B samples: the 90-day / 50-row window already exists for exactly this
class of regime change, and while post-Part-B samples are few the shrinkage
holds most of the weight on this (now higher) bootstrap, so the transient errs
high rather than low.

**These three constants are explicitly not knowledge.** They are one document's
worth of calibration, wearing the shape of a formula. They must be commented as
such at their definition — *unvalidated, single-observation, used only until
real data exists* — and they are the one thing in this section that a future
revision may adjust without ceremony, because nothing is claimed for them. They
are load-bearing **right now**: the account reset wiped every historical job, so
`n = 0` is the literal current state of this deployment and the bootstrap is
what every user sees until the first SURVEY run finishes.

**The blend.** Never a threshold, never a cliff:

```
w         = n / (n + ETA_SHRINKAGE_K)
estimate  = w × fitted(b, f) + (1 − w) × bootstrap(b, f)
```

with `ETA_SHRINKAGE_K = 8`. *Why 8:* three unknowns need more than three points
to mean anything; at `n = 8` there are five residual degrees of freedom, which
is the point at which a fit stops being an interpolation of its own inputs — and
`n = 8` is also exactly where this blend hands real data half the weight. At
`n = 24` the bootstrap still holds 25%. At `n = 2` it holds 80%, so a
two-sample "regression" cannot move the number much, which is the entire point.
`n` here is the **effective** count after the guards above: a rejected fit
contributes `n = 0`, not a silent pass-through.

**The per-model adjustment.** Once a specific model has real history, compare
what it *did* against what the formula *said*:

```
ratio_m    = mean over that model's samples of ( y_i / estimate(b_i, f_i) )
w_m        = n_m / (n_m + ETA_MODEL_SHRINKAGE_K)
adjusted_m = clamp( w_m × ratio_m + (1 − w_m) × 1.0 , 0.5 , 2.0 )
```

with `ETA_MODEL_SHRINKAGE_K = 5`. *Why 5 and not 8:* this estimates a **single**
scalar, not three, so it earns trust faster — but one lucky run still must not
swing it, and at `n_m = 1` the ratio carries only 1/6 weight. **A model with no
history gets exactly `1.0` — neutral, not a guess.** That is the direct
replacement for the deleted name-parsing heuristic, and it is better in both
directions: it uses observation where observation exists, and it declines to
invent where it does not.

The `[0.5, 2.0]` clamp bounds **one multiplicative input** against a single
pathological sample. It is emphatically **not** a cap on the estimate — §16.21
is intact, the estimate itself has no ceiling, and this bound sits at the same
place in the pipeline (and for the same reason) as the previous revision's
bounded model multiplier.

**The final value:**

```
E = max(SURVEY_MIN_MINUTES, estimate(b, f) × adjusted_m)
```

`SURVEY_MIN_MINUTES = 15` is retained, and the floor is still applied **last**,
so a `0.5×` model adjustment cannot drag a small document below it. There is
still no last operation ceiling, and there never will be.

##### §11.2.3.d — This is a server computation with an API in front of it

**The frontend performs no arithmetic.** It receives numbers and formats them.
This is not a style preference: the sample set is a Postgres aggregate over
every user's jobs, and the browser has neither the rows nor any business
holding them.

Two surfaces, because the wizard needs the number at two different moments:

**1. `POST /jobs/preview` — extended, no new round trip.** It already parses the
file and already returns `blockCount`/`figureCount`; it gains an `estimate`
object computed from those same counts, for the mode and model currently
selected (on first render: SURVEY, model unset).

**2. `GET /jobs/estimate?blockCount=&figureCount=&mode=&model=` — new, cheap.**
The reviewer can change the mode toggle or the model dropdown *after* the file
is parsed, and re-uploading a 40 MB PDF to re-price it would be absurd. This
endpoint takes the already-known counts as query parameters and runs only the
aggregate + arithmetic — no file, no parse. It is the only new route this
section requires.

Both return the same object:

```jsonc
{
  "mode": "survey",
  "estimateMinutes": 145.0,    // E, uncapped
  "lowerMinutes": 108.8,       // E × 0.75, server-applied
  "upperMinutes": 181.3,       // E × 1.25, server-applied
  "basis": "bootstrap",        // "bootstrap" | "blended" | "fitted"
  "sampleCount": 0,            // n, after the §11.2.3.c guards
  "modelSampleCount": 0,       // n_m for the requested model
  "modelAdjustment": 1.0,      // adjusted_m, for the tooltip
  "windowDays": 90
}
```

`basis` is not decoration — it is what the scope chip's copy switches on
(§11.2.3.e), so honesty about provenance is carried in the payload rather than
re-derived in the view. `sampleCount` is reported **after** the guards, so a
rejected fit reports `0` and says `bootstrap`, never `fitted` with a number the
guards threw away.

The range multipliers `0.75` / `1.25` move **server-side** with this change.
They are properties of the estimate's uncertainty, not of its rendering, and
splitting them across the wire was how the previous revision ended up with a
frontend constant nobody could audit against the value it modified.

**Caching:** the aggregate changes only when a job reaches `diff_ready` —
minutes to hours apart. Cache the solved coefficients in memory with a 60-second
TTL so flipping the model dropdown does not re-scan the table per keystroke. The
counts are per-request; only the fit is cached.

**Everything above lives in the orchestrator** (it owns the database). It must
not be reimplemented as a client-side query, a shared package that reaches for
Prisma from the browser bundle, or a duplicate copy of the arithmetic in
`eta.ts` "so the UI can be responsive." `eta.ts` keeps `formatEtaMinutes` and
gains `formatEtaRange`; it loses `computeEtaMinutes` entirely.

##### §11.2.3.e — Presentation

The wizard's cost card shows **the number and its scope. Nothing else.** The
calibrated band, its axis and tick labels, the BASELINE comparison diamond, the
legend and the derivation paragraph specified two revisions ago remain
**removed** — not collapsed, not behind a toggle, not de-emphasised. That
decision was about visual complexity and is independent of where the number
comes from; it survives this revision unchanged. The only thing a reviewer needs
from this card is how long they will be waiting.

**BASELINE stays flat, and stays flat *deliberately*.** `BASELINE_FLAT_MINUTES
= 1`, no fit, no history, no sample query. BASELINE runs **no model at all** —
the fact `ingestion-http.client.ts:11` records ("BASELINE never touches an
LLM") — so it performs no vision call per figure and selects no model. A fit
over figure counts and model names would be modelling work that does not happen.
This is the same reasoning as the previous revision and it is unaffected by the
change in method: the server returns the flat value for `mode=baseline` and
skips the aggregate entirely.

**Permitted (presentation):**

- Render a **range** rather than a single figure, from the server's
  `lowerMinutes` / `upperMinutes`, both passed through `formatEtaMinutes()` so a
  large value reads `1h 57m`, not `117 min`. **This helper does not exist and
  must be written from scratch** — `eta.ts` exports exactly two functions today
  and there is no range helper at any layer. It is now purely a *formatter*:
  `formatEtaRange(lowerMinutes, upperMinutes): { lower: string; upper: string }`,
  taking two server-provided numbers rather than deriving them.
- Frame it with the word "typically" — `1h 10m – 1h 57m` `typically, once it
  starts` — so the number reads as an expectation, not a promise.
- Set the numerals in `text-metric font-mono tabular-nums` and the unit in
  `text-xs text-ink-3`, so the range is calm rather than alarming.
- Show a **scope chip**, and switch its copy on `basis`. The chip can no longer
  claim a fixed rate per block or figure — there is no longer a fixed rate — so
  it names the inputs *and* the evidence behind them:

  | `basis` | Chip copy |
  |---|---|
  | `bootstrap` (`n = 0`) | `SURVEY · 682 blocks, 39 figures · no completed runs yet` |
  | `blended` / `fitted` (`n > 0`) | `SURVEY · 682 blocks, 39 figures · from 12 previous SURVEY runs` |
  | BASELINE, any basis | `BASELINE on 682 blocks · no model runs` |

  The counts stay, because they are still what the number is computed *from*
  and the reviewer must be able to see that a bigger document costs more. What
  is added is `n`, because under this design `n` is the difference between a
  measurement and a placeholder, and the reviewer is entitled to know which one
  they are looking at. The model name **leaves the chip**: it no longer always
  affects the number (`modelAdjustment` is exactly `1.0` for an unobserved
  model), and naming an input that had no effect is the same false attribution
  the BASELINE row has always avoided. It moves into the tip, where its actual
  influence can be stated.

- Give the chip an `InfoTip` that states, in one breath: that the estimate comes
  from this deployment's own completed runs and improves as more finish; that
  with no history yet it falls back to a conservative default; that a figure
  costs more than a block because each is a separate vision call; and that a
  range is shown because a single number this far out would be false precision.
  When `modelSampleCount > 0` it also names the model and its observed
  adjustment. The "why" lives in the hover; it does not disappear, and it does
  not get a paragraph on the card.
- A one-line note under the range **only in the `bootstrap` case** — "the first
  few runs use a conservative default" — because that is the state where the
  number is weakest and the user has no other way to learn it.

**Forbidden:**

- **Clamping the estimate, at any layer.** Not in the orchestrator's
  computation, not in the API response, not in `NewJobWizard.tsx`, not in a
  `Math.min` anywhere between them. A data-driven number can grow arbitrarily
  large for a genuinely enormous document, and that is the number the user gets.
  The removed 40-minute cap is not permitted to return in a new coat because the
  number now has a regression behind it — a fitted value that is then clipped is
  a lie with better provenance. The **only** bounded quantity is
  `adjusted_m ∈ [0.5, 2.0]` (§11.2.3.c), and it is bounded to protect the
  estimate from one bad sample, not the user from a big number.
- **Clamping any single input's contribution independently** — a ceiling on the
  figure term, on the block term, or on `blockCount` before it enters the fit.
  Same failure as the 40-minute cap: a huge document reporting a number a
  smaller document could also produce.
- **Guessing a model's speed class from its name.** No size regex, no substring
  heuristics ("it says `mini`, so it's fast"), no provider-name assumptions, no
  defaulting to fast because most local models are small, and no defaulting to
  slow to be "safe." A model with no observed history is exactly `1.0×`. Neutral
  is the honest answer and it is the only permitted one. This is the same rule
  as the previous revision reached by a better route: it used to be the fallback
  *inside* a name-parsing heuristic; it is now the whole behaviour, because the
  heuristic is gone.
- **Fitting on `completedAt`.** §11.2.3.b. It measures human review latency and
  will look completely reasonable while being wrong.
- **Filtering the sample set on `status = 'succeeded'`.** §11.2.3.b. It silently
  discards every rejected job's perfectly valid duration.
- **Any client-side re-derivation of the estimate**, including a "quick local
  approximation while the request is in flight." Show the previous value, or
  show nothing. Two formulas is how the last one drifted from its own mockup.
- **A band, axis, tick scale, comparison marker, or legend on the cost card.**
  The apparatus is gone and the fixed-axis rule that governed it went with it.
  Do not re-derive a chart from this section's history; a future revision that
  wants one argues for it from scratch.
- **Hardcoded time strings anywhere in the UI.** Unchanged by this revision and
  still a live bug — it is a *separate* defect from where the number comes from,
  and it is **wider than one file**. Every site below states a time figure that
  no formula produced, and five still carry the *removed* 40-minute cap:

  | Site | String, verbatim | Problem |
  |---|---|---|
  | `components/ModeCards.tsx:11` | `estimate: '≈ 3–5 min · no model cost'` | Contradicts `BASELINE_FLAT_MINUTES = 1`. |
  | `components/ModeCards.tsx:15` | `description: '… 15-40+ min on real documents.'` | Dead cap, in the mode picker's own body copy. |
  | `components/ModeCards.tsx:16` | `estimate: '≈ 15–40 min · uses your model quota'` | Dead cap, on the very control the reviewer uses to choose. |
  | `pages/NewJobWizard.tsx:312` | `Alert`: `'SURVEY mode can run 15-40+ minutes depending on document size.'` | Dead cap, shown the instant SURVEY is selected. |
  | `pages/NewJobWizard.tsx:347` | `InfoTip`: `'… which scales with document size -- typically 15-40+ minutes.'` | Dead cap, in the tooltip attached to the real estimate. |
  | `components/ProgressBanner.tsx:208` | `InfoTip`: `'… typically 15-40+ minutes for a real document.'` | Dead cap, on the running-job screen, where the wait is already happening. |
  | `utils/labels.ts:122` | `JOB_STATUS_LABELS.running.description`: `'… SURVEY can take 15-40+ minutes.'` | Dead cap, in a shared label map reused across the jobs list and detail header. |

  **Fix:** none of these may carry a time figure. `MODE_COPY` drops `estimate`
  entirely and the mode card's cost row reads the server's range; the prose
  sites state the *shape* of the cost ("scales with document size — figures
  dominate, because each is a separate vision call") and let the computed range
  carry the number. Grep for `15-40`, `15–40` and `3–5` before closing this.
- Any **illustrative number copied out of the mockup or out of this section.**
  `145 min` → `1h 49m – 3h 1m` is what the *bootstrap* gives for the
  682-block / 39-figure document, and it stops being the answer the moment the
  first real SURVEY run finishes. (It read `93.8 min` → `1h 10m – 1h 57m` until
  Part B's recalibration above — which is the point.) The computation is the specification; every
  number rendered anywhere comes out of it at runtime.

**Tests.** `utils/eta.test.ts` shrinks: `computeEtaMinutes` no longer exists
there, so its coefficient, multiplier and floor cases move server-side. What
remains on the frontend is `formatEtaMinutes` (unchanged) and `formatEtaRange`
formatting two server-provided numbers, including the degenerate
`lower === upper` case. Note that the existing test file carries a now-false
comment at `eta.test.ts:16-18` — *"a real ~682-block document's true estimate is
well over 300 minutes"* — which is precisely the claim §11.2.3.a reversed; it
must be corrected, not just deleted with the assertion around it.

The new server-side suite covers: the bootstrap returned exactly when `n = 0`;
the blend weight at `n = 8` being 0.5 within float tolerance; a fit with a
negative coefficient falling to the 2-parameter form; a singular system falling
all the way to bootstrap and reporting `basis: "bootstrap"`, `sampleCount: 0`;
the floor surviving a `0.5×` model adjustment on a one-block document; a large
document producing a value well above 40 minutes with **no** clamp anywhere;
`modelAdjustment === 1.0` for a model with zero samples; a per-model ratio from
one sample moving the estimate by no more than 1/6 of its distance from `1.0`;
jobs outside the 90-day window being excluded; and **rejected jobs with a
non-null `diffReadyAt` being included** — the §11.2.3.b regression that a
`status = 'succeeded'` filter would silently reintroduce.

#### §11.2.4 — Footer

`Back` (outline) and `Start job` (primary, with the `Activity` glyph). The
`Start job` button is **not** the `cta` variant and never carries `signal` —
starting a job writes nothing to ADO. `signal` belongs only to the confirm-to-ADO
step much later in the flow (§16.7).

### §11.3 — The running-job screen

**Files:** `pages/JobDetail.tsx`, `components/JobLifecycleSteps.tsx`,
`components/NarrationTicker.tsx`, `components/ProgressBanner.tsx` (which
contains `RunDetail`, `SectionStepList`, `WriteSubStepper` and `MiniProgress`),
`components/FigureDescriptions.tsx`, `components/SectionResults.tsx`,
`components/CollapsibleWarnings.tsx`.

**Audit note.** An earlier revision of this section described a two-column
layout whose right column held a `rail-900` **activity log** of timestamped
machine lines. Neither exists. This section has been rewritten against the
code as it actually stands; the raw-activity-log design is **superseded — do
not build it.** Its job is done better by `SectionStepList` (§11.3.1), which
answers "what is left" rather than "what has been emitted."

**The problem being fixed.** A header of six chips — a clock, an elapsed timer,
a block count, a model name, an ETA and a freshness stamp — all at the same size
and weight. None of the information was wrong; it was all promoted to the same
rank, so nothing was findable.

**The structure: one vertical stack, full width.** Not two columns. The screen
reads top to bottom as *where am I → what is happening right now → what came out
of it → what went wrong*, which is the order a reviewer's questions actually
arrive in. `JobDetail.tsx` renders, in order:

```
┌─ PageHeader · status · mode · [Stop] ──────────────────────┐
│ DestinationBar    Briefcase · project › area\path      (i) │
├────────────────────────────────────────────────────────────┤
│ ┌── one bordered rounded-md container ───────────────────┐ │
│ │ Parse ─ Analyze ─ ● Score ─ Dedup ─ Review ─ Write (i) │ │ ← horizontal, scrolls
│ ├────────────────────────────────────────────────────────┤ │
│ │ ▪ Scoring 41 drafted requirements…      Elapsed 17:15  │ │ ← bg-ink-1, welded on
│ └────────────────────────────────────────────────────────┘ │
│                                                            │
│  ProgressBanner — the loud thing + one bar + meta line      │
│    └ SectionStepList  ✓ Section 1 … ◉ Section 7 … ○ …      │
│  FigureDescriptions   (collapsed disclosure)               │
│  SectionResults       (collapsed disclosure)               │
│  StatTile ×3          New · Reused · Duplicates skipped    │
│  CollapsibleWarnings  (collapsed disclosure, amber)        │
└────────────────────────────────────────────────────────────┘
```

**The lifecycle stepper is horizontal, and it is a `Stepper`.**
`JobLifecycleSteps.tsx` is not a ladder of rows — it renders
`ui/Stepper.tsx` left-to-right inside
`overflow-x-auto [mask-image:linear-gradient(to_right,black_calc(100%-20px),transparent)]`,
with a single `InfoTip` held **outside** that scroll container so the tooltip
trigger cannot scroll out of view with the later steps. The right-edge mask is
load-bearing: it is the only "there is more, scroll right" affordance on a
narrow panel. Its steps are `parse`, `analyze`, `score`, `dedupCheck`, `review`,
`write` for SURVEY and `parse`, `dedupCheck`, `review`, `write` for BASELINE —
BASELINE runs no LLM, so showing it two permanently-grey LLM steps would
misrepresent the pipeline.

Paint comes from §7's `Stepper` node column, all six `StepState`s. Two
behaviours in `reachedKeyFor`/`statesFor` are hard-won and must survive any
edit here: `detect_conflicts` / `regroup_roots` / `infer_trace_links` map onto
the **Score** step (they are whole-tree passes that run after scoring but before
dedup, and omitting any one of them made the stepper visibly regress backwards
to Analyze mid-run on a real document), and a `rejected` job paints Write as
`skipped`, not `pending` — a rejected diff is a decision, not an omission. The
`InfoTip`'s copy is overridden per sub-phase for exactly this reason: Score's
static tip contradicted the narration sentence beside it.

**The narration ticker is welded to the stepper.** `NarrationTicker.tsx` shares
one bordered `rounded-md` container with the stepper and carries no margin of
its own, so the two read as a single object: the stepper is *where*, the ticker
is *what, right now*. It is the app's one dark content surface —
`bg-ink-1 text-white` (§2) — and it is `rounded-b-md` because it is the floor of
that shared container.

- Its sentence is guaranteed non-empty by `narrationTicker.ts`'s own contract.
  This bar never renders as a bare spinner with no text: that was the "two
  minutes in and I have no idea what is going on" failure it exists to close.
- `key={sentence}` remounts the span on every change so the `fadeIn` is a real
  *something changed* signal (§8 Entrance), not decoration.
- The elapsed timer renders **only** while `pending`/`running`/`writing`. A
  finished job's "time since it started" is not its run duration, and the
  backend exposes no `completedAt`. Honest omission beats a misleading number —
  do not "fix" this by showing the growing figure anyway.

**The loud element** (`ProgressBanner.tsx`, rendered only while the status is a
run status) is one card containing, in order: a live pulse dot in
`--color-live`, animated only while a stream is genuinely open (§8 Ambient); the
phase headline in `text-title` in plain language — "Checking for duplicates,"
never `dedup_check`; one sentence of what that phase is doing, identifiers in
`font-mono`; and the percentage in `text-metric font-mono tabular-nums` pinned
right.

**One meta line replaces the pill row.** Under a hairline, a single row at
`text-meta`, `text-ink-3` for labels and `text-ink-2` for values, dot-separated:
`elapsed 17:15 · model qwen2.5:32b · updated 4 s ago`. Every fact that used to
be a chip is still present and still readable — it is just no longer competing
with the phase headline for rank. The freshness stamp is load-bearing (it is how
an engineer distinguishes "still working" from "connection dropped"), so it may
not be dropped in the name of tidiness.

**The dedup bar — fixed, confirmed, past tense.** This section previously
flagged a live bug: the dedup phase rendered **two** progress bars showing one
percentage under two different unit names, one of them mislabelled `blocks` when
it was counting proposed items. **That bug is fixed.**
`ProgressBanner.tsx:437-445` now renders exactly one `ProgressBar` under one
honest label — `Checking {blocksDone} of {blocksTotal} proposed item(s) against
existing work items.` — with the singular/plural handled. The rule it satisfies
stands and is now a regression guard rather than a work item: **a bar's label
states the unit it is actually counting, and one percentage never gets two
bars** (§16.20).

`ProgressBanner`'s "never fabricate a percentage" philosophy, its real per-phase
weighting (`PHASE_START_WEIGHT`), and its honest fallback for phases with no
fixed step count (`isTailPhase`) are all correct and stay. Nothing in this
section is a change to that maths.

#### §11.3.1 — `SectionStepList` is the per-section progress surface

This replaces the raw activity log entirely. Where the old design streamed
machine lines, `SectionStepList` (inside `ProgressBanner.tsx`, ~line 495)
renders **one row per processing section plus four whole-document passes**, each
row carrying its own state. It is the answer to "what is left to do," which the
log never actually gave.

- **Header:** a `text-meta uppercase` "Sections" eyebrow, a `font-mono` chip
  with the section count, an `InfoTip`, and — pushed right — a
  `{n} steps left` chip. That countdown spans the *whole* pipeline
  (`branchCount + 4`), not just the visible section rows, so it does not
  silently under-promise the remaining work.
- **Row states:** `Check` in `--color-ok` for done, `Spinner` in
  `--color-live` for active, `Circle` at `text-ink-3/50` for not-yet-reached.
  The glyph carries the state; the row does not change shape.
- **The active row** takes `bg-surface-alt` plus a 2px `border-l border-accent`
  and goes `font-semibold text-ink-1`. This is exactly the paint
  `.hoverable-row[aria-selected='true']` produces (§6), and when §6 lands this
  row must adopt the class rather than keep spelling it out — but note it is a
  *selected* paint, not a hover: these rows are not interactive and must not
  gain a hover response.
- **`MiniProgress`** renders a slim `h-1 max-w-52` bar inside the active row
  only, fed by the *same* estimate driving the top-level bar. One number, two
  presentations — never two independently-computed figures.
- **The four whole-document rows** — Scoring requirement quality, Checking for
  conflicting near-duplicates, Grouping disconnected sections by topic,
  Resolving trace links — are permanent rows, not conditional ones. Quality
  scoring is whole-document scope and its events carry `branchIndex: null`; the
  earlier per-section-only check left every row on an empty circle for the
  entire scoring pass. Do not reintroduce that.
- **Section labels accumulate** across every narration seen, not just the
  latest, so a finished section keeps its real name once a later section becomes
  `latest`.

The `writing` phase has its own `WriteSubStepper` on the same principles.

#### §11.3.2 — The three result disclosures

Below the banner sit three collapsed-by-default cards on `surface`. All three
are disclosures with the same mechanics and the same `ChevronRight`/
`ChevronDown` pair (§10.1): closed by default because a running job's reviewer
is watching progress, not reading output, and each opens into content they
asked for.

- **`FigureDescriptions.tsx`** — what the vision model wrote for each figure.
- **`SectionResults.tsx`** — the real parsed nodes per section, live, with
  `WorkItemTypeBadge`, `QualityGauge` and per-section KB grounding chips. This
  exists because the banner's "Grounded against" chips only ever reflect
  whichever narration is currently `latest`, and a section's citations land in
  a split-second window at `section_complete`; accumulating them here keeps real
  KB usage visible instead of flickering away.
- **`CollapsibleWarnings.tsx`** — specified in §11.3.3.

Both narration-fed lists are unbounded in principle and must stay virtualised
per the project's `react-virtuoso` convention. Both are fed from the merged
`mergedNarrations` source (live SSE tail ∪ durable `/event-history`) so a
reconnect never makes counts appear to regress — see `docs/ui-progress-review.md`
§4 for why that merge exists; do not undo it.

#### §11.3.3 — `CollapsibleWarnings`: two-level disclosure, severity-tiered

**Closed §17 change.** This component previously grouped by a fixed four-way
*taxonomy* (`dropped-block`/`external-reference`/`conflict`/`other`), with a
flat `warnings: string[]` behind it. Both the grouping axis and the data shape
changed: warnings are now structured records (ingestion's `IntegrityWarning`,
mirrored as `WarningRecord` in `utils/warnings.ts` and orchestrator's
`dry-run.service.ts`) carrying a `severity` — `auto_fixed` / `needs_review` /
`pipeline_issue` — alongside the old free-form `kind` string. Severity, not
kind, is now the primary grouping axis: the single most useful question a
reviewer has about any given warning is *do I need to act on this at all*,
which severity answers directly; kind (with its own tip, same as the old
taxonomy tip) is the specific reason, shown as a sub-header within the open
severity group, not a second independently-collapsible level. This also
retires the "four taxonomies are fixed, do not add a fifth without §17" rule
from the previous revision — `kind` is intentionally an open, string-typed
vocabulary now (ingestion owns the closed enum, `app.workitem.model.WarningKind`),
since it can grow without a matching frontend release; `kindMeta`'s fallback
(`CollapsibleWarnings.tsx`) humanizes an unrecognized kind's own string rather
than requiring a hardcoded entry to render at all.

**Structure: two nested levels of disclosure, never a flat list.**

1. **The summary row** — always visible, always collapsed on first render.
   `ChevronRight`/`ChevronDown`, then `{n} integrity warning(s)`, then a
   dimmer clause built from the real severity counts present (e.g. *"— 12
   fixed automatically, 3 need your review"*) instead of the old fixed
   "document content SURVEY may have dropped or couldn't place" text, which
   was never accurate for the auto-fixed/pipeline-issue kinds this revision
   adds. The count is the headline because it is the only thing a reviewer
   needs before deciding whether to open it.
2. **Per-severity groups** — inside, one nested disclosure per severity tier
   that has at least one member. Within an open tier, warnings are grouped by
   `kind` (a `text-xs font-semibold` sub-header + count, then the tip, then
   the list) — not independently collapsible, since the severity tier is
   already the collapse boundary.

| Severity | Glyph | Title | Token family | What it means |
|---|---|---|---|---|
| `auto_fixed` | `CircleCheck` | Automatically fixed | `ok` (`bg-ok-soft`/`border-ok-border`/`text-ok-ink`) | Deterministic code already resolved it — a hierarchy repair, a synthesized grouping node, a safe fallback. No action needed. |
| `needs_review` | `TriangleAlert` | Needs your review | `warning` | An AI/heuristic judgment call — a conflict, low grounding, an invalid reference dropped. Worth a human read. |
| `pipeline_issue` | `CircleX` | Pipeline issue | `danger` | Something broke or was incomplete for this run — a scoring call failed, a section produced zero items. Re-running (optionally with a different model) is the general fix. |

Icon/token choice deliberately mirrors `ui/Alert.tsx`'s own
info/warning/success/error vocabulary (`CircleCheck`/`TriangleAlert`/`CircleX`,
`ok`/`warning`/`danger` token families) rather than inventing a parallel one.

**Each warning is an exit, not a dead end.** A `near_duplicate_conflict`
warning's `[localId: …]` tag is an internal reference for **this run only**
and is never an ADO work-item number — the copy says so explicitly, because a
reviewer reading it as a WI number will search ADO for an ID that does not
exist. Any kind carrying `nodeIds` (not just conflicts) now gets one *Review*
button per affected item, plus *View WI #N in Azure DevOps* shown only when
the item genuinely already exists. Two real, closed gaps from the previous
revision:

- **Duplicated-looking buttons.** Every button used to read literally "Review
  item →", so two or three sitting side by side looked like duplicated UI
  even though each targeted a different item. Each button is now
  disambiguated with the item's own title (`Review "Power supply efficiency" →`,
  truncated past 40 chars), via a `titleByLocalId` lookup `JobDetail.tsx`
  builds the same way it already builds `adoIdByLocalId`. Falls back to
  `Review item {n} →` only when no title is known for that id.
- **"Review item" didn't actually go anywhere.** The previous revision's own
  claim here — "jumps to the node in the diff tree (`setTab('tree')` +
  `setSelectedId`)" — was never true in effect: neither call scrolled the
  target into view, expanded a collapsed ancestor, or opened anything.
  `JobDetail.tsx`'s `onJumpToNode` now also calls `setDialogOpen(true)`,
  matching `onOpenDetails` exactly, and `DiffTree.tsx` gained two
  `useEffect`s keyed on `selectedId`: one expands any collapsed ancestor
  (found via a new unfiltered `allRows` memo, kept separate from the
  filtered/collapsed `rows` the list actually renders), the other calls
  `listRef.current.scrollToItem(index, 'center')` once `rows` reflects that
  expansion. The `.hoverable-row[aria-selected='true']` highlight (`bg-accent-soft`
  + the accent rail, index.css) already existed and needed no change — the
  gap was purely that nothing ever scrolled to or expanded the row wearing it.

An `external_reference` group still links straight to the knowledge base.

**Legacy back-compat.** A job persisted before this migration still has a
literal `string[]` in its `Job.warnings` `Json?` column — no DB migration was
run. `utils/warnings.ts`'s `normalizeWarning` reclassifies a plain string via
the OLD prefix-matching rules (`dropped_blocks`/`external_reference`/
`near_duplicate_conflict`/`other`), always to `severity: 'needs_review'`
(never `auto_fixed` — defaulting to "no action needed" would suppress
attention on content nobody actually classified) and tags it `legacy: true`,
rendered as a dim "(from an older run)" suffix. The exact same function also
normalizes live in-flight `chunk_warning` narration strings (`JobDetail.tsx`'s
`liveWarnings`) — `narration_publisher.py`'s wire schema was **not** upgraded
to carry structured records in this pass (a live warning still arrives as
plain text while a job is running); doing so is a real, separate follow-up
that touches the SSE payload shape on both ends.

**The expand animation is a grid-rows transition, not a conditional unmount.**
The body stays mounted at `grid-rows-[0fr]` and animates to `grid-rows-[1fr]`,
because `grid-template-rows` is transitionable and `height: auto` is not. Keep
this; it is the reason the disclosure animates at all. It respects §8.1 through
the global reduced-motion rule.
### §11.4 — The work-item detail dialog

**Files:** `components/NodeDetailDialog.tsx` (the container),
`components/NodeDetailPanel.tsx` (the details pane),
`components/ChatPanel.tsx` (the chat pane), `components/QualityGauge.tsx`,
`components/IssueChips.tsx`, `components/TagChips.tsx`, `utils/labels.ts`
(`QUALITY_ISSUE_LABELS`, the app's only fix-oriented quality prose),
`components/AddChildCard.tsx`, `ui/Dialog.tsx`, `ui/Tabs.tsx`.
New files this section calls for: `utils/qualityCategories.ts` (§11.4.3),
`components/QualityDelta.tsx` and `api/jobs.ts`'s `rescoreDiffEntry()`
(§11.4.4). All tracked in §18.1.

**Audit note.** An earlier revision of this section specified a **three-column
split** — a facts rail, a shipped-content column, and a conversation column —
inside `NodeDetailPanel.tsx`. That is not the shape the code took. The real
container is a new file, `NodeDetailDialog.tsx` (211 lines), and it is a
**two-pane** takeover dialog; `NodeDetailPanel.tsx` is a single-column stack
inside the left pane, not a three-column layout of its own. The three-column
framing is withdrawn. What survives from it is the *principle* — the shipped
content is read uninterrupted, and metadata does not interleave with it — and
the `addChildSlot` placement, which is already built.

**The problem being fixed.** The one thing a reviewer opens this dialog to read
— the requirement text that will land in ADO — was interrupted by metadata about
itself, in a cramped single-column sidebar with no room for the conversation.

**The structure: a takeover Dialog with two panes.** `ui/Dialog.tsx`'s
`unpadded` escape hatch, `max-w-[1180px]`,
`h-[min(760px,calc(100vh-96px))]` — a takeover surface, not a centred
form-sized modal.

```
┌─ [▲▼] · type badge · title · customerId · action badge ────────── [×] ┐
├──────────────────────────────────────────┬───────────────────────────┤
│ DETAILS  (flex-1, overflow-y-auto)       │ CHAT  (w-[400px], fixed)  │
│                                          │ border-l border-hairline  │
│  title / description — uninterrupted     │                           │
│  Classification    │  Active flags       │   message log             │
│  Quality gauge  (only if score != null)  │   ─────────────────────   │
│  Trace links                             │   [Model ▾] (i)           │
│  Sources / provenance                    │   [Ask…            ][▶]   │
│  ┌────────────────────────────────────┐  │                           │
│  │ + Add child item   (pinned last)   │  │                           │
│  └────────────────────────────────────┘  │                           │
└──────────────────────────────────────────┴───────────────────────────┘
                    below lg (1024px) ↓
┌─ header ─────────────────────────────────────────────────────────────┐
│  [ Details ][ Chat ]        ← Tabs; exactly one pane mounted          │
└──────────────────────────────────────────────────────────────────────┘
```

**The header** carries, inline on one row: a stacked `ChevronUp`/`ChevronDown`
pager stepping through the same filtered row list the caller's arrow keys use,
the `WorkItemTypeBadge`, the truncated title, the `customerId` in
`font-mono text-xs`, and the `ActionBadge`. `Excluded from this run` is the only
fact that still gets its own row — everything else moved inline, closing a
full-width row a lone "New" badge used to occupy alone. The dialog stays open
and swaps content when a different row is selected.

**Pane 1 — details** (`NodeDetailPanel.tsx`, a single vertical stack, not
columns): the title and description first and uninterrupted; then
Classification and Active flags side by side in a `grid-cols-2`; then the
quality gauge (§11.4.1); then trace links; then Sources — document provenance in
`font-mono text-xs`, the judged-against line, KB citation chips. An inline
`Pencil` enters edit mode.

**`AddChildCard` is already correctly placed — keep it there.** It arrives
through `NodeDetailPanel`'s `addChildSlot` prop and renders **last**, at
`NodeDetailPanel.tsx:295`, after everything a reviewer might read about the
node. It used to sit directly under the title, ahead of the entire
description/classification/quality/trace/sources stack it has nothing to do
with. It is composed by the dialog (`NodeDetailDialog.tsx`) and only when
`jobMode` is set and `jobStatus === 'diff_ready'`, so a closed job shows no
add-child affordance at all rather than a disabled one.

**Pane 2 — chat** (`ChatPanel.tsx`): a fixed `w-[400px] flex-none` with a
`border-l border-hairline`, at `NodeDetailDialog.tsx:186-190`. Fixed, not
fractional: the composer and the model row have a minimum workable width, and
letting chat flex meant the details pane's 62–66ch measure and the chat's
usability traded against each other on every viewport. See §11.4.2.

#### §11.4.0 — The `lg` collapse is real conditional mounting, and that is deliberate

Below `lg` (1024px) the two panes become **Details / Chat tabs** (`ui/Tabs.tsx`),
with the tab resetting to `details` whenever the selected node changes.

**This must stay a JavaScript `matchMedia` branch that mounts exactly one pane.
It may not be reimplemented as `lg:hidden` / `hidden lg:flex` CSS.** The reason
is a real bug an earlier version of this file shipped: `ChatPanel` fetches
history and opens a websocket on mount, keyed on `jobId`/`localId` and **not on
visibility**. Rendering both layouts in the DOM and hiding one with CSS mounted
**two** `ChatPanel` instances for the same item — two history fetches, two open
sockets, and two histories that diverged the moment the viewport crossed the
breakpoint with the dialog open.

`useIsAboveBreakpoint` therefore returns `false` when there is no `window` and
corrects itself in an effect on mount. `LG_BREAKPOINT_QUERY`
(`'(min-width: 1024px)'`) is a named constant that must stay in sync with
Tailwind's `lg`. Any future work that adds a second socket-opening or
fetch-on-mount pane to this dialog inherits the same constraint.

#### §11.4.1 — The quality gauge is gated on the ADO work-item type

**The required rule.** `QualityGauge` renders **only when the entry's real Azure
DevOps work-item type is Requirement.** For an Epic, a Feature, or any other
type it is **absent — never rendered, never greyed** (§16.22) — *regardless of
whether a `qualityScore` value happens to be present on that entry.* The type is
the primary and explicit check. A greyed gauge asserts that a score exists and
is merely unavailable; the truth for a non-Requirement is that no such score is
defined at all. Epics are judged on scope coherence and decomposability, which
are review notes, not a number.

**The code does not implement this rule yet.** `NodeDetailPanel.tsx:237` gates
on `entry.qualityScore != null`. That is **not** the rule above — it is a proxy
for it. The two agree *today* only because quality scoring is currently scoped
to Requirement-type nodes server-side (`llm_leveling.py`), so Epics and Features
happen to arrive with `qualityScore: null`. That correlation is incidental, not
a contract: it is a property of the current server-side scoring scope, and
nothing in the frontend enforces or even states it. The moment scoring scope
widens — or any non-Requirement entry acquires a score by any path — the proxy
silently renders a gauge on an item type that has no defined rubric.

**Fix required:** replace the null check with an explicit work-item-type check.
`NodeDetailPanel` already receives the full `entry`, so the type is in hand; no
new prop is needed. Tracked in §18.1. Do not close this row by observing that
the rendered output looks the same — the point is that the check is stated
rather than inferred.

The provenance line describing what the score was judged against is gated by
the same rule and moves with it. That line previously rendered unconditionally
and claimed a rubric had been applied to items it never touched; it must claim
a judgment only for the type the rubric is defined for. (Its wording is also
revised by §11.4.3 to drop every standard's name — the gating rule here is
unchanged by that; only the words inside the gate are.)

A score that is missing on a Requirement — a scoring pass that failed — is a
*different* case and is not what this gate is for. The type gate decides whether
the gauge is a meaningful element at all; a Requirement whose score is absent
shows the gauge's own empty/failed state, not a silently missing section.

In place of the gauge, an Epic/Feature shows a **Scope** group: what the item
covers and one row stating plainly why there is no score. *Built (§18), with
one honest reduction from this section's original illustrative copy: real
descendant counts ("Covers 6 features, 41 requirements.") shipped, but the
section-number range (`§3 through §3.2`) did not — no heading-number field
exists anywhere in the diff entry shape, and `DryRunSourceRef` is
byte-offset-only, so that half of the example was never real, extractable
data.*

When it does render, `QualityGauge` keeps its current shape — an overall score
in `text-metric` tinted by its band, a verdict chip, and one `.hoverable-row`
per category (clarity, testability, atomicity, style, rationale) with a
`bg-surface-sunken` track, an `accent` fill, `warning` fill below the passing
band, and the numeral `font-mono tabular-nums`. Its `InfoTip` copy stays: this
is req2ado's own read, from a single LLM judgment, not an ADO field and not part
of the work item.

*What the gauge contains once the gate has let it render — its copy, its
per-category rows, and their explanations — is specified in §11.4.3, which
supersedes the sentence above on composition only. The gate rule in this section
is unchanged by it.*

#### §11.4.2 — The chat panel's model selector is permanent — and is built

`ChatPanel` has a model selector. It was dropped in an earlier design pass and
restored; **it is a real, permanent part of the panel and must not be removed
again.**

**Confirmed built, matching this spec.** `ChatPanel.tsx:360` renders it exactly
as specified below. This is a regression guard, not a work item:

| Requirement | Code | Status |
|---|---|---|
| Above the composer, below the log, own row | first child of the composer's `flex flex-col gap-2` wrapper, under a `border-t border-hairline` | built |
| Secondary rank, narrow | `className="w-20 text-xs"` | built |
| `Default` as the empty-value first option | `<option value="">Default</option>` | built |
| Options fetched live | `listModels()` | built |
| An `InfoTip` beside it | present | built |

**Two real deltas — both closed, see §18.**

1. **The tooltip now states scope** — it reads *"...This applies to this
   conversation only — it does not change the model the job was analysed
   with."*, verbatim as originally specified.
2. **`Assistant · <model>` is now `font-mono`** on the model span only, the
   `Assistant` word unchanged, exactly as specified.

**The empty state is an invitation, not an apology — built, with two
deviations from the original target below (§18).** With no history the log
shows "No conversation yet. Ask in your own words, or start from one of
these:" followed by 3 clickable chips — "Make it testable," "Add the missing
rationale," "Tighten the wording." Two differences from the original target:
(a) no fourth "Suggest a better title" chip — the header's own Suggest a
title button already covers it and stays reachable even once the chat has
history, and `ChatPanel.test.tsx` has a real regression guard against a
second control for the same action; (b) each chip sends its prompt
immediately via the existing `send()` path, matching how "Suggest a title"
already behaves, rather than populating the composer for the user to edit
first. Each chip carries its §10.1 glyph (`Target`/`Flag`/`Pencil`), but
`.liftable` was not used — plain `Button variant="outline" size="sm"`,
matching the header's own button styling (`.liftable`'s card
elevation-on-hover doesn't fit a small text button; §7's own table never
lists buttons as a `.liftable` target).

**Streaming states.** One control occupies the send slot and swaps with state:
`SendHorizontal` at rest, `Square` (danger variant) while streaming — one
control whose icon and action swap, not two controls competing. Pressing stop
reads as a **finished stop with the partial text kept** — never as an error. A
reviewer must never have to interpret their own cancellation as a failure. The
reasoning/chain-of-thought stream is a collapsed-by-default disclosure: it is
process, not content, and it never enters the message history. (It was
previously dropped entirely, so the bulk of a ~2-minute turn showed nothing but
typing dots — do not regress that by hiding it again.)

**Chat is gated to `diff_ready`.** `canEditEntry` is exported from
`NodeDetailPanel.tsx` precisely so the details pane and the chat pane derive
editability from one rule rather than two drifting copies. When a job's review
is closed the panel is disabled with a stated reason, never silently inert.

**Accepting an edit does not re-evaluate the quality score, and no rescore
endpoint exists.** That was previously logged here as an undesigned gap. It is
now designed: §11.4.4. Until that lands, the rule stands — do not add a UI
affordance that implies a score is fresh when it is not. A stale score presented
as fresh is worse than a visibly stale one, and §11.4.4's whole first state
exists to make staleness visible rather than to hide it.

`ChatPanel`'s accept path (`acceptProposal` →
`NodeDetailDialog.tsx:134-139` → the same `onSave` the pencil uses) is one of
§11.4.4's two trigger points. It needs no route of its own: both edit paths
already converge on `PATCH /jobs/:id/diff/:localId`.

#### §11.4.3 — The quality section must be readable by someone who has never heard of EARS

**The finding.** A customer opened this panel and could not use it. The header
carried a raw gate expression, `type = Requirement → gauge shown` — a debug label
that leaked out of a design annotation into product chrome. The five category
bars carried a single word and a number each, with the definition of the word
hidden behind an `InfoTip`. The provenance line named three standards
(`EARS`, `INCOSE`, `ISO/IEC/IEEE 29148`) and put their glosses in a second
`InfoTip`. Everything a non-expert needed in order to read the section was
one hover away, and nothing on screen told them a hover was where it lived.

**The rule, and how it sits with §12.** §12's audience clause — engineers and
Azure DevOps administrators, dense, precise, no marketing tone — is unchanged
and still governs. This screen adds a narrower constraint on top of it, and the
two do not conflict:

> **No requirement-writing standard's name or acronym appears anywhere in
> product copy — not as the primary label, not glossed, not in a tooltip.**
> `EARS`, `INCOSE`, `ISO/IEC/IEEE 29148`, and every other standard req2ado's
> rubric happens to draw on are internal implementation detail, on the same
> footing as a phase name or a database column: real, and none of the
> customer's business. Describe *what the checklist checks for* in plain
> language instead — "the trigger is stated, not implied," not "EARS-style
> phrasing." A gloss that pairs a plain sentence with the acronym still fails
> this rule; the fix removes the acronym, it does not annotate it.

**This reverses an earlier draft of this section**, which kept the acronyms on
screen and moved their definitions out of a tooltip and onto the surface
beside them — gloss-first rather than tooltip-only. Customer feedback after
that draft shipped was that the standards' names themselves were still the
problem, independent of whether they came with an explanation. The gloss
approach is superseded outright, not tuned; see §18's ledger entry.

An `InfoTip` may still carry a *further*, genuinely optional detail (e.g. that
the rubric is reviewed periodically, or that it draws on multiple published
sources without naming which). It may not be where a standard's name is
disclosed — that name should not appear at all, tooltip or otherwise.

**Three specific replacements.**

**1. The gate badge is deleted outright. Nothing replaces it in product UI.**
The work-item-type gate (§11.4.1) is a rule about *whether* this section renders.
A section that has rendered must not then announce the condition that let it
render — that is build detail, and §12 already bans naming things by how the
system is built. `type = Requirement → gauge shown`, in any casing or phrasing,
is banned from the product. Its legitimate home is the design mockup's own
annotation vocabulary, where it is visibly not part of the app.

In its place, one line of real copy directly under the `Quality` eyebrow, at
`text-xs text-ink-3`:

> **How well this requirement is written. req2ado's own read — not an Azure
> DevOps field.**

The existing `InfoTip` stays and keeps its remaining job: that the number comes
from a single LLM judgment on a 0–100 scale, and is not part of the work item
written to ADO.

**2. The provenance line becomes two lines, plain first, standard-name-free.**
Replacing the single "Judged against EARS, INCOSE, ISO/IEC/IEEE 29148, and your
knowledge base" plus its `InfoTip`:

> *(primary, `text-sm text-ink-2`)*
> **Scored on how the requirement is written — its wording, not its engineering
> content.**
>
> *(secondary, `text-xs text-ink-3`)*
> **The checklist follows established requirements-writing practice — the same
> checks a systems engineer would run by hand when reviewing wording. Your
> knowledge base contributed 2 documents.**

No standard's name appears in either line, including in the secondary line —
"established requirements-writing practice" is the entire disclosure; it does
not expand into "which practice" anywhere on screen or in a tooltip. The KB
sentence is present only when citations exist, and carries the **real count**
— never the bare phrase "and your knowledge base", which asserts grounding
without evidence (§12: never fabricate a number; a count with a real
denominator is exactly what this is). With no citations the secondary line ends
after "reviewing wording by hand."

Both lines stay gated by §11.4.1's type check, as that section already requires.

**3. Each category row states what it means, on screen.** The row keeps its
`.hoverable-row` geometry (§6) and gains a second line: the plain-language
question the category answers, at `text-micro text-ink-3`. The wording already
exists in `QualityGauge.tsx`'s `KNOWN_CATEGORY_DESCRIPTIONS` — it is being moved
out of the `InfoTip` and onto the surface, not written from scratch.

**A correction to carry forward.** §11.4.1 describes the categories as the fixed
set *(clarity, testability, atomicity, style, rationale)*. **They are not fixed.**
`quality_category_scores` is a dynamic `Record<string, number>`
(`model.py:62`, `_response_schemas.py`'s `additionalProperties`), and when an
organisation has ingested its own quality checklist into the knowledge base the
model derives the category **names from that document** instead. A sixth
category, `completeness_as_requirement`, is appended by the prompt in *every*
branch. Any copy, mapping, or layout in this section must therefore survive an
unknown category key. Fixed-width label columns and hardcoded five-row layouts
are violations of this, not stylistic choices — and
`pipeline.worker.ts:202` still declares the old fixed five-key shape, which is a
real stale type and a §18.1 row.

**Per-metric explanation — what exists, and what does not.**

| Layer | Status |
|---|---|
| Per-category **numeric** subscores, 0–100 | **Exists end to end.** `quality_category_scores` → `qualityCategoryScores` → rendered as bars today. |
| Per-category **definition** ("what does Clarity mean") | **Exists, client-side and static.** `KNOWN_CATEGORY_DESCRIPTIONS`. Identical for every item. |
| Per-item **flags** with fix-oriented prose | **Exists, client-side and static.** 13 closed-vocabulary codes in `quality_issues`, each with a written remedy in `utils/labels.ts`'s `QUALITY_ISSUE_LABELS` — e.g. `vague_term` → *"Uses a subjective word … replace with a measurable value."* Rendered today as an unranked amber chip cloud labelled "Active Flags", with the remedy hidden in a `Tooltip`. |
| **Why *this* item scored *this* number** on a given category | **Does not exist at any layer.** No field, no schema slot. `categoryScores` values are `{"type": "integer"}`. |
| **How to raise *this* item's score** on a given category | **Does not exist at any layer.** |
| Which flag belongs to which category | **Does not exist as data.** A candidate mapping is sketched in a code comment (`model.py:56-60`) covering 5 of 13 codes and only the generic category names. |

So Eden's ask splits cleanly into a stage that needs no backend and a stage that
does. **Build them in this order.**

**Stage 1 — regroup what is already computed. Frontend only.**
Move each flag out of the "Active Flags" cloud and under the category bar it
belongs to, and render its existing `QUALITY_ISSUE_LABELS` remedy as **visible
text, not a tooltip**. The mapping is new code — a new
`utils/qualityCategories.ts` exporting `categoryForIssue(code): string | null`
— but the prose it points at already ships.

Three degradation rules are mandatory, because the mapping is partial by
construction:

- A code with no mapping is **not dropped**. It stays in a group beneath the
  bars titled **Other flags** with the same visible remedy text.
- When the categories are **KB-derived**, the mapping does not apply at all —
  its keys are the five generic names. Every flag goes to **Other flags**, and
  no flag is guessed into an org-defined category.
- The two-column `Classification | Active Flags` row (`NodeDetailPanel.tsx:225`)
  keeps `Classification` and loses `Active Flags`, which has moved. It becomes a
  single labelled group, not a half-empty grid.

Stage 1 already answers most of "why is Rationale 58": the item carries
`missing_rationale`, and the remedy sentence sits under the Rationale bar
instead of three components away.

**Stage 2 — the real per-item answer. New data, end to end.**
Each category entry becomes an object rather than an integer:

```
categoryScores: {
  rationale: {
    score: 58,
    why:  "…quotes or names the part of THIS item's text that cost it points…",
    fix:  "…one concrete change to make…"
  }
}
```

`why` must reference the item's actual wording — a generic restatement of the
category definition is a failed implementation of this field, because that is
precisely what Stage 0 already had. `fix` is one action, imperative, in the
same voice as `QUALITY_ISSUE_LABELS`.

This touches: `_response_schemas.py` (`scores_schema()` and
`epic_feature_scores_schema()` — the `additionalProperties` value type changes
from `integer` to an object), both `.v1.txt` scoring prompts and
`orchestrator_llm_client.py`'s three `category_instruction` branches,
`scoring.py`'s `_parse_category_scores` (which must keep its all-or-nothing
tolerance — a malformed entry discards the whole breakdown rather than
half-populating it), `model.py`'s `QualityCategoryScores` alias, the regenerated
`shared/ts` type, `dry-run.service.ts`, `pipeline.worker.ts`, `DiffTree.tsx`,
and `QualityGauge.tsx`. **No database migration** — `dryRunDiff` is a JSON
column with no per-entry table. One hard constraint carries over from
`_response_schemas.py`'s own header: bounded-`maxItems` top-level arrays wedge
the GBNF grammar compiler; keep the dynamic `additionalProperties` shape.

Until Stage 2 lands, a category row that has no flag mapped to it shows its
definition line and nothing else. It does **not** show an empty "Why this
number" heading with no content — an empty labelled slot reads as a bug.

**The disclosure pattern: expand in place, on the row.** Not a side panel, not a
popover.

- The dialog is settled at **two** panes (§11.4). A side panel is a third, and
  reopens an argument §11.4 closed.
- A popover would be a **new overlay type** in a surface that already sits
  inside a takeover `Dialog` — an overlay over an overlay, with its own focus
  trap and its own dismissal rules.
- The app already owns exactly this mechanic: `CollapsibleWarnings` (§11.3.3)
  animates `grid-template-rows: 0fr → 1fr` because `height: auto` is not
  transitionable. Reuse it verbatim. `SectionResults` and `FigureDescriptions`
  use the same one (§11.3.2). This is a fourth instance of an established
  pattern, not a fifth pattern.

Mechanics: the row becomes a `<button>` with `aria-expanded`, keeping its
`.hoverable-row` treatment; a `ChevronRight`/`ChevronDown` pair (§10.1) sits at
the row's end; **all rows are closed on first render**, because a reviewer scans
five bars before choosing one to interrogate; **more than one row may be open**,
matching `CollapsibleWarnings`; and the open state resets when the dialog's
selected node changes, for the same reason `NodeDetailPanel` already resets its
edit draft on `entry.localId`.

The expanded body carries, in order: **Why this number** (Stage 2 `why`), any
flags mapped to this category with their remedy text (Stage 1), and **How to
raise it** (Stage 2 `fix`). It ends with one `.liftable` action, *Ask the
assistant to fix this*, which writes a ready prompt into the chat composer
rather than sending it — the reviewer stays in control of the turn. That action
is gated by `canEditEntry` like every other mutation affordance in this dialog,
and is absent, not disabled, when the job is closed (§16.22).

#### §11.4.4 — Re-check quality after an edit

**This closes the gap logged in §11.4.2 and removes the §14 exclusion.** It is
**not a frontend change.** It requires a new ingestion route and a new
orchestrator route, and it has a prerequisite that is easy to miss (below). Any
attempt to satisfy this section by asking the chat model to "re-evaluate" is a
fabrication: the chat payload does not even carry `qualityScore`
(`ChatTurnItem` has `type`, `title`, `description`, `childType`,
`qualityIssues` only), so the model would be inventing a number from prose. That
is banned by §12's never-fabricate rule.

**Why it is needed.** `quality_score`, `quality_issues` and
`quality_category_scores` are written exactly once, by `_apply_quality_scores`
(`scoring.py:352`), reachable only from a full SURVEY leveling run.
`editDiffEntry` (`jobs.service.ts:395`) spreads the patch over the existing
entry, so the quality fields **survive every edit unchanged and unmarked**. A
reviewer can rewrite a requirement from scratch and the panel will still show
the score of the sentence they deleted.

**Two triggers, one hook.** Both converge already:

| Trigger | Path |
|---|---|
| A manual title/description edit is saved | `NodeDetailPanel.save()` → `JobDetail.handleSaveEdit` → `api/jobs.ts editDiffEntry()` → `PATCH /jobs/:id/diff/:localId` |
| An AI-proposed edit is accepted | `ChatPanel.acceptProposal()` → `NodeDetailDialog.tsx:134-139` → the same `onSave` → the same `PATCH` |

So the staleness flag is set in exactly one place: `jobs.service.ts`'s
`editDiffEntry`, after the spread and before the `prisma.job.update`.

**Rescoring is user-triggered, not automatic on save.** Deliberately. It is a
real LLM call costing seconds; a reviewer commonly saves two or three times in a
row while working on one item; and a number that silently re-rolls under the
reader is worse than one that visibly waits. Save marks the score **stale**; the
reviewer decides when to spend the call.

**Four states. The gauge is always in exactly one.**

| State | What the gauge shows |
|---|---|
| **Scored** | §11.4.3's normal presentation. |
| **Stale** | Bars and numerals drop to `ink-3` — dimmed, still legible, **never zeroed** (§16.23). One row above them: *"Edited since this was scored. The numbers below are from before your change."* and a `Button variant="outline" size="sm"` with a `RefreshCw` glyph: **Re-check quality**. |
| **Re-checking** | The button is disabled and carries a `Spinner` with the label **Re-checking…**; beside it, *"Re-scoring against the current wording. This takes a few seconds."* No percentage and no ETA — there is no real denominator (§12). Bars hold their previous values, dimmed. |
| **Rescored** | New numbers, plus the deltas below. |

The concurrency guard is the project-standard one: a `useRef<boolean>` checked
and set synchronously before the `await`, a `useState<boolean>` driving
`disabled`, both cleared in `finally`.

**What the delta must show — the improvement is the point, not the new number.**

- **Headline:** the new score in `text-metric` tinted by its band, a delta chip
  beside it — `▲ +7` on `ok`, `▼ −5` on `danger`, and for no movement the words
  **no change** on `ink-3`, never `+0` (§16.23).
- **Beneath it:** `was 82`, in `font-mono tabular-nums`.
- **Per category:** each row that moved shows `58 → 74` and `+16`, `font-mono
  tabular-nums`, tinted by direction. A row that did not move shows **no delta
  ornament at all** — decorating fifteen unchanged rows to make one changed row
  findable inverts the signal.
- **Band crossings are named in words**, because that is the sentence a customer
  actually wants: *"Moved from Needs review into Solid."* On the headline, and on
  any category row that crosses. Only on a crossing — a row that improved without
  changing band gets its numeral delta and nothing more.
- **Cleared flags are shown once.** A flag present before and absent after
  renders as **Cleared: Missing rationale**, dimmed, in the category group it
  belonged to. New flags render normally. This is the most direct evidence the
  edit worked, and it is free — the rescore already returns the new `issues`
  list.
- **The delta is session state, never persisted.** Only the new score is written
  back. It survives node switches within the open dialog and is discarded when
  the dialog closes or the entry is edited again.

**Failure is stated, never silent.** *"Re-check failed — the scoring model
didn't return a result. The numbers below are still from before your edit."*
plus **Try again**. The gauge returns to **Stale**, not to **Scored**: a failed
rescore must never launder a stale number into a fresh-looking one.

**Backend work this required. Shipped — see §18 for the closed rows and their
deviations from this list's original text.**

1. **A new single-item ingestion route**, `POST /score-item` (this section
   originally sketched `/score/item`; shipped flat, matching this service's
   existing convention — e.g. `/dedup/check`). Today the only other
   scoring-capable route is `POST /level` (`main.py:792`), which takes a whole
   `CanonicalDoc` and runs the entire survey pipeline; it cannot score one
   item. The new route/`scoring.score_single_requirement_text` is a thin
   wrapper over `BatchedScoringClient.score_requirements_for_document`
   (`scoring.py:48`) with a one-entry `{"adhoc": description}` map, reusing
   `_parse_category_scores`'s all-or-nothing tolerance and the same
   `RequirementQualityIssue` enum filter, so a rescore can never hand the UI a
   shape the ingestion path would have rejected.
2. **A prerequisite: the rescore must judge the SAME categoryScores key set as
   the original score.** Shipped without the DB persistence this point
   originally called for — see §18's closed row for
   `resolveCategoryChecklist`'s sibling-fallback, which reuses a same-job
   sibling Requirement's already-persisted keys instead of a new `Job`
   column, since one whole-document scoring pass applies one checklist to
   every Requirement node in it.
3. **A new orchestrator route** — `POST /jobs/:id/diff/:localId/rescore`.
   Guards identical to `editDiffEntry`, plus `type === 'Requirement'` (see
   Scope limits below). Writes the three quality fields back into the
   `dryRunDiff` JSON and clears the stale flag. Returns only the updated
   `dryRunDiff` — not an explicit previous/new pair as originally planned
   here — because the frontend (`NodeDetailPanel`) already holds the previous
   score/categoryScores in its own props the instant before calling this
   route, and snapshots them client-side rather than having the backend echo
   back data the caller already has.
4. **`editDiffEntry` sets `qualityStale: true`** on the entry — one added field
   on a JSON blob, only when a real `description` change lands on an entry
   that already carries a `qualityScore` (a title-only edit changes nothing
   the score was judged against). **No migration**: `dryRunDiff` is a `Json?`
   column (`schema.prisma:78`) and there is no diff-entry table.
5. **Refetch the job summary after a successful rescore — checked, not
   needed.** `JobSummaryReport.flagged` (`api/jobs.ts:214`) exists in the type
   but is not rendered anywhere in `JobDetail.tsx` today (only
   `created`/`reused`/`dedupSkipped` are shown); there is currently nothing on
   screen for a rescore to leave stale. Revisit if a flagged-count tile is
   ever added.
6. **Frontend:** `rescoreDiffEntry()` in `api/jobs.ts`. No separate
   `components/QualityDelta.tsx` was created as this point originally
   proposed — `QualityGauge` gained the delta-rendering props
   (`previousScore`/`previousCategoryScores`) directly instead, staying the
   app's one gauge-rendering component. State ownership (which of the 4
   states is active, the pre-rescore snapshot, the re-entry guard) still
   lives in the caller (`NodeDetailPanel`), matching this point's intent that
   the gauge itself not own fetching.

**Scope limits.**

- **Requirements only.** Epic and Feature scoring exists server-side
  (`_score_epics_and_features`, `scoring.py:215`) but §11.4.1 gates the gauge on
  the work-item type, so there is no surface to rescore into. Do not add one
  here.
- **Manually added items are a different state, not a stale one.**
  `addDiffEntry` hardcodes `qualityScore: null, qualityIssues: []`
  (`jobs.service.ts:456-457`) — such an item has never been scored, so it shows
  **Not scored yet** and a **Score this item** action, never "edited since this
  was scored." **Not shipped this pass** — `Not scored yet` still renders with
  no action (§18.1); the underlying `POST /score-item` route it would call
  already exists and takes no `previous` score, so wiring it up is additive,
  not a new backend capability.
- **`SectionResults`' live-narration gauge is out of scope.** It renders with no
  `categoryScores` at all (the narration event does not carry them) and belongs
  to a job that is still running, where nothing is editable.

---

## §12 — Content and voice

- Audience is engineers and Azure DevOps administrators. Dense, precise, no
  marketing tone, no emoji in product copy.
- **Domain-expert audience is not the same as standards-literate audience.** A
  systems engineer knows their own standards (SOSA, VITA, MIL-STD) and has no
  reason to know req2ado's — EARS, INCOSE, ISO/IEC/IEEE 29148 are internal to
  how *this tool* judges wording, on the same footing as an internal phase name
  or column name. **Product copy never names them, glossed or not** — describe
  what the check looks for in plain language and stop there; do not pair the
  plain sentence with the acronym "for precision." If a term the reader is not
  required to know appears at all, its plain-language meaning must be on screen
  without hovering — but the fix for a standard's name specifically is removal,
  not explanation. §11.4.3 is the worked example and the strictest case, and
  records that an earlier gloss-first version of this rule was tried and
  explicitly withdrawn.
- Sentence case everywhere except `text-micro` eyebrow labels and mode enum
  names (§4).
- **Name things by what the user controls,** not by how the system is built.
  "Checking for duplicates," not `dedup_check`. "Reading the document and
  splitting it into sections," not "extracting a deterministic hierarchy
  subtree."
- **Irreversible-action copy names the destination and the count:** "Write 12
  items to `Compliance Platform\Auth`" — never "Are you sure?" alone.
- **Error copy states cause, then remedy.** Never "Something went wrong."
- **An empty state is an invitation to act,** with a concrete next step. Never a
  shrug.
- **Never fabricate a number.** A percentage with no real denominator is not
  shown; the honest "Working — no progress estimate for this step yet" is shown
  instead. A placeholder is `--`, never `0`. An estimate is a range with
  "typically," never a false-precision point value.
- No exclamation marks anywhere, including success toasts.

---

## §13 — Accessibility contract

- Visible focus on every interactive element (§7's universal rule). No
  exceptions, no `focus:outline-none` without a replacement ring.
- Dark-surface elements — the nav rail, `NarrationTicker`, tooltips, toasts —
  use `.on-dark` and `--color-focus-on-dark`.
- `prefers-reduced-motion` honoured per §8.1, including `.liftable`'s
  transform-zeroing.
- Minimum 24×24 CSS px hit target on every interactive element, including
  chips-that-act-as-buttons, checkboxes, and `InfoTip` triggers. Add a
  transparent hit-area expander where the visible control is smaller.
- **Colour is never the sole carrier of state.** Selected rows and cards set
  real `aria-selected` / `aria-checked` / `aria-pressed`; status carries a chip
  label and usually an icon in addition to colour; the proposed-versus-written
  distinction (§0.3) also changes the available action affordance, not only the
  paint.
- Progress bars set `role="progressbar"` with `aria-valuenow` / `aria-valuemin`
  / `aria-valuemax` when a real percentage exists, and `aria-valuetext` carrying
  the honest message when one does not.
- `Spinner` is `aria-hidden` only when a sibling carries the `aria-busy` label;
  otherwise the spinner itself must be the labelled element. Under reduced
  motion the spinner freezes, so this is not optional.
- Radio-group semantics are real: `ModeCards` is `role="radiogroup"` with
  `role="radio"` children and arrow-key navigation, not a set of styled buttons.

---

## §14 — What is deliberately not here

- **No dark mode.** Out of scope. Do not add `dark:` variants, a second colour
  set, or a theme toggle. The design-pass mockup has a light/dark switch, but it
  swaps only that document's own report chrome (its `--st-*` tokens) and never
  touches a single product token (`--a-*`). It is not a proposal for the
  product, and it does not weaken this rule.
- **No second token file.** `frontend/src/index.css` is the only place tokens are
  declared. No MUI, no `theme/tokens.ts`.
- ~~**No rescore-after-edit UI** (§11.4.2).~~ **Withdrawn.** Specified in
  §11.4.4; ledger row in §18. The exclusion was a statement that no *design*
  existed, and it was read as a statement that none should — a re-check after an
  edit is the thing that tells a reviewer whether their rewrite worked.
- **No pagination on `/event-history`** — the query is deliberately unbounded;
  the client virtualises instead.

---

## §15 — Enforcement

Three ratchets, all fail-on-increase. **No exception without a same-PR edit to
the relevant allowlist — silent baseline bumps are not permitted.**

1. **`frontend/src/design/palette.test.ts`** — per-file raw-hex-literal
   baseline. Allowlists exactly four data-palette files: `utils/tagColors.ts`
   (11 requirement-tag colours with no token equivalent),
   `components/KbCitationChips.tsx` (3 KB-relevance colours),
   `components/WorkItemTypeBadge.tsx` (Azure DevOps' own official work-item-type
   colours plus an rgba alpha-compositing helper for live ADO-fetched values),
   and `components/FileTypeIcon.tsx` (per-extension icon colours). Removing hex
   from a file removes its baseline entry entirely — a `0` entry is dead
   bookkeeping, and deletion means any future hex in that file is a new
   offender rather than a return to zero.

2. **`--color-*: initial` in `@theme`** — deletes Tailwind's default colour
   scale outright, so "use a colour token" is mechanically true rather than
   aspirational. §1.8 row B tracks extending this to the other scales.

3. **`frontend/src/design/tokens.test.ts`** — per-file baseline over these
   patterns, each mapping to a §16 constraint:

   ```
   /text-\[\d+(\.\d+)?px\]/g              §16.3  arbitrary type size
   /rounded-\[\d+px\]/g                   §16.5  arbitrary radius
   /(?<![\w-])rounded(?![\w-])/g          §16.5  bare `rounded` → deprecated 4px fallback
   /(?<![\w-])transition(?![\w-])/g       §16.6  implicit transition property list
   /animate-\[[A-Za-z-]+_\d+ms/g          §16.4  inline animation duration
   /duration-\[\d+ms\]/g                  §16.4  arbitrary duration
   /cubic-bezier\(/g                      §16.4  inline easing
   ```

### §15.1 — Ratchet changes this revision requires

Adopting §6 and §11 changes what is bannable. Each of these is a same-PR
obligation, not a follow-up:

| Change | Ratchet consequence |
|---|---|
| `.liftable` / `.hoverable-row` land in `index.css` | `tokens.test.ts` already skips `index.css`; no new exemption needed. But **add a pattern** banning per-component re-implementation: `hover:-translate-y-` and `hover:shadow-raised` outside `index.css` are now violations, because §6 owns lift. Migrate `ui/StatTile.tsx`'s `interactive` branch in the same PR or its baseline entry must be recorded. |
| Mode/ETA copy stops carrying hardcoded times (§11.2.3) | **Add a pattern** matching a time-range literal in `.tsx`/`.ts` — e.g. `/\d+\s*[–-]\s*\d+\+?\s*min/g` — with an initial baseline of **seven** offenders (`ModeCards.tsx:11,15,16`, `NewJobWizard.tsx:312,347`, `ProgressBanner.tsx:208`, `labels.ts:122`), so the count can only go down. Note the pattern must cover `.ts`, not just `.tsx` — one offender is in `utils/labels.ts`. This is the mechanical guard against the 40-minute cap creeping back in as prose. |
| Custom inline icon SVG is banned (§10) | **Add a pattern** matching `<svg` in `.tsx` outside an allowlist. Today the only legitimate inline SVG is whatever `QualityGauge` and `Spinner` draw; record their baselines, ban new ones. Do **not** pair this with a ban on `react-bootstrap-icons` imports — that package is in scoped, intentional use (§10); the correct ratchet is a pattern allowing it **only** in `FileTypeIcon.tsx` and `WorkItemTypeBadge.tsx`. |
| Plex migration (§1.8 row A) | No new ratchet. Close the row, move it to §18. |

---

## §16 — Negative constraints

Mechanically checkable, and not re-litigable without a §17 change to this file.

1. No raw hex in `frontend/src/**/*.tsx` outside the four allowlisted
   data-palette files.
2. No Tailwind default-palette utilities (`bg-slate-50` etc.) — deleted by
   `--color-*: initial`.
3. No arbitrary type sizes. `text-[Npx]` is banned; exactly 8 rungs exist.
4. No arbitrary durations or easings. `duration-[Nms]`,
   `animate-[name_Nms_easing]`, and inline `cubic-bezier(` are banned; always
   reference `var(--duration-*)` / `var(--ease-*)`.
5. No arbitrary radii. `rounded-[Npx]` and bare `rounded` are banned; exactly
   four values exist (`sm`/`md`/`lg`/`full`).
6. No bare `transition` — the property list is always explicit.
7. **`--color-signal` may appear on exactly one element class:** the
   confirm-to-ADO / irreversible-write CTA and its acknowledgement affordance.
   Not on focus rings, stat-tile accents, status chips, toasts, lifecycle steps,
   or the `Start job` button.
8. **`--color-rail-*` may appear only in `components/AppShell.tsx`'s `<nav>` and
   its children.** Nowhere else. The app's one other dark surface is
   `NarrationTicker`'s `bg-ink-1` strip, which is an `ink` token, not a rail
   token (§2). No third dark surface without §17.
9. No gradients on interactive elements. Two gradients exist in the system — the
   determinate progress fill, and the hatched "projected"/"unset" fill (§11.2.2,
   §11.3). Both are data encodings, not decoration. No third.
10. No serif faces. No decorative faces. No fourth family.
11. No shadow on any element smaller than 24px in either dimension, and no
    shadow on chips, badges, inputs, or table rows.
12. No motion without a state change. Nothing animates on mount that did not
    change; no decorative background motion; no hover motion on icons or text
    links.
13. No transform other than `translateY`, `scale`/`scaleY`, and `translateX`
    (the last only for the indeterminate progress loop). No rotation outside
    `Spinner`. No skew, no 3-D.
14. No border-radius above 16px except `rounded-full` on pills, dots, avatars,
    and progress-track caps.
15. No nesting a `Card` inside a `Card`.
16. No new `@keyframes` without an entry in the §8 motion table.
17. No MUI, no `theme/tokens.ts`, no second token file.
18. **No dark mode.** See §14.
19. **No per-component hover invention.** Every repeated interactive surface uses
    `.liftable` or `.hoverable-row` (§6). A component that spells out its own
    `hover:-translate-y-*` / `hover:shadow-raised` is a violation, not a
    variation. **Rows never lift.**
20. **No two progress bars showing one quantity.** One phase, one bar, labelled
    in the unit it is actually counting (§11.3).
21. **No cap, clamp, or ceiling on the ETA value** (§11.2.3). Presentation may be
    ranged and softened; the underlying estimate is never clamped, at any layer,
    and neither is any single input's contribution to it. No hardcoded time
    strings in copy. **No guessing a model's speed from its name** — a model
    with no observed history is exactly `1.0×`, never optimistic, never
    pessimistic (§11.2.3.c). **And no hand-picked coefficients**: the estimate
    is fitted from this deployment's own completed runs, blended toward an
    explicitly-unvalidated bootstrap while `n` is small, and computed
    **server-side** — never re-derived in the browser (§11.2.3.c, §11.2.3.d).
22. **No greying out a metric that does not exist, and no inferring the type
    gate from the data.** If a metric is undefined for a work-item type — the
    quality gauge on an Epic — the element is absent, not disabled. The gate
    reads the **ADO work-item type**, explicitly; a null/presence check on the
    value itself is a proxy, not the rule, and is a violation even when it
    happens to produce the same output (§11.4.1).
23. **No zero as a placeholder.** Unknown renders `--`.
24. No custom inline icon SVG, and no third icon package. `lucide-react`
    everywhere, with `react-bootstrap-icons` permitted **only** inside
    `components/FileTypeIcon.tsx` and `components/WorkItemTypeBadge.tsx` (§10).

---

## §17 — Change protocol

- **Adding a token** requires, in the same PR: a role row in §2, a contrast row
  in §3 if it is a colour, and a §15 ratchet or allowlist update if it changes
  what is bannable.
- **Removing or renaming a token** requires a §18 ledger entry naming every file
  that referenced it.
- **Closing a §1.8 divergence** means changing the code, deleting the row, and
  adding a §18 entry — never deleting the row alone.
- **Relaxing a §16 constraint** requires an explicit rationale in the PR
  description. §16.7 (signal), §16.18 (dark mode), §16.19 (hover system),
  §16.21 (ETA cap) and §16.22 (absent-not-greyed) each encode a decision that
  was made once, deliberately, against a plausible-sounding alternative. Treat a
  proposal to relax one as a proposal to repeat a resolved argument.
- Every new component states its §7 category and §5 geometry before it states
  its look.

---

## §18 — Migration ledger

Append-only. Every renamed or removed token, and every closed §1.8 divergence.

| Old | New | Notes |
|---|---|---|
| `--color-navy-900` | `--color-rail-900` | Deprecated alias during transition, then removed. |
| `--color-navy-700` | `--color-rail-hover` | |
| `--color-navy-600` | `--color-rail-active` **or** `--color-accent` | Per-call-site decision, not a mechanical rename — most `navy-600` uses were accent/interactive semantics, not rail semantics. |
| `--color-navy-300` | `--color-rail-indicator` **or** `--color-accent` | Same caveat. |
| `--color-surface-alt` | value changed `#f1f4fa` → `#f6f8fc` | Was identical to `canvas`, so "recessed inside a card" and "page background" were indistinguishable. Value-only, no call-site edits. |
| `--color-ink-3` | value changed `#64748b` → `#5b6a80` | Fixes an SC 1.4.3 failure on `canvas` (4.33:1 → 5.00:1). Value-only. |
| bare `--radius` (Tailwind's deprecated 4px fallback) | removed | Every bare `rounded` call site resolves to an explicit rung. |
| `--color-signal` as a focus ring | `--color-focus` (`accent`) | Fixes an SC 1.4.11 failure (1.31:1 → 6.31:1). |
| `--color-hairline-strong` as an input border | `--color-field-border` | Fixes an SC 1.4.11 failure (1.52:1 → 3.09:1). |
| `eta.ts` SURVEY upper clamp `Math.min(40, …)` | removed 2026-08-05 | Floor retained. See §11.2.3 and `docs/ui-progress-review.md` §1. **Do not restore.** |
| Static ETA coefficients `SURVEY_MINUTES_PER_BLOCK = 0.5`, `SURVEY_MINUTES_PER_FIGURE = 2.0`, and the name-parsed model multiplier (`MODEL_SIZE_PATTERN`, `MODEL_SIZE_SMALL_MAX_B`, `MODEL_SIZE_LARGE_MIN_B`, `MODEL_SPEED_MULTIPLIERS`, `modelSpeedMultiplier()`) | **replaced** by a least-squares fit over real completed-job durations (§11.2.3.c) | **Reversed, not re-tuned.** The static formula predicted **434–564 min** for `AirPro_BP_ICD_Revision_0.3.docx` (682 blocks, 39 figures) — a document that **actually completed in ~90 min** real elapsed time. Wrong by **~5×**, discovered via direct user report. This was the *second* falsification of a hand-picked constant in this section (the first: an audit found the mockup's own displayed numbers did not match the formula it claimed to implement), so the coefficients were **not** re-fitted a third time from a single point — the technique was replaced. Coefficients now come from this deployment's own `Job` history, shrunk toward an explicitly-unvalidated bootstrap while `n` is small. The name-parsed multiplier is deleted outright: its own supporting evidence contained the counterexample (`qwen3:4b` parses `small` → `0.85×`; `llm-client.interface.ts:53-59` records it producing 40+ minute calls). **Do not restore either.** |
| ETA fitted on `Job.createdAt → Job.completedAt` | `Job.startedAt → Job.diffReadyAt` (both new) | **Never shipped — caught in review.** `completedAt` is set in exactly one place, `jobs.service.ts:1201` inside `confirm()`, i.e. when a *human* clicks approve (`job-retention.service.ts:16` states this in its own comment). That span includes unbounded reviewer idle time. Fitting a document-size regression on it fits lunch breaks. See §11.2.3.b. |
| ETA sample filter `status = 'succeeded'` | `diffReadyAt IS NOT NULL` | **Never shipped — caught in review.** `succeeded` is only reachable through `confirm()`, so the `succeeded` filter discards every **rejected** job — each of which ran the full pipeline and produced a valid duration. Rejection judges the output, not the clock. See §11.2.3.b. |
| Dedup phase's two progress bars, one mislabelled `blocks` | one bar, labelled `proposed items` | **Closed.** `ProgressBanner.tsx:437-445`. Was an §18.1 open migration; verified fixed in code. §16.20 is now a regression guard. |
| Running-job **activity log** on `rail-900` — this row previously claimed the log "was specified but never implemented" | **Correction, not a migration: that claim was wrong.** `ProgressBanner.tsx`'s raw "Activity log (N)" toggle (a collapsed-by-default `border-t` disclosure, chevron-expandable) is real, shipped code — it was never removed. `SectionStepList` (§11.3.1) is ALSO real, shipped code, rendered above it via the same component's `RunDetail`. **Both coexist today**, not one superseding the other. On inspection this reads as acceptable, not as the original "two look-alike competing cards" complaint: `SectionStepList` is the always-visible primary view; the raw log is a collapsed, secondary detail nested *inside* the same card, not a competing sibling card. `rail-*` staying nav-only (§16.8) is unaffected either way. Left as-is — the redundancy (two views of similar information) is real but low-priority, and re-architecting working, tested code to remove it was judged not worth the risk for this pass. |
| "`react-bootstrap-icons` is unused and must be removed" | **withdrawn** | The claim was factually wrong: it is imported by `FileTypeIcon.tsx:1` and `WorkItemTypeBadge.tsx:1`, the latter with a rationale comment in the file. §10 now scopes the dependency instead of banning it. |
| §14's "No rescore-after-edit UI" | **withdrawn** → §11.4.4 | It recorded the absence of a design, not a decision against one. Customer feedback: after rewriting an item there is no way to tell whether it got better. Now specified, including the backend routes it needs. |
| `type = Requirement → gauge shown` as a visible label | **removed from product UI** | A design-mockup annotation that leaked into the panel header. The gate is a rule about whether the section renders (§11.4.1); a rendered section does not announce its own gate condition (§11.4.3). |
| Quality section: standard names shown + glossed beside them (`EARS-conformant`, "EARS (a fixed sentence pattern...), INCOSE (...), ISO/IEC/IEEE 29148 (...)") | Standard names removed outright — "well-formed," "established requirements-writing practice" | **Reversed, not tuned.** §11.4.3, §12. The gloss-first draft shipped once; customer feedback was that the acronyms themselves, not their absence of explanation, were the problem. |
| `.lift` (per-call-site spelled-out hover) | `.liftable` (one class, `index.css` `@layer components`) | **Closed.** §6/§7, §1.8 row C. Migrated `ui/StatTile.tsx`, `ui/Card.tsx`; `DiffTree.tsx` rows migrated to the new `.hoverable-row` in the same pass (also removed its 2 baselined raw-hex literals — `hover:bg-[#EEF3FC]`/`bg-[#E7EFFC]` — replaced by `surface-alt`/`accent-soft` tokens; `palette.test.ts`'s `DiffTree.tsx` baseline entry removed). **Real bug found+fixed while migrating:** the first draft of `.liftable` used `@apply lift ...`, but `.lift` was never a real Tailwind utility — a bare selector that only ever existed inside the reduced-motion media query — so `@apply` silently no-op'd and the reduced-motion fallback broke for every migrated element; fixed by giving `.liftable` its own styles directly and repointing the reduced-motion rule from `.lift` to `.liftable`. **Also found+fixed (real spec violation, not part of this migration but caught while touching row hover):** `JobsList.tsx`'s row hover used `hover:bg-accent-soft` — §3's role table reserves `accent-soft` for "chosen," not "hovered"; changed to `hover:bg-surface-alt`. |
| **Real bug found+fixed, unrelated to this row but discovered while verifying it:** `.liftable`/`.hoverable-row` broke the PRODUCTION BUILD outright, undetected until now | `index.css` (`.liftable`, `.hoverable-row`, `.hoverable-row::before`) | Not a `.lift`/`@apply lift` issue (that was already fixed, see the row above) — a DIFFERENT, later bug in the SAME two classes. `@apply duration-base` / `@apply ... duration-instant ...` reference custom (non-numeric) `--duration-*` theme values; Tailwind v4.3.3 cannot resolve those via `@apply` at all — confirmed via an isolated rename test, and confirmed it is NOT about whether that class name is also used elsewhere as a literal `className` (`duration-instant` IS used that way in `JobsList.tsx:282` and still fails identically). `ease-out` is unaffected only because it's one of Tailwind's own CORE default utility names (this `@theme` block overrides its cubic-bezier value, but the name itself always exists regardless of scanning); `duration-base`/`duration-instant` are not core names. This had been silently broken since `.liftable`/`.hoverable-row` were first written — `vitest`/`tsc` never catch it (neither runs the real Tailwind CSS build). **Corrected claim from an earlier pass of this same section:** this repo's CI (`.github/workflows/ci.yml`, the `node` job) already runs `pnpm build` on every push/PR, which already invokes frontend's `tsc -b && vite build` — the real Tailwind build step already exists and already would have caught this. It sat undetected only because `.liftable`/`.hoverable-row` were added in an uncommitted working tree and never pushed for CI to see, not because CI is missing a step. No CI change needed. **Fixed** by setting `transition-duration: var(--duration-base)` / `var(--duration-instant)` directly instead of via `@apply`, matching how every other call site in this codebase already consumes these same vars (`animate-[fadeIn_var(--duration-base)_var(--ease-out)]`, etc.). |
| Inter Tight + Inter → IBM Plex Sans | `index.css` (`--font-display`/`--font-sans`), `main.tsx` (font imports), `package.json`/`pnpm-lock.yaml` (`@fontsource/ibm-plex-sans` added, `@fontsource-variable/inter-tight` removed) | **Closed.** §1.2/§1.8 row A. `--font-display`/`--font-sans` both now read `'IBM Plex Sans', 'Inter Variable', -apple-system, 'Segoe UI', sans-serif` verbatim, per §1.2's own target. `'Inter Variable'` stays as the declared fallback and its import stays in `main.tsx` (still real, still resolves if Plex Sans ever fails to load); `'Inter Tight'` is dropped entirely, not demoted — nothing references it any more, and its now-unused `@fontsource-variable/inter-tight` package was removed via `pnpm remove` (not left as dead weight). 4 static weights added (400/500/600/700, matching this app's real `font-weight` usage — the 600/700 already used by `--text-*--font-weight` tokens, 400/500 the Tailwind `font-normal`/`font-medium` defaults used pervasively elsewhere) — IBM Plex Sans has no variable-font build via `@fontsource`, matching the same static-weight pattern `@fontsource/ibm-plex-mono` (already in use) already follows. Verified via a real `npm run build` (not just `tsc`/`vitest`, which don't process Tailwind's CSS engine at all and would never have caught either this row's own change or the `.liftable`/`.hoverable-row` build-breaking bug found in the same pass, above) — this is the reason that pre-existing bug surfaced now rather than being silently reintroduced or left broken; the working directory was accidentally left with a stray, incorrect `npm install`-generated `frontend/package-lock.json` at one point mid-task (this repo is a pnpm workspace) — caught and reverted to its real committed state before anything was staged. |
| `StatTile` gains `icon` and `hint` props | `ui/StatTile.tsx` | **Closed.** §11.1. Wired at all 4 wizard tiles with the §10.1 lucide icons (`LayoutGrid`/`AlignLeft`/`Image`/`Layers`) and one-line plain-language hints via the existing `InfoTip` pattern — no new pattern introduced. |
| Step-1 stat tiles: `grid-cols-4` row → 2×2 grid | `pages/NewJobWizard.tsx:190` | **Closed.** §11.1. The fuller two-pane/document-map redesign this section also specifies was a separate, larger follow-up at the time — now also closed, see below. |
| Wizard step 1's full two-pane split + per-section "document map" | new `orchestrator/src/modules/pipeline/document-map.ts` (`buildDocumentMap`), `jobs.controller.ts`'s `preview()` (gains `tableCount`/`openTbdCount`/`documentMap`), `api/jobs.ts` (`PreviewResult`, deduplicated with the stale local copy that used to live in `NewJobWizard.tsx`), `pages/NewJobWizard.tsx` (`step===1` now a real `grid-cols-[1.6fr_1fr]` two-pane split, matching step 2's own pattern; new `DocumentMapList`/`WorthKnowingCard` components) | **Closed, with two honest, documented data gaps (not corner-cuts) — this section's own copy examples bundled data that turned out not to exist anywhere in the real parse output.** (1) The file-identity line specifies "size, **parse duration**, and section count" — parse duration is not tracked anywhere in this stack (checked: no field on `Job`, no timestamp captured around the `/ingest` call) and was not fabricated; shipped as size + section count only. (2) The footer button stays named **Next Step**, not renamed to **Configure** — this step's own action is "advance to the next screen," not "configure" anything (destination/mode config genuinely lives on step 2); relabeling it to match the mockup would misdescribe what the button does in this app's real two-step IA. Everything else shipped as specified: the `.hoverable-row` document map (§n/title/relative bar/block count/figure count, figure count dimmed at 28% opacity when zero), the "Worth knowing before you run it" card (3 real derived notes — table count, figure count, open-TBD count — each only from data `preview()` already returns, never invented; `TriangleAlert`/`--color-warning` on the risk-worthy one), the card's own real empty state, and `StatTile`'s `--`-not-`0` placeholder convention (already normative, unchanged). The interim `max-w-3xl` width cap from the AppShell viewport row above is superseded by this real fix, per that row's own note. 4 new orchestrator tests (`document-map.spec.ts`) + 2 updated `jobs.controller.spec.ts` fixtures, 3 new frontend tests. |
| Hardcoded time strings → derived from the real ETA | `components/ModeCards.tsx:11,15,16` → `MODE_COPY.estimate` deleted entirely, replaced by server-provided range props; `pages/NewJobWizard.tsx:312` (Alert), `:347`→ now the InfoTip described below; `components/ProgressBanner.tsx:208`; `utils/labels.ts:122` | **Closed.** §11.2.3/§15.1/§16.21. All rewritten to describe the *shape* of the cost (figures dominate — separate vision calls) with no numerals. `tokens.test.ts` gained the mechanical guard (`/\d+\s*[–-]\s*\d+\+?\s*min/g`) in the same change that fixed all offenders, so its baseline starts at zero rather than a temporary non-zero count. **Real trap caught in the same PR:** the new pattern initially matched this very migration's own explanatory comment in `ModeCards.tsx` ("a hardcoded '≈ 15-40 min' string") — reworded the comment to avoid the digit-dash-digit-min shape rather than weakening the ratchet. |
| **[1/4 — schema]** Five new nullable `Job` columns | `orchestrator/prisma/schema.prisma`, migration `20260809180000_add_job_eta_telemetry` | **Closed.** §11.2.3.b. |
| **[2/4 — write path]** Populate those five columns from the worker, not `submit()` | `pipeline.worker.ts:250` (`startedAt`/`model`, hoisted from the old spot right before the `/level` call), `:574` (`blockCount`/`figureCount`/`diffReadyAt`, piggybacked on the existing `diff_ready` update) | **Closed, with one deliberate deviation from this row's original text.** `model` is written at the **`running`** transition, not `diff_ready` as originally specified here — a job that fails mid-`/level` (the longest, most failure-prone stage) would otherwise never record its model, and [2b] below would silently drop the override for exactly the jobs users most want to resubmit. Both operands were already in scope at that earlier point. **Real bug found+fixed while implementing:** the worker's `doc.figures.length`/`doc.blocks.length` threw on existing test fixtures that don't always populate those fields — fixed with the same `(doc.figures ?? [])` defensive pattern the file already used one line above for `figureDescriptions`. |
| **[2b]** `resubmit()` silently drops the per-job `model` override | `jobs.service.ts:228-239` (now threads `model: job.model ?? undefined` through), `:43-47` (doc comment corrected — no longer claims `model` "is not persisted on the Job row") | **Closed.** §11.2.3.b. |
| **[3/4 — computation + API]** OLS fit + shrinkage + per-model ratio behind two routes | new `orchestrator/src/modules/pipeline/eta.service.ts` (+`eta.service.spec.ts`, 19 tests), `eta-estimate.dto.ts`; `jobs.controller.ts` — extended `preview()`, new `@Get('estimate')` (placed correctly before `:id`) | **Closed.** §11.2.3.c/.d. Full orchestrator suite green: 44/44 suites, 618/618 tests, clean `nest build`. |
| **[4/4 — frontend]** `computeEtaMinutes` deleted; wizard reads a server-provided number | `utils/eta.ts` (deleted `computeEtaMinutes`+constants, added `formatEtaRange`), `api/jobs.ts` (`getEstimate()`, `previewJob()` gains `estimate`), `NewJobWizard.tsx` (`Promise.all`-fetches both modes' estimates on `[blockCount, figureCount, model]`, with a request-sequence guard against out-of-order model-change responses), `ModeCards.tsx` (gains `baselineEstimate`/`surveyEstimate` props, renders `--` while unresolved) | **Closed.** §11.2.3.d/.e. `eta.test.ts:16-18`'s now-false "well over 300 minutes" comment was corrected, not silently deleted with its assertion — points at `eta.service.spec.ts`'s equivalent regression case instead. Full frontend suite green: 54/54 files, 384/384 tests. |
| **New ingestion route** for single-item rescoring | `ingestion/app/main.py` (`POST /score-item`, not `/score/item` as this row originally said — matches this service's existing flat-path convention, e.g. `/dedup/check`), new `ingestion/app/leveling/scoring.py:score_single_requirement_text` | **Closed.** §11.4.4. Reuses `_parse_category_scores` and the `RequirementQualityIssue` filter exactly as specified — a rescore can never hand the UI a shape the ingestion path would have rejected. 11 new ingestion tests (`test_scoring.py`, `test_score_item_endpoint.py`); full ingestion suite 976/976. |
| **Prerequisite: consistent rubric keys across a rescore** | resolved WITHOUT the DB persistence this row originally specified | **Closed, with a deliberate architectural deviation.** `llm_leveling.py`'s whole-document scoring pass resolves ONE `category_checklist` and applies it to every Requirement node in that pass — so any sibling Requirement in the same job that scored successfully already carries, in its own persisted `qualityCategoryScores` keys, the exact rubric this job actually used. `JobsService.rescoreDiffEntry`'s new `resolveCategoryChecklist` reuses that: the entry's own keys first, any scored sibling's second, `null` only if scoring never succeeded for the whole document (the same failure mode a persisted-but-never-written column would also hit). No new `Job` column, no migration. |
| **New orchestrator route** `POST /jobs/:id/diff/:localId/rescore` | `jobs.controller.ts` (`rescoreDiffEntry`), `jobs.service.ts` (`rescoreDiffEntry`, `resolveCategoryChecklist`), `IngestionHttpClient.scoreItem()` | **Closed, with one contract deviation.** Same `diff_ready` / `action === 'create'` guards as `editDiffEntry`, plus a `type === 'Requirement'` guard (Epic/Feature have no single-item scoring surface, per this section's own Scope limits). Returns only the updated `dryRunDiff` array, **not** an explicit previous-value pair — `NodeDetailPanel` already holds the previous score/categoryScores in its own props (`entry`) the instant before it calls this route, so it snapshots them client-side rather than the backend echoing back data the caller already has. 6 new `jobs.service.spec.ts` tests. |
| `editDiffEntry` sets `qualityStale: true` | `orchestrator/.../jobs.service.ts` | **Closed.** §11.4.4. Only when a real `description` change lands on an entry that already carries a `qualityScore` — a title-only edit changes nothing the score was judged against (scoring reads `description` alone), and an entry with no prior score has nothing to go stale. 4 new tests. |
| Refetch `GET /jobs/:id/summary` after a successful rescore | — | **Closed as not-needed, on inspection.** `JobSummaryReport.flagged` (`api/jobs.ts:214`) exists in the type but is **not rendered anywhere in `JobDetail.tsx` today** — only `created`/`reused`/`dedupSkipped` are shown as `StatTile`s. This row described a real risk for a UI state the current codebase doesn't have; nothing on screen can go stale, so no refetch was added. Revisit if a flagged-count tile is ever added. |
| `rescoreDiffEntry()` API client + gauge states (Scored/Stale/Re-checking/Rescored) | `api/jobs.ts` (`rescoreDiffEntry()`), `components/QualityGauge.tsx` (gains `previousScore`/`previousCategoryScores` props, a `formatDelta()` helper, the ▲/▼/no-change headline chip and per-category delta), `components/NodeDetailPanel.tsx` (owns the 4-state machine + the pre-rescore snapshot), `components/DiffTree.tsx` (`DryRunDiffEntry.qualityStale`) | **Closed, with one architectural deviation from this row's original text.** No separate `components/QualityDelta.tsx` was created — `QualityGauge` gained the delta-rendering props directly instead, staying the app's one gauge-rendering component rather than splitting it across two. State ownership (which of the 4 states is active, the pre-rescore snapshot, the `useRef` re-entry guard) still lives in the caller (`NodeDetailPanel`), matching this row's intent that the gauge component itself not own fetching. **Not shipped this pass** (kept open below): band-crossing sentences and "Cleared: &lt;flag&gt;" rows. 9 new tests across `QualityGauge.test.tsx`/`NodeDetailPanel.test.tsx`. |
| Chat model-selector tooltip gains the "this conversation only" scope sentence | `components/ChatPanel.tsx` | **Closed.** §11.4.2. Verbatim: "This applies to this conversation only — it does not change the model the job was analysed with." |
| `Assistant · <model>` attribution → `font-mono` on the model span | `components/ChatPanel.tsx` | **Closed.** §11.4.2, §0.1. Fixed the model span only, not the "Assistant ·" word, exactly as specified. |
| Chat empty state: static hint → clickable suggestion chips, each with a §10.1 glyph | `components/ChatPanel.tsx` | **Closed, with two deliberate, permanent deviations from this row's original spec (not open work — settled choices).** Shipped 3 chips with icons ("Make it testable" `Target`, "Add the missing rationale" `Flag`, "Tighten the wording" `Pencil`) — the fourth, "Suggest a better title" `Sparkles`, was deliberately NOT duplicated here; `ChatPanel.test.tsx` already has a regression guard against a second Suggest-a-title control, and the header button already covers it while staying reachable even once the chat has history, unlike an empty-state-only chip. Each chip sends immediately via the existing `send()` path (same behavior "Suggest a title" already has), not populate-then-let-the-user-edit as this row's original text specified — chosen for consistency with the one send affordance that already existed. Plain `Button variant="outline" size="sm"`, matching the header's own button, not `.liftable` (a card-hover treatment that doesn't fit a small text button). Heading updated to "No conversation yet / Ask in your own words, or start from one of these:" per spec. 3 new tests for the chips + icons together. |
| Stop button: immediate "Stopping…" UI state (frontend fix; the true-immediate-cancellation backend fix stays a separate follow-up, unchanged) | `components/ChatPanel.tsx` | **Closed.** §11.4.2/§11.3's "Streaming states." `stop()` gained the project-standard `useRef`+`useState` re-entry guard (checked/set before the `await`, cleared in `finally`); the button shows a `Spinner` + disabled state for the real cooperative-poll gap instead of looking unresponsive. 1 new test. |
| `DestinationBar` extended to the wizard's path bar (iteration + state segments, hatched-when-unset), used on both screens | `components/DestinationBar.tsx` (unchanged shared implementation — not rebuilt fresh, per this row's own instruction); new call site in `pages/NewJobWizard.tsx`'s Destination card | **Closed, with one honest scope reduction.** All 4 segments (Project/Area/Iteration/State) now render as their own `.hoverable-row` box with icon + uppercase key + value, iteration hatches (`repeating-linear-gradient`, `accent-soft`/`accent-soft-border`) instead of going blank when unset, and a `font-mono` preview line restates the full resolved destination below (`Radar Systems \ Radar Systems\EW Suite \ Rev C · state Proposed`). **Not shipped:** the "one sentence of consequence" this row's spec also asked for (e.g. "Proposed keeps new items out of sprint metrics..."). Checked `StatePicker.tsx`/`api/ado.ts`'s `getStates`: starting state is fetched LIVE per-project from ADO's own configurable workflow, an open org-defined list, not a small fixed enum — a hardcoded sentence for "Proposed" specifically would have no matching sentence for a custom state (e.g. "Triage", "Ready") and risks being actively wrong for an org whose "Proposed" doesn't behave like the example assumes. Real data doesn't exist to do this correctly; inventing text for an unknown value isn't a shortcut, it's a guess. A dedup regression test for identical project/area values was intentionally rewritten, not just relaxed: the old single-line unlabeled breadcrumb genuinely needed the dedup (two identical values with no distinguishing label read as a bug); each segment now carries its own key label, so showing the same value under two clearly-different labels is a real state, not a repeat to hide. 5 new tests. |
| Epic/Feature **Scope** group in place of the absent gauge | `components/NodeDetailPanel.tsx`, `components/NodeDetailDialog.tsx`, `pages/JobDetail.tsx` (`descendantCountsByLocalId`) | **Closed, with one honest scope reduction from this section's exact copy example.** This section's illustrative copy ("Covers §3 through §3.2 — 6 features, 41 requirements") bundles two different things: a section-number range and descendant counts. The counts are real and shipped — a new O(n) children-by-parent walk in `JobDetail.tsx`, threaded down the same way `diffByLocalId` already is. The section-number range is NOT shippable from real data: `DryRunSourceRef` is byte-offset-only (confirmed via `utils/sourceRef.ts`), there is no heading-number field anywhere in the diff entry shape, and inventing one via regex-parsing title text would be a guess, not real data — same category of gap as §11.1's own per-section breakdown (tracked separately, needs a new backend field). Shipped: "Covers 6 features, 41 requirements." / "No child items under this Epic yet." plus a plain "why no score" line. 4 new tests. |
| Band-crossing sentences ("Moved from Needs review into Solid") and **Cleared: &lt;flag&gt;** rows on a successful rescore | `components/QualityGauge.tsx` (`bandCrossingText`, `previousIssues` prop, `clearedByCategory`/`clearedOther`) | **Closed.** §11.4.4. Band-crossing sentences render on the headline and on any category row whose band actually changed, and nowhere else (a row that moved without crossing keeps only its numeral delta, per this section's own rule against decorating unmoved rows). Cleared-flag lines are grouped by category the exact same way active issues already are (reusing `categoryForIssueCode`, unmapped codes to "Other flags") and render always-visible, not gated behind the category's own expand disclosure — "the most direct evidence the edit worked... it is free," per this row's own reasoning. `NodeDetailPanel.tsx`'s pre-rescore snapshot extended to also capture `qualityIssues`. 5 new tests. |
| "Not scored yet" + **Score this item** for manually added entries | `components/NodeDetailPanel.tsx` | **Closed.** §11.4.4. Reuses the exact same `onRescore`/`rescoreDiffEntry` path a Stale item's Re-check quality button uses — `rescoreDiffEntry`'s guards (`diff_ready`, `action === 'create'`, `type === 'Requirement'`) never required a prior score, so this was additive, not new backend work. No delta/"Rescored." confirmation for a first-ever score (nothing to diff against). 3 new tests. |
| Category definitions move out of `InfoTip` onto the row | `components/QualityGauge.tsx` (`CategoryRow`) | **Closed.** §11.4.3. Every row can now expand (not only ones with a mapped issue) into the same `grid-template-rows` disclosure the issue remedies already used — the definition (`KNOWN_CATEGORY_DESCRIPTIONS`/KB-derived fallback) is its first line, real text in the DOM, not an `InfoTip` hover. The per-row `InfoTip` was removed entirely (the gauge's one top-level InfoTip, explaining the overall metric, is untouched). 2 tests updated, 1 new test. |
| `CollapsibleWarnings` literal amber hex → `warning-*` tokens | `components/CollapsibleWarnings.tsx`, `index.css` (new `--color-warning-ink-dim`) | **Closed.** §11.3.3, §16.1. 3 of 4 values matched an existing token exactly (`warning-soft`/`warning-border`/`warning-ink`); the 4th (`#9A6B1F`, a hover/secondary shade) got the one new token this row called for. `palette.test.ts`'s baseline for this file dropped from 22 to 0 (removed from the map entirely, matching every other fully-clean file). |
| Stale type: `quality_category_scores` declared as a fixed 5-key object | `orchestrator/src/modules/pipeline/pipeline.worker.ts` → `Record<string, number>` | **Closed.** §11.4.3. Was structurally assignable so it compiled, but contradicted every other layer (`dry-run.service.ts`, `DiffTree.tsx`, `QualityGauge.tsx` all already used `Record<string, number>`). New regression test proves a KB-derived key set (`Necessary`/`Verifiable`, not the fixed clarity/testability/atomicity/style/rationale set) survives the mapping unchanged. |
| `resubmit()`'s model-pinning semantic — flagged as undiscussed, not undone | `jobs.service.ts:228-239` | **Closed as a documentation item, not code.** Re-verified: the row never asked for a code change — it recorded a deliberate design choice ("resubmit means run this again, not run this again under today's config") that no earlier section had discussed. That discussion now exists (§11.2.3.b + this row); nothing left to build. |
| **Quality gauge gate: `entry.qualityScore != null` → explicit ADO work-item-type check** | `components/NodeDetailPanel.tsx:290` | **Closed — this §18.1 row was stale.** Re-verified against real code: the gate is `entry.type === 'Requirement'`, not a `qualityScore != null` proxy (grep confirms zero remaining `qualityScore != null` gate checks and zero remaining "Judged against" text anywhere in the file). This was CR-7a, closed earlier in the same session as CR-7c/7d/8/9 — the ledger row was never moved up at the time. |
| Quality card copy: gate badge deleted; plain-language sub-line; two-line provenance replacing the "Judged against…" line and its tooltip | `components/NodeDetailPanel.tsx:358-370` | **Closed — this §18.1 row was stale,** same CR-7b bookkeeping gap as the row above. Re-verified: no gate badge, no "Judged against" text anywhere in the file; the two-line provenance block (wording-only scope statement + established-practice/KB-citation-count line) is live. |
| **Stage 1** — flags regrouped under the category bar they belong to, remedy text visible not tooltip-only; unmapped and KB-derived cases fall to an "Other flags" group | `utils/qualityCategories.ts`; `components/QualityGauge.tsx` | **Closed — this §18.1 row was stale,** same CR-7c bookkeeping gap. Re-verified: `issuesByCategory` regroup logic and the "Other flags" fallback section are both live in `QualityGauge.tsx`. |
| Category rows become `grid-template-rows` disclosures (`aria-expanded`, closed by default, multiple open allowed, reset on `entry.localId`) | `components/QualityGauge.tsx` | **Closed — this §18.1 row was stale,** same CR-7c bookkeeping gap, but the "reset on `entry.localId`" clause was NOT actually true and is a real bug found while re-verifying this row (not a documentation-only gap like its siblings above). `CategoryRow`'s toggle button carries `aria-expanded`, the disclosure uses `grid-template-rows: 0fr→1fr`, and `expandedCategories` is a `Set` allowing multiple open — all real. But `QualityGauge` owns `expandedCategories` as its OWN internal state with no prop tying it to the selected entry, and `NodeDetailPanel.tsx` rendered it with no `key` — React reused the same component instance across different selected nodes, so a category left expanded on one Requirement stayed expanded when switching to a different one. **Fixed:** `key={entry.localId}` on the `<QualityGauge>` call site, forcing a real remount (and state reset) on every node switch. New regression test in `NodeDetailPanel.test.tsx`. |
| **[1/3 — ingestion]** Flat `warnings: list[str]` → structured `IntegrityWarning` (`kind`/`severity`/`node_ids`/`detail`/`raw`), plus a `_finalize_warnings` grouping pass collapsing still-per-node emission sites (re-parented-to-Feature, front-matter-folded, low-grounding, etc.) into one summary record per group | `ingestion/app/workitem/model.py` (`IntegrityWarning`, `WarningKind`, `WarningSeverity`, `WARNING_SEVERITY` map); every emission site across `root_regrouping.py`, `llm_leveling.py`, `id_tree_builder.py`, `id_hierarchy.py`, `tree_builder.py`, `trace_links.py`, `scoring.py`, `conflict_detection.py`; new `leveling/warnings_finalize.py`; `shared/schemas/work-item-tree.schema.json` (`IntegrityWarning` definition) + regenerated `shared/ts` | **Closed, wording since revised — see the row below.** §11.3.3. Every site still building a per-occurrence message keeps computing a sentence, just wraps it in a structured record instead of appending the bare string (the sentence text itself was reworded in a follow-up pass, below); `_finalize_warnings` runs once, in `build_survey_tree`/`build_baseline_tree`, right before `WorkItemTree` construction — a single-occurrence group is returned byte-identical (no format change for the common case), a multi-occurrence group collapses to one regenerated summary. The one deliberate removal (not reclassification): the "N of M block(s) built deterministically" informational split — never actionable, never a defect signal — is dropped from `warnings` entirely rather than migrated. Real gap found and closed while auditing every `warnings.append` site for this migration: `id_tree_builder.py`'s title-tag/parent-summary/synthesis enhancement passes and `tree_builder.py`'s front-matter-fold warnings were still plain strings even though `llm_leveling.py`'s own sites had already been the ones motivating this row — all converted in the same pass, none left half-migrated. 6 new tests (`test_warnings_finalize.py`) + a new schema-conformance case (`test_worktree_schema_conformance.py`) proving a REAL non-empty `warnings` list validates, not just the empty-array fixtures every existing conformance test happened to produce. Full ingestion suite: 979/979. |
| **[2/3 — orchestrator]** `WarningRecord` (camelCase) mirrors ingestion's `IntegrityWarning`; `Job.warnings` threaded as `(WarningRecord \| string)[]` | `orchestrator/src/modules/writeback/dry-run.service.ts` (`WarningRecord`); `pipeline.worker.ts` (`LeveledWarning` raw-wire type, mapped to `WarningRecord` before the `Job.update` write; `verifyExistingAdoIdsStillExist`'s `onError` string wrapped into a `kind: 'ado_verification_failed'` record at this same call site, not inside `dry-run.service.ts` itself); `jobs.service.ts`/`jobs.controller.ts` (`getById`/`getSummary` return types) | **Closed.** `ado_verification_failed` is deliberately absent from ingestion's own `WarningKind`/schema enum — it's the orchestrator's own post-processing addition, never present in a real `/level` response. No Prisma migration: `warnings` was already `Json?`; old rows keep their literal `string[]`, new rows get `WarningRecord[]`, both are valid `Json`. 3 new tests (`pipeline.worker.spec.ts` ×2, `jobs.service.spec.ts` ×1) proving the mapping and the verification-failure path both produce a structured record, not a string. Full orchestrator suite: 641/641, clean `nest build`. |
| **[3/3 — frontend]** Severity-tiered `CollapsibleWarnings` (see §11.3.3's own rewrite) + `normalizeWarning`/`titleByLocalId` + the `DiffTree` `selectedId` navigation fix | `utils/warnings.ts` (new: `WarningRecord`, `normalizeWarning`); `components/CollapsibleWarnings.tsx` (full rewrite); `pages/JobDetail.tsx` (`mergedWarnings` now normalizes both `warnings` and `liveWarnings`; `titleByLocalId`; `onJumpToNode` opens the dialog); `components/DiffTree.tsx` (`allRows` memo, two `selectedId` effects) | **Closed.** §11.3.3. 11 tests in `CollapsibleWarnings.test.tsx` (rewritten), 5 in `warnings.test.ts` (new), 3 new in `DiffTree.test.tsx` (mocks `react-window`'s `FixedSizeList` via `vi.hoisted` to spy on `scrollToItem`, since the real component's virtualization has no observable jsdom effect otherwise). Full frontend suite: 452/452, clean `tsc -b && vite build`. |
| **Follow-up, same day** — `raw` sentence wording still leaked ingestion's own internal identifiers (`det0_h9_3`, `f14`, `[localId: det0_h6_1_2_1]`) into user-facing text, even after the [1/3]-[3/3] structural migration above -- confirmed real gap, user-reported: severity/grouping was the right shape, but the actual prose was still unreadable to anyone who's never seen ingestion's own node-numbering scheme | Every per-node/per-section `raw`-building site across `root_regrouping.py`, `llm_leveling.py` (incl. `_referenced_attachment_warnings`, re-keyed on `section_label` instead of `node_id_prefix`), `scoring.py`, `tree_builder.py`, `conflict_detection.py`; `warnings_finalize.py`'s `_reparented_to_feature`/`_group_reparented` summary builders (now read a `*Title` detail key, not the raw id) | **Closed.** §11.3.3. Systematic substitution: a node/target reference in prose is now always its real `title` (quoted), never `local_id`/`temp_id`; a section reference is `_derive_section_label`'s real heading text (already computed for narration, just not threaded into these messages before), never `node_id_prefix`; a dropped figure/table reference is a count ("referenced 1 figure(s) not offered"), never the raw id list; the near-duplicate-conflict `[localId: ...]` tag is dropped from `raw` entirely now that the structured `node_ids` field (not text-parsing) drives the frontend's Review buttons — `CollapsibleWarnings.tsx`'s tip copy updated to match (no longer explains a tag that no longer appears). Table-group/heading-ID-offset messages were audited and left untouched -- their "ids" (`row.id_text`, a table's own dotted numbering) are the SOURCE DOCUMENT's real numbering, not ingestion's synthetic scheme, and are meaningful to a reviewer holding the original doc. `detail` payloads are unaffected (ids still live there for the UI's own navigation, just never surfaced as prose). 10 existing tests updated for the new wording, 979/979 ingestion suite green; frontend: tip-copy fix + fixture cleanup, 452/452 green. |

### §18.1 — Open migrations

These are prescribed here and not yet in the code. Each closes by editing the
code, then moving its row up into §18.

| Item | Target | Tracking |
|---|---|---|
| `--text-*` / `--radius-*` / `--shadow-*` / `--duration-*` / `--ease-*` `: initial` | `index.css` `@theme` | §1.8 row B |
| **Stage 2** — per-category `why` / `fix` strings from the model | `_response_schemas.py` (`scores_schema`, `epic_feature_scores_schema`), both `score_*.v1.txt` prompts, `orchestrator_llm_client.py:846-914`, `scoring.py:326-349`, `model.py:62`, regenerated `shared/ts`, `dry-run.service.ts:23`, `pipeline.worker.ts:202`, `DiffTree.tsx:71`, `QualityGauge.tsx:23` | §11.4.3 — new data end to end; no DB migration (`dryRunDiff` is JSON) |
