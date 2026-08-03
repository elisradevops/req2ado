# req2ado — Claude Design System

For claude.ai/design (via `/design-sync`), not Stitch. Unlike Stitch, Claude Design isn't prompt-generated per screen — it's a real component library (HTML/CSS files, `@dsCard` markers, synced incrementally). Consistency is structural, not a per-prompt gamble: write the tokens once, every component pulls from the same CSS custom properties. This doc is the spec to hand to Claude Code to author the component files, then push via `/design-sync`.

Scope: visual system + interaction polish, same makeover goals as before (professional but expressive, real hover/focus/active feedback, unified layout). No IA changes — same screens/dialogs/toasts as the current app.

---

## 1. What the app does

Converts customer requirement documents (txt/md/docx/pdf/scanned-pdf/xlsx) into a hierarchical Azure DevOps/TFS work-item tree (Epic → Feature → Requirement). Two modes: **BASELINE** (contract-signed, verbatim, no LLM) and **SURVEY** (informal docs, LLM-distilled, quality-scored, dedup-checked). Flow: upload → parse/analyze (live narration) → review proposed diff tree → edit/chat per item → confirm → write to ADO.

---

## 2. Design tokens (CSS custom properties — the single source of truth)

Every component file must consume these variables, never a hardcoded hex. This is what makes Claude Design deterministic where Stitch wasn't.

```css
:root {
  /* Brand / navigation */
  --color-navy-900: #0f1b3d;   /* rail surface */
  --color-navy-700: #17306b;   /* rail hover */
  --color-navy-600: #1b458f;   /* rail active */
  --color-navy-300: #3b60c0;   /* active indicator / in-rail links */

  /* Accent — decision-required surfaces ONLY, never decorative */
  --color-signal: #fde134;
  --color-signal-deep: #7a5c00; /* text-on-signal */

  /* Surfaces */
  --color-canvas: #f1f4fa;
  --color-surface: #ffffff;
  --color-surface-alt: #f1f4fa;

  /* Borders */
  --color-hairline: #dde4ee;
  --color-hairline-strong: #c9d2e2;

  /* Text */
  --color-ink-1: #0b1220;
  --color-ink-2: #334155;
  --color-ink-3: #64748b;

  /* Semantic */
  --color-ok: #15803d;
  --color-danger: #d1434b;
  --color-warning: #b45309;
  --color-info: #2563eb;
  --color-live: #06b6d4;

  /* Work-item-type badges — fallback only; real app fetches live ADO colors per project */
  --color-wt-epic: #ff7b00;
  --color-wt-feature: #773b93;
  --color-wt-requirement: #009ccc;

  /* State-dot badges (ADO Agile process defaults) */
  --color-state-new: #b2b2b2;
  --color-state-proposed: #b2b2b2;
  --color-state-active: #007acc;
  --color-state-resolved: #ff9d00;
  --color-state-closed: #339933;
  --color-state-removed: #7f7f7f;

  /* Type */
  --font-display: 'Inter Tight Variable', 'Inter Tight', -apple-system, sans-serif;
  --font-sans: 'Inter Variable', 'Inter', -apple-system, 'Segoe UI', sans-serif;
  --font-mono: 'IBM Plex Mono', ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;

  /* Shape */
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 16px;

  /* Elevation */
  --shadow-sm: 0px 1px 2px rgba(15, 27, 61, 0.05);
  --shadow-card: 0px 1px 2px rgba(15, 27, 61, 0.05), 0px 8px 20px rgba(15, 27, 61, 0.055);
  --shadow-popover: 0px 2px 4px rgba(15, 27, 61, 0.07), 0px 16px 34px rgba(15, 27, 61, 0.1);
  --shadow-dialog: 0px 24px 64px rgba(11, 18, 32, 0.32);

  /* Motion */
  --ease-out: cubic-bezier(0.22, 0.61, 0.36, 1);
  --ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);
  --duration-fast: 150ms;
  --duration-base: 220ms;
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
  }
}
```

**Rule for every component built against this system:** if a value isn't in this list, it doesn't exist. No inline hex, no ad hoc radius/shadow. This is the actual enforcement mechanism Stitch's prompt-based approach couldn't give you.

---

## 3. Interaction states (apply to every component, not optional)

This is the "professional but expressive" ask — spell it out per element class so nothing ships flat:

| Element class | Rest | Hover | Active/Pressed | Focus |
|---|---|---|---|---|
| Primary button | `--color-navy-900` fill | darken + `translateY(-1px)` + `--shadow-card`, `--duration-fast` `--ease-out` | `translateY(0)` + darken further | 2px `--color-signal` ring, offset 1px |
| Decision button (Confirm-to-ADO) | `--color-signal` fill, `--color-signal-deep` text | slight darken + lift | compress | 2px `--color-signal` ring |
| Destructive button | `--color-danger` fill | darken + lift | compress | 2px `--color-signal` ring |
| Card / StatTile / SectionCard | `--shadow-sm` | `--shadow-card`, `--duration-base` | n/a | outline on keyboard focus |
| Table / diff-tree row | transparent bg | `--color-surface-alt` tint | `--color-navy-300` at 8% opacity (selected) | visible focus outline for keyboard nav |
| Chip / badge | flat semantic color at low opacity | color deepens slightly, tooltip appears after 400ms delay | n/a | n/a |
| Nav rail item | `--color-navy-900` bg, icon only or icon+label | `--color-navy-700` bg | `--color-navy-600` bg + `--color-navy-300` left-edge indicator | ring visible even against navy |
| Dialog | enters via scale 0.97→1 + fade, `--duration-base` `--ease-out` | — | — | trap focus inside |
| Toast | slide+fade in, auto-dismiss progress bar drains over 4.4s, slide+fade out | pause auto-dismiss timer on hover | — | — |

---

## 4. Component inventory → `@dsCard` groups

Structure the Claude Design project's files so the Design System pane groups match the app's real UI kit. One file per component/state variant, each with a `<!-- @dsCard group="..." -->` first line.

- **group="Foundations"** — color palette swatches, type scale, spacing scale, radius scale, shadow scale (one card each, so tokens are visually reviewable before any component work starts).
- **group="Navigation"** — AppShell rail (collapsed + expanded), header w/ connection-status dots, breadcrumb.
- **group="Buttons"** — primary, decision-accent, destructive, ghost — each in rest/hover/active/disabled.
- **group="Cards"** — StatTile, SectionCard, ModeCard (BASELINE/SURVEY selection), EmptyState.
- **group="Forms"** — TextField, Select, Combobox (+ cascading picker variant), Checkbox, dropzone.
- **group="Chips & Badges"** — TagChip, IssueChip, TraceLinkChip, KbCitationChip, work-item-type badge (Epic/Feature/Requirement), state-dot badge, StatusChip, ModeBadge, action badge (create/reuse/dedup-skip).
- **group="Feedback"** — ProgressBar (determinate + indeterminate), Spinner, Skeleton/shimmer, ProgressBanner (streaming narration + timer), Stepper (generic + the 6-step SurveyPipelineSteps variant), QualityGauge, toast (4 severities), tooltip + InfoTip.
- **group="Dialogs"** — generic Dialog shell, ConfirmDialog (3 tone variants: neutral / destructive / decision-accent), Reconnect ADO, Reconnect SharePoint, NodeDetailDialog (wide two-pane + narrow tabbed).
- **group="Tables & Trees"** — Jobs table (rows, sort, filter chips), DiffTree row (with badges/checkboxes), SharePointFolderTree, CollapsibleWarnings panel, Tabs.
- **group="Pages"** — one full-page composite card per screen: Login, Jobs Dashboard, New Job Wizard (step 1, step 2), Job Detail, Knowledge Base, Help, Settings, 404.

---

## 5. Screen + dialog + toast coverage (nothing here may be dropped)

**Pages:** Login, Jobs Dashboard, New Job Wizard (both steps), Job Detail (pipeline stepper, progress banner, stat tiles, warnings panel, tabs, diff tree), Knowledge Base, Help, Settings, 404.

**Dialogs:** generic Dialog/ConfirmDialog base, Resubmit job, Delete job (succeeded-job copy vs generic copy), Confirm write to ADO, Reject job, Cancel run, Remove KB document, Reconnect ADO, Reconnect SharePoint, NodeDetailDialog (wide + narrow).

**Toasts:** success/error/warning/info, all trigger sites (job actions, wizard, KB, settings, pickers, chat).

**Tooltips:** nav collapse/expand, per-item labels when collapsed, connection status, disabled-Confirm reason, full-timestamp-on-hover, chip hover context, InfoTips throughout forms/stat tiles.

---

## 6. Personality direction

Precise, technical, trustworthy — a compliance ledger crossed with a modern PM tool. Spacious, not dense. `--color-signal` appears nowhere except decision-required surfaces (confirm gate, awaiting-review status, focus ring) — if a component reaches for it decoratively, that's a bug in the component, not a style choice. IBM Plex Mono is the tell for "this is verifiable ledger data" (clause numbers, WI IDs, hashes, timers) — never use it for prose.

---

## 7. Build → sync workflow

1. Author `:root` tokens (section 2) as the first file, `group="Foundations"`.
2. Build component files bottom-up: tokens → primitives (buttons, chips, inputs) → composites (cards, dialogs, tables) → full pages — each new file only ever reaches for existing tokens/primitives, never redefines a color or radius inline.
3. Run `/design-sync` incrementally, one component group at a time — not a wholesale push. Review each group in the Design System pane before moving to the next.
4. Because every file shares the same `:root` tokens, cross-component consistency is enforced by CSS inheritance, not by re-stating a style in every prompt — this is the structural fix for the problem Stitch had.

---

## 8. Non-goals

- No new pages, no removed dialogs, no changed confirmation copy/logic.
- No swap of the underlying frontend stack (Tailwind/Radix/zustand) — this doc governs the Claude Design *reference* library, not a rewrite of `frontend/src/index.css`; once approved, port matching values back into that file.
- No decorative use of `--color-signal`.
- No change to real-ADO-fetched work-item-type/state colors — only fallback tokens are themeable.
