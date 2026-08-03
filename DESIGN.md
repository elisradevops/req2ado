# req2ado Frontend Design

Status doc: current visual system, a Stitch-ready semantic design system, then target redesign. Not a spec for feature/flow changes — IA and behavior stay as-is; this covers look, feel, and interaction polish only.

---

## 1. What the app does

Converts customer requirement documents (txt/md/docx/pdf/scanned-pdf/xlsx) into a hierarchical Azure DevOps/TFS work-item tree (Epic → Feature → Requirement). Two modes: **BASELINE** (contract-signed, verbatim, no LLM) and **SURVEY** (informal docs, LLM-distilled, quality-scored, dedup-checked). Flow: upload → parse/analyze (live narration) → review proposed diff tree → edit/chat per item → confirm → write to ADO.

---

## 2. Current design system (engineering reference)

Stack: **Tailwind CSS v4** (CSS-first `@theme` tokens, `frontend/src/index.css`) + **Radix UI** primitives + **zustand**. Not MUI/AntD (README reference to those is stale).

### Color tokens
| Token | Value | Use |
|---|---|---|
| `navy-900` | `#0F1B3D` | sidebar rail |
| `navy-700/600/300` | `#17306B` / `#1B458F` / `#3B60C0` | rail hover/active states |
| `signal` | `#FDE134` | accent — reserved strictly for decision-required surfaces (confirm gate, awaiting-review, focus ring). Never decorative. |
| `signal-deep` | `#7A5C00` | text-on-signal |
| `canvas` | `#F1F4FA` | page background |
| `surface` / `surface-alt` | `#FFFFFF` / `#F1F4FA` | cards |
| `hairline` / `hairline-strong` | `#DDE4EE` / `#C9D2E2` | borders |
| `ink-1/2/3` | `#0B1220` / `#334155` / `#64748B` | text hierarchy |
| `ok` / `danger` / `warning` / `info` / `live` | green/red/amber/blue/cyan | semantic states |
| `wt-epic/feature/requirement` | orange/purple/cyan | work-item-type badge fallback (real app fetches actual ADO colors per-project; these are fallback only) |
| `state-new/proposed/active/resolved/closed/removed` | ADO Agile process defaults | state-dot badges |

### Typography
- Display: Inter Tight Variable
- Body/UI: Inter Variable
- Mono: IBM Plex Mono — used deliberately for identifiers (clause numbers, ADO IDs, job IDs, hashes, timers), a distinct type class from prose since the app's real artifact is a traceability ledger (`clause 3.2.1 → WI-1234`).

### Shape / elevation / motion
- Radii: `sm` 6px, `md` 10px, `lg` 16px
- Shadows: `sm`, `card`, `popover`, `dialog` — increasing softness/spread
- Easing: `ease-out` and `ease-in-out` cubic-beziers
- Keyframes already defined: `shimmer`, `spin`, `fadeIn/Out`, `dialogIn/Out`, `typedot`, `listItemIn`, `indeterminate-progress`
- Focus ring: 2px solid `signal`, honors `prefers-reduced-motion`

### Shared UI kit (`frontend/src/ui/`)
Button, Card, Chip, Combobox, ConfirmDialog, Dialog, DropdownMenu, EmptyState, Markdown, PageHeader, ProgressBar, SectionCard, Select, Skeleton, Spinner, StatTile, Stepper, Tabs, TextField, Tooltip, Alert, Checkbox.

### Persistent shell
Collapsible left navy icon rail (Jobs / New Job / Knowledge Base / Help), top header with page title, ADO/SharePoint connection-status dots with tooltips, user menu.

---

## 3. Stitch-ready DESIGN.md (semantic format — paste this into Stitch)

Follows Google's own DESIGN.md synthesis structure (descriptive name + hex + functional role, not raw tokens) so Stitch's model reads intent, not just values.

### 3.1 Visual Theme & Atmosphere
Precise, technical, trustworthy — a compliance ledger crossed with a modern product-management tool. Airy, spacious, and disciplined rather than dense or decorative. Personality comes from typographic contrast and purposeful, restrained color — never from ornament, gradients, or busy surfaces. One accent color exists and it means something ("this needs your decision") — it is never used just to look bold.

### 3.2 Color Palette & Roles
- **Deep Midnight Navy (#0F1B3D)** — primary brand surface, the persistent navigation rail. Grounds the whole app.
- **Twilight Navy (#17306B)** and **Harbor Blue (#1B458F)** — rail hover and active states, one step lighter each for clear affordance without leaving the navy family.
- **Electric Periwinkle (#3B60C0)** — active rail indicator / in-context links inside the navy rail.
- **Signal Yellow (#FDE134)** — the single accent color, reserved exclusively for decision-required moments: the confirm-to-ADO gate, "awaiting review" status, focus rings. Never used decoratively or as a general brand color.
- **Deep Amber Ink (#7A5C00)** — text rendered on top of Signal Yellow, for contrast.
- **Pale Sky Tint (#F1F4FA)** — page canvas background, a whisper of cool blue-gray behind white cards.
- **Pure White (#FFFFFF)** — card and surface background, floats above the canvas tint.
- **Whisper Hairline (#DDE4EE)** and **Firm Hairline (#C9D2E2)** — dividers and input borders; the strong variant for emphasis states (hover, active input).
- **Near-Black Ink (#0B1220)** — primary text, headings, high-emphasis labels.
- **Slate Ink (#334155)** — secondary text, body copy.
- **Muted Slate (#64748B)** — tertiary text, captions, placeholder text, disabled states.
- **Forest Confirmation Green (#15803D)** — success semantic (toasts, success chips, ok state-dots).
- **Muted Crimson (#D1434B)** — danger semantic (destructive dialogs, error toasts, reject/delete actions).
- **Burnt Amber (#B45309)** — warning semantic (caution toasts, warning chips).
- **Confident Blue (#2563EB)** — informational semantic (info toasts, informational chips).
- **Electric Cyan (#06B6D4)** — live/streaming semantic, used specifically for in-progress narration and real-time chat/typing indicators.
- **Vivid Construction Orange (#FF7B00)** — Epic work-item-type badge (fallback only; real app fetches live ADO colors per project).
- **Deep Violet (#773B93)** — Feature work-item-type badge (fallback only).
- **Bright Teal-Cyan (#009CCC)** — Requirement work-item-type badge (fallback only).

### 3.3 Typography Rules
- **Headings/display** — Inter Tight: a confident, slightly condensed geometric sans, used for page titles, dialog titles, and stat-tile numbers. Bold weight for emphasis, never decorative fonts.
- **Body/UI text** — Inter: neutral, highly legible, used for all prose, labels, buttons, table content.
- **Identifiers** — IBM Plex Mono: a distinct monospace voice reserved strictly for clause numbers, ADO work-item IDs, job IDs, source hashes, and timers/timestamps. This typographic split signals "this is verifiable ledger data," distinct from ordinary prose — never use mono for regular text.

### 3.4 Component Stylings
- **Buttons:** Subtly rounded corners (10px). Primary actions fill Deep Midnight Navy; decision-required actions (confirm-to-ADO) fill Signal Yellow with Deep Amber Ink text — this pairing appears nowhere else in the app. Destructive actions use Muted Crimson. Hover deepens the fill slightly and lifts with a soft shadow; pressed state compresses back down.
- **Cards/Containers:** Generously rounded corners (16px) for large surfaces, subtly rounded (10px) for smaller cards. Pure White background floating on the Pale Sky Tint canvas, bordered by Whisper Hairline, lifted by a whisper-soft diffused shadow that deepens slightly on hover.
- **Inputs/Forms:** Whisper Hairline stroke at rest, deepening to Firm Hairline on focus, paired with a 2px Signal Yellow focus ring — the only other place Signal Yellow legitimately appears. White or Pale Sky Tint background depending on nesting depth.
- **Chips/Badges:** Pill-shaped, small, colored by semantic role (work-item-type, state-dot, tag, issue, trace-link, KB-citation) — each with a gentle color-transition on hover and a tooltip revealing extra context.
- **Dialogs:** Pure White surface, generously rounded corners (16px), heaviest shadow in the system (deep, high-contrast, floating well above the page) to signal "this requires attention now."

### 3.5 Layout Principles
Generous whitespace throughout — density is a last resort, not a default. Left-anchored, collapsible icon navigation rail in Deep Midnight Navy, persistent across every screen. Content areas use consistent padding and a clear vertical rhythm between stat tiles, tables, and panels. Visual hierarchy is carried by type scale and ink-tone contrast first, color second, and Signal Yellow third (sparingly, only when a decision is truly required).

---

## 4. Current screen inventory

1. **Login** — org URL + PAT sign-in card.
2. **Jobs Dashboard** (`/jobs`) — stat tiles (Awaiting Review, Running, Items Written, Rejected), search + status filter chips, sortable jobs table, empty state, loading skeleton.
3. **New Job Wizard** (`/jobs/new`) — 2-step Stepper. Step 1: dropzone + file-type icon + parsed-stats tiles (blocks/sections/figures/depth). Step 2: BASELINE/SURVEY mode cards, cascading destination pickers (Project/Area Path/Iteration Path/State), model dropdown, ETA note, Start button.
4. **Job Detail** (`/jobs/:id`) — richest screen: breadcrumb, status chip, mode badge, destination bar, action buttons (Cancel/Reject/Confirm/Resubmit/Delete), 6-step pipeline stepper (Parse→Analyze→Score→Dedup-check→Review→Confirm) with active-step spinner, live progress banner (streaming narration + elapsed timer), summary stat tiles (New/Reused/Duplicates Skipped), collapsible warnings panel (jump-to-node), Diff Tree / Audit Trail tabs, virtualized filterable/searchable diff tree with work-item-type badges + create/reuse/dedup-skip action badges + include/exclude checkboxes.
5. **Knowledge Base** (`/knowledge-base`) — SharePoint folder tree + document list/preview.
6. **Help** (`/help`) — markdown docs page.
7. **Settings** (`/settings`) — profile card + reconnect actions.
8. **404** catch-all.

### Dialogs / modals
- `Dialog` — generic Radix shell (title, close X, description, body, footer) — base for all below.
- `ConfirmDialog` — Cancel + Confirm/Danger footer, base for all "are you sure" variants.
- **Resubmit job** — non-destructive (JobsList row, JobDetail header, failed-job view).
- **Delete job** — destructive; copy branches on succeeded-job (warns ADO items not deleted) vs other (JobsList row, JobDetail header, failed-job view).
- **Confirm write to ADO** — irreversible-from-app; shows created-item count + target area path (JobDetail, diff_ready).
- **Reject job** — destructive (JobDetail, diff_ready).
- **Cancel run** — destructive, notes checkpoint-delay caveat (JobDetail, pending/running).
- **Remove KB document** — destructive, names doc, warns content deleted (KnowledgeBase).
- **Reconnect to Azure DevOps** — Org URL + PAT password field, inline error (Settings).
- **Reconnect SharePoint** — access-token field, inline error (KnowledgeBase).
- **NodeDetailDialog** — large two-pane takeover: left = `NodeDetailPanel` (editable title/description, tag chips, issue chips, quality gauge, trace-link chips, KB citation chips, add-child card), right = embedded `ChatPanel` (streaming AI chat, model picker, accept-proposal); collapses to Details/Chat tabs below `lg`; prev/next chevron nav in header (JobDetail, diff tree row → open detail).

### Toasts
`ToastProvider`/`useToast` — global Radix stack, bottom-right, 4 severities (success/error/warning/info), 4.4s auto-dismiss, manual close. Triggered from: Jobs load/resubmit/delete, JobDetail actions (confirm/reject/cancel/download/save/exclude/add-child), NewJobWizard (parse/start failures), KnowledgeBase (add/remove doc, SharePoint reconnect), Settings (ADO reconnect), all 4 cascading pickers (load-failure), ChatPanel (send-failure, special copy on review-closed 409).

### Tooltips
Consistent Radix tooltip + `InfoTip` (info-icon triggered) pattern used for: nav collapse/expand, per-nav-item labels when collapsed, connection status, disabled-Confirm-button reason, full-timestamp-on-hover, KbCitationChips/IssueChips/TraceLinkChips hover context, and explanatory InfoTips throughout forms/stat tiles/QualityGauge/ProgressBanner/SurveyPipelineSteps.

No lightbox/file-preview modal exists — file preview is inline stat tiles + file-type icon in the wizard.

---

## 5. What to change — makeover goals

Scope: **visual system + interaction polish only.** No IA changes, no new screens, no removed dialogs — every item in section 4 must survive the makeover.

### 5.1 Problems with current state
- Design tokens exist and are decent, but application is inconsistent across pages — doesn't yet read as one unified system end to end.
- Interaction feedback is thin: hover/focus/active states exist in patches (buttons, focus ring) but aren't systematically applied to cards, table rows, tree nodes, chips, nav items.
- Motion primitives (`fadeIn`, `dialogIn`, `shimmer`, `listItemIn`) are defined but under-used — several state transitions (loading→loaded, toast enter/exit, tree row select) are instant cuts.
- Personality is currently closer to "generic enterprise dashboard" than the intended "precise, technical, trustworthy — compliance tool meets modern PM tool" feel.

### 5.2 Target direction
- **One unified layout.** Same spacing scale, same radius scale (`sm`/`md`/`lg`), same shadow scale (`sm`/`card`/`popover`/`dialog`), same color usage rules applied identically on every page — no page should feel like a different app.
- **Professional but expressive.** Keep the restrained navy + signal-yellow (decision-only) discipline — don't dilute `signal` into a general brand color. Bring more personality via typography contrast (Inter Tight display / Inter body / IBM Plex Mono for IDs), confident whitespace, and purposeful color, not decoration.
- **Rich, deliberate feedback on every interactive element:**
  - Buttons: hover lift/darken + pressed-state compress, using `ease-out`.
  - Cards / StatTiles / SectionCards: subtle scale or shadow-elevation increase on hover (`shadow-sm` → `shadow-card`).
  - Table rows / diff-tree rows: hover background tint, smooth transition, clear selected/active state.
  - Chips/badges (tag, issue, trace-link, KB citation, work-item-type, state-dot): color transition on hover, tooltip reveal timing consistent app-wide.
  - Nav rail items: active-state indicator, hover background, smooth collapse/expand transition using existing motion tokens.
- **Use existing motion tokens everywhere they apply**, don't invent new ones: `fadeIn`/`fadeOut` for tooltips/toasts, `dialogIn`/`dialogOut` for all dialogs (already the base `Dialog` component — extend consistently to every dialog listed in 5.3), `listItemIn` for table/tree row entrance, `shimmer` for all skeleton loading states, `indeterminate-progress` for unknown-duration progress bars (SURVEY parsing), `typedot` for chat "AI is typing" indicator.
- **Respect `prefers-reduced-motion`** (already handled globally — keep it that way for any new transitions added).

### 5.3 Explicit coverage checklist (nothing below may be skipped)
**Pages:** Login, Jobs Dashboard, New Job Wizard (both steps), Job Detail (all sub-panels: pipeline stepper, progress banner, stat tiles, warnings panel, tabs, diff tree), Knowledge Base, Help, Settings, 404.

**Dialogs:** generic `Dialog`/`ConfirmDialog` base, Resubmit job, Delete job (both copy variants), Confirm write to ADO, Reject job, Cancel run, Remove KB document, Reconnect ADO, Reconnect SharePoint, NodeDetailDialog (both wide two-pane and narrow tabbed layouts).

**Toasts:** all 4 severities, all trigger sites listed in section 4.

**Tooltips/InfoTips:** all instances listed in section 4, unified into one visual/timing spec.

### 5.4 Non-goals
- No new pages, no removed dialogs, no changed confirmation copy/logic.
- No swap of Tailwind/Radix/zustand stack.
- No change to `signal` accent's restricted decision-only usage rule.
- No change to real-ADO-fetched work-item-type/state colors — only the fallback tokens are themeable.

### 5.5 Negative constraints for Stitch (append verbatim to any unify prompt)
- Never use serif fonts.
- Never use gradients on buttons or cards.
- Never exceed 48px button height.
- Never use Signal Yellow (#FDE134) decoratively — decision-required surfaces only.
- Never let radius or shadow depth diverge between screens generated in different batches.
