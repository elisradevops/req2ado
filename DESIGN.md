# req2ado — Design Language

**Status: normative.** This file is the single source of truth for the visual
system. `frontend/src/index.css`'s `@theme` block is its machine-readable
projection and must never diverge from it — if a token exists in one and not
the other, that is a bug, not a style choice.

This supersedes:
- `docs/design-decisions.md` §"Visual language: Deep Indigo Enterprise" (stale: prescribed MUI 6, a deleted `theme/tokens.ts`, cyan `#06B6D4` as the interactive accent). The rest of that file — app-shell shape, split-view Job Detail, the two-step wizard, area-path picker rationale, SSE approach — is unaffected and remains current.
- `docs/handoff-frontend-rebuild.md` line 40 (same stale `theme/tokens.ts` claim). Rest of that file is a dated snapshot, banner added.
- The `DESIGN.md` that existed at this path in git history before this rewrite — it was a Stitch tool-brief, not an engineering standard. Its screen/dialog/toast inventory was salvaged into `docs/ui-inventory.md` before deletion.
- `CLAUDE-DESIGN.md`, formerly at repo root — a claude.ai/design (`/design-sync`) tool-brief. Deleted outright, not resurrected. Its token block duplicated `index.css`; its interaction-state table is superseded by §7 below.

Both deletions are intentional. Do not restore either file from `git log`.

---

## §0 — What this app is, and why that constrains the visual system

req2ado is a **traceability ledger** whose terminal action writes irreversibly
into a customer's Azure DevOps server. Everything below derives from three
non-negotiables that follow directly from that sentence:

1. **Identifiers are set in mono, always.** A clause number, an ADO ID, an
   area path, a job UUID — anything a human or a script might copy-paste and
   expect to match exactly — is `font-mono`. Prose is never mono; identifiers
   are never proportional.
2. **Exactly one colour means "this cannot be undone."** Signal-yellow. It
   appears nowhere else in the system. If it did, a user habituates to it and
   stops reading it as a warning.
3. **No visual state may be ambiguous between "proposed" and "written."** A
   diff row, a stepper node, a status chip — every one of them must be
   unambiguously readable as either a draft the system is proposing or a fact
   that now exists in ADO. This is the single most important thing the design
   protects against, because the cost of confusing the two is a customer's
   production work-item tracker.

---

## §1 — Product thesis, restated as constraint

See §0. (Kept as a separate numbered section so §16's change protocol can
reference "does this violate §1" as a standing question for every new token
or component.)

---

## §2 — Token layer (normative)

The complete `@theme` block. **A value not in this block does not exist** —
no component may introduce a hex, a pixel size, or a duration outside it.

### §2.1 — Colour

```css
@theme {
  /* ------------------------------------------------------------------
   * 0. DELETIONS — make the system enforceable, not aspirational.
   *    Verified safe: grep for Tailwind default-palette utilities
   *    (bg|text|border-(slate|gray|zinc|red|...)-\d{2,3}) across
   *    frontend/src/**/*.tsx returns ZERO hits today.
   * ------------------------------------------------------------------ */
  --color-*: initial;   /* deletes red-500, slate-200, etc. (~280 utilities) */

  /* ------------------------------------------------------------------
   * 1. PRIMITIVES (restored after --color-*: initial)
   * ------------------------------------------------------------------ */
  --color-white: #ffffff;
  --color-transparent: transparent;
  --color-current: currentColor;
  --color-inherit: inherit;

  /* ------------------------------------------------------------------
   * 2. SURFACES — three levels, no more. Depth beyond this is hairlines,
   *    never a fourth surface tone.
   * ------------------------------------------------------------------ */
  --color-canvas: #f1f4fa;          /* page background, behind everything */
  --color-surface: #ffffff;         /* cards, dialogs, popovers, inputs */
  --color-surface-alt: #f6f8fc;     /* recessed-inside-a-card / row hover */
  --color-surface-sunken: #eaeff7;  /* table headers, code blocks, track fills */
  --color-scrim: rgba(11, 18, 32, 0.45); /* dialog overlay */

  /* ------------------------------------------------------------------
   * 3. HAIRLINES & CONTROL BOUNDARIES
   * ------------------------------------------------------------------ */
  --color-hairline: #dde4ee;         /* decorative dividers — exempt from 3:1 */
  --color-hairline-strong: #c9d2e2;  /* emphasised dividers, table rules */
  --color-field-border: #8494ab;     /* every input/select/checkbox border — 3.09:1 */

  /* ------------------------------------------------------------------
   * 4. INK
   * ------------------------------------------------------------------ */
  --color-ink-1: #0b1220;            /* 14.2:1 on white — headings, primary text */
  --color-ink-2: #334155;            /* 10.4:1 — body, secondary */
  --color-ink-3: #5b6a80;            /*  5.49:1 on surface, 5.00:1 on canvas — captions, disabled */
  --color-ink-on-dark: #e6eaf5;      /* text on rail / tooltip / toast */
  --color-ink-on-dark-dim: #c6d0e8;  /* secondary text on dark surfaces */

  /* ------------------------------------------------------------------
   * 5. ACTION — primary affirmative action. Ink-black.
   *    Hover LIGHTENS: an ink-black button cannot meaningfully darken.
   * ------------------------------------------------------------------ */
  --color-action: #0b1220;
  --color-action-hover: #1b2438;
  --color-action-active: #05090f;
  --color-action-ink: #ffffff;       /* 14.2:1 */

  /* ------------------------------------------------------------------
   * 6. ACCENT — indigo. The ONE interactive/selected colour. Everything
   *    that means "pointed at / chosen / focused" is this and nothing else.
   * ------------------------------------------------------------------ */
  --color-accent: #4f46e5;           /* 6.31:1 on white, 5.74:1 on canvas */
  --color-accent-hover: #4338ca;
  --color-accent-active: #3730a3;
  --color-accent-soft: #eef2ff;      /* selected-row / selected-card fill */
  --color-accent-soft-border: #c7d2fe;
  --color-accent-ink: #3730a3;       /* 8.85:1 on accent-soft */
  --color-accent-on-dark: #a5b4fc;   /* 8.4:1 on rail-900 — focus ring on dark surfaces */

  /* ------------------------------------------------------------------
   * 7. FOCUS — aliases, so "focus ring colour" is one token, not a choice.
   * ------------------------------------------------------------------ */
  --color-focus: #4f46e5;
  --color-focus-on-dark: #a5b4fc;

  /* ------------------------------------------------------------------
   * 8. RAIL — the app shell's nav rail ONLY. See §3 forbidden column.
   * ------------------------------------------------------------------ */
  --color-rail-900: #0f1b3d;
  --color-rail-hover: #17306b;
  --color-rail-active: #1b458f;
  --color-rail-indicator: #3b60c0;

  /* ------------------------------------------------------------------
   * 9. SIGNAL — irreversible / confirm-to-ADO ONLY. Never a focus ring
   *    (#fde134 on white measures 1.31:1 — fails WCAG 2.2 SC 1.4.11's
   *    3:1 floor for focus indicators). Never a stat-tile accent, never
   *    a status chip, never a toast.
   * ------------------------------------------------------------------ */
  --color-signal: #fde134;
  --color-signal-hover: #ffe95c;
  --color-signal-border: #e3c821;
  --color-signal-deep: #7a5c00;      /* 4.74:1 on signal */
  --color-signal-ink: #0b1220;       /* 14.2:1 on signal — CTA label */

  /* ------------------------------------------------------------------
   * 10. SEMANTIC STATUS — fill / soft / border / ink quad per severity,
   *     so an Alert, a chip, and a toast in the same severity are
   *     provably the same colour.
   * ------------------------------------------------------------------ */
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

  --color-live: #06b6d4;             /* streaming / in-flight ONLY — never static */
  --color-live-soft: #ecfeff;

  --color-shimmer-highlight: #e6ebf4;

  /* ------------------------------------------------------------------
   * 11. DATA PALETTES — real ADO values. Allowlisted for raw hex in
   *     the four files that render them (utils/tagColors.ts,
   *     KbCitationChips.tsx, WorkItemTypeBadge.tsx, FileTypeIcon.tsx).
   * ------------------------------------------------------------------ */
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

### §2.2 — Typography

```css
  /* ------------------------------------------------------------------
   * 12. TYPE FAMILIES — IBM Plex Sans (body/display), IBM Plex Mono
   *     (identifiers). See §11 for why: closes the seam between mono
   *     identifiers and their labels within one type family instead of
   *     gluing Inter Tight + Inter + Plex Mono together.
   * ------------------------------------------------------------------ */
  --font-display: 'IBM Plex Sans', 'Inter Variable', -apple-system, 'Segoe UI', sans-serif;
  --font-sans: 'IBM Plex Sans', 'Inter Variable', -apple-system, 'Segoe UI', sans-serif;
  --font-mono: 'IBM Plex Mono', ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;

  /* ------------------------------------------------------------------
   * 13. TYPE SCALE — 8 rungs, numeric, closed set. No text-[Npx] exists.
   *     xs/sm/base keep Tailwind's exact px so existing call sites
   *     using those names need no edit — only their line-heights are
   *     pinned to integers.
   * ------------------------------------------------------------------ */
  --text-micro: 10px;               /* eyebrow labels, stat-tile captions */
  --text-micro--line-height: 14px;
  --text-micro--letter-spacing: 0.06em;
  --text-micro--font-weight: 600;

  --text-meta: 11px;                /* field labels, badge text, mono ids in rows */
  --text-meta--line-height: 15px;
  --text-meta--letter-spacing: 0.04em;

  --text-xs: 12px;                  /* helper text, chips, dense table cells */
  --text-xs--line-height: 16px;

  --text-sm: 14px;                  /* DEFAULT UI TEXT — buttons, rows, labels */
  --text-sm--line-height: 20px;

  --text-base: 16px;                /* prose only: Markdown body, Wiki, Help */
  --text-base--line-height: 24px;

  --text-title: 17px;               /* dialog titles, card section headers */
  --text-title--line-height: 24px;
  --text-title--letter-spacing: -0.01em;
  --text-title--font-weight: 600;

  --text-display: 22px;             /* PageHeader — the only page-level title */
  --text-display--line-height: 28px;
  --text-display--letter-spacing: -0.022em;
  --text-display--font-weight: 700;

  --text-metric: 24px;              /* StatTile / QualityGauge numerals only */
  --text-metric--line-height: 28px;
  --text-metric--letter-spacing: -0.02em;
  --text-metric--font-weight: 600;
```

**Mono-identifier rule:** any ADO work-item ID, job UUID, area/iteration
path, clause number, or field name renders `font-mono`. Any number that
changes in place (elapsed timers, live counters, block/table/figure counts)
renders with `tabular-nums` so digit width doesn't jitter as it updates.
Long hierarchical identifiers (area paths, iteration paths, clause paths)
render `font-mono text-meta` with `truncate` and a `Tooltip` carrying the
full value — never a condensed face, never smaller than `text-meta`.

### §2.3 — Spacing

**Decision: adopt Tailwind v4's dynamic scale (`--spacing: 0.25rem`)
explicitly. No named spacing tokens are added.**

```css
  --spacing: 0.25rem;               /* 4px base; n and n.5 both legal */
```

Justification:
- Tailwind v4's dynamic scale already compiles `p-3.5` (14px) and `px-4.5`
  (18px) — the latter is in production use (`AppShell.tsx:176`). Named
  tokens (`--spacing-tight`, `--spacing-cozy`) would create a *second*
  vocabulary alongside the numeric one that Tailwind cannot suppress —
  exactly the drift this document exists to prevent.
- There is zero arbitrary-spacing debt to migrate: a grep for
  `(p|m|gap|space)[trblxy]?-\[[0-9.]+px\]` across `frontend/src/**/*.tsx`
  returns zero hits. The discipline already exists; this section records
  it rather than building new machinery for it.

**Permitted spacing rungs:** `0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 8, 10, 12, 16`
(0, 2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 32, 40, 48, 64 px).

**Banned:** `p-7`, `p-9`, `p-11`, `p-13`, `p-14`, any `n.5` above `4.5`,
and every `p-[Npx]`. Above 16px, jumps are perceptual, not incremental —
in a dense, tabular app, `p-7` vs `p-8` is noise a reviewer cannot
adjudicate.

One grandfathered exception, named so it doesn't read as an oversight:
`ui/EmptyState.tsx`'s `py-11`/`px-6` — an empty state is deliberately the
least dense surface in the app. Migrate to `py-12` (a legal rung) in the
same pass that touches that file.

### §2.4 — Radius

```css
  --radius-*: initial;   /* deletes xs/xl/2xl/3xl/4xl AND the deprecated
                            bare --radius: 0.25rem that Tailwind v4 falls
                            back to for bare `rounded` when unset */
  --radius-sm: 6px;      /* buttons, inputs, chips-that-are-not-pills, menu items */
  --radius-md: 10px;     /* cards, tiles, dialogs, popovers, alerts */
  --radius-lg: 16px;     /* full-bleed panels, the dropzone, hero surfaces */
  /* rounded-full remains available as a static Tailwind value, not a
     theme key — used for pills, dots, avatars only. */
```

Exactly four radius values exist in the whole app: `sm`, `md`, `lg`,
`full`. **Bare `rounded` and `rounded-[Npx]` are banned** — today 46 call
sites use bare `rounded`, which silently resolves to Tailwind's deprecated
4px fallback because the repo's `@theme` overrides `sm/md/lg` but never
the bare `--radius`. Every one of those 46 must be migrated to an explicit
rung.

### §2.5 — Elevation

```css
  --shadow-*: initial;
  --shadow-sm:      0px 1px 2px rgba(15, 27, 61, 0.05);
  --shadow-card:    0px 1px 2px rgba(15, 27, 61, 0.05),
                    0px 8px 20px rgba(15, 27, 61, 0.055);
  --shadow-raised:  0px 2px 4px rgba(15, 27, 61, 0.07),
                    0px 12px 26px rgba(15, 27, 61, 0.09);   /* pointer lift */
  --shadow-popover: 0px 2px 4px rgba(15, 27, 61, 0.07),
                    0px 16px 34px rgba(15, 27, 61, 0.10);
  --shadow-dialog:  0px 24px 64px rgba(11, 18, 32, 0.32);
  --shadow-cta:           0px 1px 0px rgba(122, 92, 0, 0.22);
  --shadow-cta-attention: 0px 2px 8px rgba(200, 164, 0, 0.34),
                          0px 0px 0px 4px rgba(253, 225, 52, 0.28);
```

Six tiers. See §10 for what each one *means* — a tier may only be used for
its stated meaning, never borrowed because it "looks about right."

### §2.6 / §2.7 — Duration & easing

```css
  --duration-*: initial;
  --duration-instant: 90ms;      /* colour-only: chip/row/menu-item tint */
  --duration-fast: 140ms;        /* default: button colour + press */
  --duration-base: 190ms;        /* entrance: dialog, popover, list row */
  --duration-exit: 120ms;        /* ALL exits. Exits are always faster. */
  --duration-slow: 320ms;        /* layout: rail collapse, height, tab travel */
  --duration-progress: 900ms;    /* determinate progress width settle */
  --duration-ambient: 1500ms;    /* shimmer, indeterminate loop */
  --duration-breathe: 2600ms;    /* confirm-CTA attention cycle */

  --ease-*: initial;
  --ease-out: cubic-bezier(0.22, 0.61, 0.36, 1);   /* entrances, presses */
  --ease-in: cubic-bezier(0.4, 0, 1, 1);           /* exits */
  --ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);     /* layout, bidirectional */
  --ease-linear: linear;                           /* ambient loops only */
}
```

**Never inline a `cubic-bezier(...)` or a bare `Nms` in a `duration-[…]` /
`animate-[name_Nms_…]`.** Always reference the token.

---

## §3 — Colour role table

| Role | Token(s) | Permitted surfaces | Forbidden |
|---|---|---|---|
| Page background | `canvas` | Body, behind all content | Inside a card |
| Card / dialog / input surface | `surface` | Cards, dialogs, popovers, inputs, table cells | Page background |
| Recessed-inside-a-card | `surface-alt` | Row hover, sub-panels inside a card | Standalone page sections |
| Deepest recess | `surface-sunken` | Table headers, code blocks, progress tracks | Any clickable element's rest state |
| Primary action | `action`, `action-hover`, `action-active` | The one affirmative CTA per view (Start Job, Save, Next Step) | More than one `action`-coloured button competing for attention in one view |
| Interactive / selected | `accent` family | Focus rings, selected rows/cards, active nav, links, checked inputs | Anything that is not currently interactive-or-chosen |
| Irreversible-write CTA | `signal` family | **Exactly one class of element**: the confirm-to-ADO CTA and its acknowledgement affordance | Focus rings, stat tiles, status chips, toasts, stepper nodes, any other button |
| Nav rail | `rail-*` | **Only inside `AppShell.tsx`'s `<nav>` and its children** | Buttons, inputs, selected table rows, progress bars — anywhere outside the rail |
| Streaming / in-flight | `live` | A chip or icon **only while a stream is actually open** | A terminal status; anything static |
| Success | `ok` family | Completed steps, positive deltas, succeeded status | Ambient decoration |
| Destructive / error | `danger` family | Failed status, delete actions, validation errors | Anything reversible-and-safe |
| Caution | `warning` family | Risk flags, non-blocking issues | Errors (use danger) |
| Informational | `info` family | Neutral system messages | Success or caution |
| ADO type/state colours | `wt-*`, `state-*` | Badges that mirror real ADO metadata | Anything not sourced from ADO data |

---

## §4 — Contrast floors

Minimum ratios, WCAG 2.2:

- **Body text:** 4.5:1 against both `surface` and `canvas` (SC 1.4.3).
- **Focus rings, input/control borders, state-bearing icons:** 3:1 (SC 1.4.11).
- **Accent fill vs. either light surface:** 3:1.

Measured pairs already in use:

| Pair | Ratio | Passes |
|---|---|---|
| `ink-1` / white | 14.2:1 | ✅ |
| `ink-2` / white | 10.4:1 | ✅ |
| `ink-3` / `surface` | 5.49:1 | ✅ |
| `ink-3` / `canvas` | 5.00:1 | ✅ (retuned from `#64748b`, which was 4.33:1 on canvas — a real SC 1.4.3 failure on the app's own page background, fixed with zero call-site churn since every use is already `text-ink-3`) |
| `accent` / white | 6.31:1 | ✅ |
| `accent` / `canvas` | 5.74:1 | ✅ |
| `accent-ink` / `accent-soft` | 8.85:1 | ✅ |
| `field-border` / white | 3.09:1 | ✅ (replaces `hairline-strong` at 1.52:1, a real SC 1.4.11 failure as an input border) |
| `signal-deep` / `signal` | 4.74:1 | ✅ |
| `signal-ink` / `signal` | 14.2:1 | ✅ |
| `accent-on-dark` / `rail-900` | 8.4:1 | ✅ |
| `focus` (`accent`) / white | 6.31:1 | ✅ (replaces the old `signal` focus ring at 1.31:1 — a real SC 1.4.11 failure) |

Any new token pairing added under §16's change protocol must add a row
here with its computed ratio before merge.

---

## §5 — Typography rules

See §2.2 for the scale and family. Rules not already stated there:

- Sentence case everywhere, no ALL-CAPS body copy. `text-micro` eyebrow
  labels are the one exception and use `letter-spacing: 0.06em` instead of
  case to signal "label," not shouting.
- `text-title` is the only size used for dialog titles and card section
  headers — do not reach for `text-display` inside a dialog.
- `text-display` is reserved for `PageHeader` — one per page.
- Any number that changes in place gets `tabular-nums`.

---

## §6 — Layout & density

- **Spacing:** see §2.3.
- **Page frame:** `main` content area `p-5`; app header is a fixed 52px
  bar; nav rail is 220px expanded / 64px collapsed with a
  `transition-[width] duration-slow`.
- **Card nesting cap:** a `Card` may never contain another `Card` (§15.15).
  Depth beyond one level is carried by hairlines and `surface-alt`, not
  stacked shadows.
- **Long identifiers:** see §2.2's mono-identifier rule.

---

## §7 — Interaction-state contract

Every interactive element declares all seven states: rest, hover, active,
focus-visible, disabled, loading, selected. **A component missing one of
these (where applicable to its category) is a defect, not a style choice.**

Base transition on every interactive element:
`transition-colors duration-fast ease-out` unless a row below overrides it.

**Universal focus rule (all categories):**
```
Light surfaces:  outline: 2px solid var(--color-focus); outline-offset: 2px;
Dark surfaces:   outline: 2px solid var(--color-focus-on-dark); outline-offset: 2px;
```
Applied in `@layer base` via `*:focus-visible`, with an `.on-dark` utility
scoping the dark form. Offset is 2px (not 1px) so the ring clears the 6px
`radius-sm` corner. **Never `focus:outline-none` without a replacement
ring.**

### Action — `Button`, icon buttons, `InfoTip` trigger, `DropdownMenu` trigger

| Variant | Rest | Hover | Active | Disabled | Loading | Selected |
|---|---|---|---|---|---|---|
| `primary` | `bg-action text-white shadow-sm` | `bg-action-hover shadow-raised -translate-y-px` | `bg-action-active scale-[0.98] shadow-sm` | `bg-canvas text-ink-3 border border-hairline shadow-none cursor-not-allowed pointer-events-none` | `<Spinner/>` prepended, label kept, `aria-busy="true"`, `pointer-events-none` | n/a |
| `outline` | `bg-surface text-action border border-field-border` | `bg-accent-soft border-accent text-accent-ink` | `bg-accent-soft-border scale-[0.98]` | as above | as above | `bg-accent-soft border-accent text-accent-ink` (toggle buttons only) |
| `ghost` | `bg-transparent text-ink-2` | `bg-surface-alt text-ink-1` | `bg-surface-sunken scale-[0.98]` | `text-ink-3 pointer-events-none` | as above | `bg-accent-soft text-accent-ink` |
| `danger` | `bg-surface text-danger border border-danger-border` | `bg-danger-soft border-danger` | `bg-danger-soft scale-[0.98]` | as `primary` disabled | as above | n/a |
| `cta` (irreversible only) | `bg-signal text-signal-ink border border-signal-border font-semibold shadow-cta` | `bg-signal-hover shadow-cta-attention -translate-y-px` | `bg-signal scale-[0.98] shadow-cta` | `bg-canvas text-ink-3 border border-hairline shadow-none` + a `Tooltip` naming the unmet precondition | `<Spinner className="text-signal-ink"/>` | **attention** (see §8) — only after the acknowledgement checkbox is ticked |

Transition property list: `transition-[color,background-color,border-color,box-shadow,transform] duration-fast ease-out`.
Minimum hit target 24×24 CSS px.

### Surface — `Card`, `SectionCard`, `StatTile`, `ModeCards`, `EmptyState`

| State | Non-interactive (default) | `interactive` / `selectable` |
|---|---|---|
| Rest | `bg-surface border border-hairline rounded-md shadow-card` | same |
| Hover | no change (banned) | `shadow-raised -translate-y-px border-hairline-strong` |
| Active | n/a | `translate-y-0 shadow-card` |
| Focus-visible | only if focusable | universal ring |
| Disabled | `opacity-60 pointer-events-none` | same |
| Loading | body → `<Skeleton/>`, border/shadow persist so layout doesn't jump | same |
| Selected | n/a | `border-accent bg-accent-soft shadow-raised` + 3px `bg-accent` left rail |

`interactive`/hover lift is opt-in on `Card`, never a default. Transition:
`transition-[transform,box-shadow,border-color] duration-base ease-out`.
A `StatTile`'s accent bar is `bg-accent`, never `bg-signal` (§3).

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

### Navigation — rail items, `Tabs` triggers, breadcrumb links, `Stepper` nodes

| State | Rail item (dark) | `Tabs` trigger (light) | `Stepper` node |
|---|---|---|---|
| Rest | `text-ink-on-dark-dim bg-transparent` | `text-ink-3 border-b-2 border-transparent` | `border-hairline-strong bg-surface text-ink-3` |
| Hover | `bg-rail-hover text-white` | `text-ink-1 border-hairline-strong` | `border-accent` (only if navigable) |
| Active | `bg-rail-active` | `border-accent/60` | n/a |
| Focus-visible | `outline-accent-on-dark offset-2` | universal | universal |
| Disabled | `text-ink-on-dark-dim/50 pointer-events-none` | `text-ink-3 pointer-events-none` | pending steps are not focusable |
| Loading | n/a | n/a | active step: `<Spinner/>` replaces the numeral |
| Selected | `bg-rail-active text-white font-semibold` + 3px `bg-rail-indicator` left edge | `border-accent text-ink-1 font-semibold` | done: `bg-ok border-ok` + check; current: `bg-accent border-accent scale-[1.09]` |

### Chip / Badge — `Chip`, `StatusChip`, `ModeBadge`, `ActionBadge`, `TagChips`, `IssueChips`, `TraceLinkChips`, `KbCitationChips`, `WorkItemTypeBadge`

| State | Utilities |
|---|---|
| Rest | `inline-flex rounded-full px-2 py-0.5 text-xs font-semibold` + its semantic `{soft, border, ink}` triple. **Never `shadow-*`.** |
| Hover | only if clickable/has a tooltip: `brightness-[0.97] transition-colors duration-instant`. A static chip has no hover state. |
| Active | clickable filter chips only: `scale-[0.97]` |
| Focus-visible | clickable only: universal ring |
| Disabled | `opacity-50` |
| Loading | renders as a `Skeleton` pill of the same geometry |
| Selected | filter chips: `bg-accent text-white border-accent` |

`--color-live` on a chip is permitted only while a stream is actually open.
A terminal status must never be cyan.

### Row — `JobsList` rows, `DiffTree` nodes, `SharePointFolderTree` nodes, `DropdownMenu`/`Select`/`Combobox` items, `CollapsibleWarnings` entries

| State | Utilities |
|---|---|
| Rest | `bg-transparent border-t border-hairline` |
| Hover | `bg-surface-alt transition-colors duration-instant`. **No lift, no shadow, no scale** — a lifted row inside a virtualised scroll container causes a repaint storm. |
| Active | `bg-surface-sunken` |
| Focus-visible | `bg-surface-alt` + universal ring, **inset** (`outline-offset: -2px`) so it isn't clipped by the scroll container |
| Disabled | `text-ink-3 cursor-not-allowed`, hover suppressed |
| Loading | `Skeleton` row of identical height |
| Selected | `bg-accent-soft` + 3px `bg-accent` left edge + `text-ink-1 font-medium`. `aria-selected="true"` is mandatory — colour alone may not carry selection. |

---

## §8 — Motion contract

Five named roles. Every animation in the app is exactly one of them. A new
`@keyframes` requires a new row here.

| Role | Meaning | Duration | Easing | Permitted properties | Banned |
|---|---|---|---|---|---|
| **Entrance** | An element that did not exist now exists | `--duration-base` (190ms). List stagger: +24ms/item, capped at 8 items, remainder at delay 0. | `--ease-out` | `opacity`, `translateY(≤4px)`, `scale(0.97→1)` | On anything already on screen. On whole-page route change. On virtualised rows during scroll-recycle (first mount only). More than one nesting level animating at once. |
| **Exit** | An element ceases to exist | `--duration-exit` (120ms) — always shorter than its entrance | `--ease-in` | `opacity`, `scale(1→0.97)`, `translateY(≤4px)` | On unmount without user intent (an SSE data replacement is not an exit). On list items removed by a filter change — those disappear instantly. |
| **State-change** | The same element becomes different | `--duration-instant` (colour-only) / `--duration-fast` (colour+shadow+press) / `--duration-slow` (layout) | `--ease-out` (pointer-driven) / `--ease-in-out` (layout) | `color`, `background-color`, `border-color`, `box-shadow`, `opacity`, `translateY(≤2px)`, `scale(0.97–1.09)`, `width`/`height`/`grid-template-rows` for disclosure | On a virtual-scrolled row's background. On any unenumerated property. Via bare `transition`. Never `filter`/`backdrop-filter`. |
| **Ambient / live** | Something is genuinely happening on a server right now | `--duration-ambient` (shimmer/indeterminate), `1.1s` (typedot), `0.7s` (spin) | `--ease-linear` (spin, shimmer) / `--ease-in-out` (typedot, indeterminate) | `translateX`, `rotate` (Spinner only), `scale`, `opacity`, `background-position` | **Whenever nothing is actually in flight** — an outliving spinner/shimmer is a correctness bug. No ambient decoration: no idle pulsing, no breathing outside Attention. |
| **Attention** | The app is blocked on an irreversible human decision | `--duration-breathe` (2600ms), infinite | `--ease-in-out` | `box-shadow` only — `--shadow-cta` ↔ `--shadow-cta-attention` | Everywhere except the confirm-to-ADO CTA post-acknowledgement. Never more than one element at a time. Never on reversible-destructive actions (delete, cancel). Never on a toast. |

Required keyframe:
```css
@keyframes ctaBreathe {
  0%, 100% { box-shadow: var(--shadow-cta); }
  50%      { box-shadow: var(--shadow-cta-attention); }
}
```

Existing keyframes retained and mapped: `fadeIn`/`dialogIn`/`listItemIn`/`popIn` →
Entrance; `fadeOut`/`dialogOut`/`popOut` → Exit; `shimmer`/`spin`/`typedot`/
`indeterminate-progress` → Ambient. `animate-pulse` is removed — a Tailwind
builtin double-animating alongside the inline `shimmer`.

`popIn`/`popOut` are `dialogIn`/`dialogOut`'s scale-only counterparts for
Radix-anchored popovers (`DropdownMenu`, and any future `Select`/`Combobox`
exit animation) — those carry their own `translate()` from Radix's popper
positioning, so `dialogIn`/`dialogOut`'s `translate(-50%,-50%)` (meant for a
page-centered dialog) would fight that positioning transform.

**Reduced motion.** The existing `@layer base` kill-switch (`0.001ms
!important` on `animation-duration`/`transition-duration`,
`animation-iteration-count: 1`) is retained and normative, plus:

1. `transition-duration` is clamped but `transition-property` is not — a
   `-translate-y-px` hover still applies instantly. Route all lift through
   one `.lift` class and add
   `@media (prefers-reduced-motion: reduce) { .lift { transform: none !important; } }`
   so "no motion" means no displacement, not instant displacement.
2. **Attention has a non-motion fallback.** Under reduced motion, the
   breathing CTA must instead render a static `--shadow-cta-attention` plus
   a persistent `ring-2 ring-signal-border` — the one element the whole
   product hinges on may never degrade to nothing.
3. Ambient loops keep `iteration-count: 1`, so a `Spinner` freezes — it
   must always be paired with `aria-busy` and visible text, never
   `aria-hidden` alone.

---

## §9 — Component category geometry

A new component picks a **category** from §7, not a look. Concrete
geometry per category:

- **Action:** height `h-9` default / `h-8` compact / `h-10` CTA. Icon size
  `h-4`. Radius `sm`.
- **Surface:** radius `md`. Padding follows §2.3's rungs — `p-4` default
  card body, `p-5` page-level panel.
- **Input:** height `h-9`. Radius `sm`. Icon size `h-4` for leading/trailing.
- **Navigation:** rail item height `h-10`. Tab trigger height `h-9`.
  Stepper node diameter `28px` (`h-7 w-7`).
- **Chip/Badge:** height `h-5` (text-xs) / `h-6` (text-sm). Radius `full`.
- **Row:** height `h-11` default table row / `h-9` dense-view row.
- **Overlay** (Dialog/Popover/DropdownMenu/Tooltip): radius `md` (Dialog
  may use `lg` for full-bleed variants). Elevation per §10.
- **Feedback** (Alert/Toast): radius `md`. Left accent bar `4px` in the
  severity's fill colour.

---

## §10 — Elevation semantics

Each shadow tier has exactly one meaning. Using a tier for any other reason
is a defect.

| Tier | Meaning |
|---|---|
| `shadow-sm` | Rest state of a flat interactive control (input, non-elevated chip-button) |
| `shadow-card` | Rest state of a surface that sits above canvas (Card, StatTile, SectionCard) |
| `shadow-raised` | That same surface, lifted because a pointer is over it or it is `interactive`/hover |
| `shadow-popover` | A floating, anchored surface (Select/Combobox/DropdownMenu popover, Tooltip) |
| `shadow-dialog` | A floating, modal surface that blocks the page (Dialog, ConfirmDialog) |
| `shadow-cta` / `shadow-cta-attention` | The confirm-to-ADO CTA's rest / attention states — nowhere else |

No shadow on any element smaller than 24px in either dimension. No shadow
on chips, badges, inputs, or table rows (§15.11).

---

## §11 — Iconography

`lucide-react` is the only icon source. `react-bootstrap-icons` is an
unused dependency in `frontend/package.json` and must be removed in the
same PR that touches any icon usage.

Three permitted sizes: `h-3.5` (inline with `text-xs`/`text-meta`), `h-4`
(default, inline with `text-sm`), `h-5` (headers, empty states). Default
`strokeWidth={1.75}` unless a component explicitly needs `2` for legibility
at `h-3.5`.

---

## §12 — Content & voice

- Sentence case everywhere except `text-micro` eyebrow labels (see §5).
- Irreversible-action copy must **name the destination and the count**:
  "Write 12 items to `Compliance Platform\Auth`" — never "Are you sure?"
  alone.
- No exclamation marks anywhere, including success toasts.
- Error copy states **cause, then remedy** — never just "Something went
  wrong."
- Audience is engineers and ADO Server administrators: dense, precise,
  no marketing tone, no emoji in product copy.

---

## §13 — Accessibility contract

- Visible focus on every interactive element (§7's universal focus rule) —
  no exceptions, no `focus:outline-none` without a replacement ring.
- Dark-surface elements use the `--color-focus-on-dark` variant.
- `prefers-reduced-motion` is honored per §8.
- Minimum 24×24 CSS px hit target on every interactive element, including
  chips-that-act-as-buttons, checkboxes, and `InfoTip` triggers — add a
  transparent hit-area expander where the visible control is smaller.
- **Colour is never the sole carrier of state.** Selected rows/cards get
  `aria-selected`; status carries a chip label and often an icon in
  addition to colour; the "written vs. proposed" distinction (§0.3) is
  never colour-only — it also changes the action affordance available.
- `Spinner` is `aria-hidden` only when a sibling element carries the
  `aria-busy` label; otherwise the spinner itself must be the labeled
  element.

---

## §14 — Enforcement

Three ratchets, all fail-on-increase:

1. **`frontend/src/design/palette.test.ts`** — per-file raw-hex-literal
   baseline. Allowlists exactly four data-palette files (`utils/tagColors.ts`,
   `KbCitationChips.tsx`, `WorkItemTypeBadge.tsx`, `FileTypeIcon.tsx`).
   Removing hex from a file removes its baseline entry entirely — a `0`
   entry is dead bookkeeping; deletion means any future hex in that file
   is a new offender, not a return to zero.
2. **`--color-*: initial` / `--text-*: initial` / `--radius-*: initial` /
   etc.** in `@theme` — deletes Tailwind's default scales outright, so
   "use a token" is mechanically true, not aspirational.
3. **`frontend/src/design/tokens.test.ts`** — a new ratchet, same
   per-file-baseline shape as (1), scanning for and banning: `text-\[\d`,
   `p[trblxy]?-\[\d`, `duration-\[\d`, `rounded-\[\d`, bare `rounded`
   (not followed by `-`), bare `transition` (not followed by `-`),
   `animate-\[\w+_\d+ms`, and `cubic-bezier(`.

No exception to any ratchet without a same-PR edit to its allowlist —
silent baseline bumps are not permitted.

---

## §15 — Negative constraints (banned outright)

These cannot be re-litigated by a future session without a change to this
file under §16's protocol. Each is mechanically checkable.

1. No raw hex in `frontend/src/**/*.tsx` outside the four allowlisted
   data-palette files.
2. No Tailwind default-palette utilities (`bg-slate-50` etc.) — deleted by
   `--color-*: initial`.
3. No arbitrary type sizes — `text-[Npx]` is banned; exactly 8 rungs exist.
4. No arbitrary durations — `duration-[Nms]` and
   `animate-[name_Nms_easing]` are banned; always reference
   `var(--duration-*)`/`var(--ease-*)`.
5. No arbitrary radii — `rounded-[Npx]` and bare `rounded` are banned;
   exactly four values exist (`sm`/`md`/`lg`/`full`).
6. No bare `transition` — the property list is always explicit
   (`transition-colors`, `transition-[transform,box-shadow]`).
7. **`--color-signal` may appear on exactly one element class:** the
   confirm-to-ADO / irreversible-write CTA and its acknowledgement
   affordance. Not on focus rings, stat-tile accents, status chips,
   toasts, or stepper nodes.
8. **`--color-rail-*` may appear only inside `components/AppShell.tsx`'s
   `<nav>` and its children.** Not on buttons, inputs, selected rows, or
   progress bars.
9. No gradients on interactive elements. One gradient exists in the
   system (the determinate progress fill) — nowhere else.
10. No serif faces. No decorative faces. No fourth family.
11. No shadow on any element smaller than 24px in either dimension, and
    no shadow on chips, badges, inputs, or table rows.
12. No motion without a state change. Nothing animates on mount that did
    not change; no decorative background motion; no hover motion on
    icons or text links.
13. No transform other than `translateY`, `scale`, and `translateX` (the
    last only for the indeterminate progress loop). No rotation outside
    `Spinner`. No skew, no 3-D.
14. No border-radius above 16px except `rounded-full` on pills, dots, and
    avatars.
15. No nesting a `Card` inside a `Card`. Depth is carried by hairlines and
    `surface-alt`, not stacked shadows.
16. No new `@keyframes` without an entry in the §8 motion table.
17. No MUI, no `theme/tokens.ts`, no second token file. `frontend/src/index.css`
    is the only place tokens are declared.
18. No dark mode. Out of scope; do not add `dark:` variants or a second
    colour set. (Stated explicitly so a future session does not
    half-build one.)

---

## §16 — Change protocol

- **Adding a token** requires, in the same PR: a role row in §3, a
  contrast row in §4 (if it's a colour), and — if it changes what's
  bannable — a §14 ratchet/allowlist update.
- **Removing or renaming a token** requires a migration-ledger entry in
  §17 naming every file that referenced it.
- Any change to §15's negative constraints requires an explicit rationale
  in the PR description; these are not to be relaxed casually.

---

## §17 — Migration ledger

Append-only. Every renamed/removed token and its replacement.

| Old | New | Notes |
|---|---|---|
| `--color-navy-900` | `--color-rail-900` | Kept as a deprecated alias during the transition phase, then removed once all call sites are migrated. |
| `--color-navy-700` | `--color-rail-hover` | |
| `--color-navy-600` | `--color-rail-active` **or** `--color-accent` | Per-call-site decision, not a mechanical rename — most current `navy-600` uses are actually accent/interactive semantics, not rail semantics. |
| `--color-navy-300` | `--color-rail-indicator` **or** `--color-accent` | Same caveat as above. |
| `--color-surface-alt` | (value changed) `#f1f4fa` → `#f6f8fc` | Was identical to `canvas`, so "recessed inside a card" and "page background" were visually indistinguishable. No call-site edits — value-only. |
| `--color-ink-3` | (value changed) `#64748b` → `#5b6a80` | Fixes an SC 1.4.3 failure on `canvas`. No call-site edits. |
| bare `--radius` (4px, Tailwind's deprecated fallback) | removed | 46 bare `rounded` call sites must each resolve to an explicit `rounded-sm` or `rounded-md`. |
| `--color-signal` as a focus ring | `--color-focus` (`accent`) | Fixes an SC 1.4.11 failure (1.31:1 → 6.31:1). |
| `--color-hairline-strong` as an input border | `--color-field-border` | Fixes an SC 1.4.11 failure (1.52:1 → 3.09:1). |
| Inter Tight + Inter | IBM Plex Sans | See §2.2. Inter Variable retained as first fallback for graceful degradation if the package fails to resolve. |
