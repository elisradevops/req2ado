# req2ado — UI Inventory

**Status: descriptive, not normative.** This is the coverage checklist —
every page, dialog, toast, and tooltip that exists in the app today.
Normative rules for how each of these should look/behave live in
`/DESIGN.md`. Use this file to confirm nothing was missed while landing
the Track B screen phases; do not add design rules here.

Salvaged from the pre-rewrite `DESIGN.md` (a Stitch tool-brief, deleted —
see `/DESIGN.md` §0).

## Pages

1. **Login** — org URL + PAT sign-in card.
2. **Jobs Dashboard** (`/jobs`) — stat tiles (Awaiting Review, Running,
   Items Written, Rejected), search + status filter chips, sortable jobs
   table, empty state, loading skeleton.
3. **New Job Wizard** (`/jobs/new`) — 2-step Stepper. Step 1: dropzone +
   file-type icon + parsed-stats tiles (blocks/sections/figures/depth).
   Step 2: BASELINE/SURVEY mode cards, cascading destination pickers
   (Project/Area Path/Iteration Path/State), model dropdown, ETA note,
   Start button.
4. **Job Detail** (`/jobs/:id`) — richest screen: breadcrumb, status chip,
   mode badge, destination bar, action buttons (Cancel/Reject/Confirm/
   Resubmit/Delete), lifecycle stepper (Parse→Analyze→Score→Dedup-check→
   Review→Confirm/Write) with active-step spinner, live progress banner
   (streaming narration + elapsed timer), summary stat tiles (New/Reused/
   Duplicates Skipped), collapsible warnings panel (jump-to-node), Diff
   Tree / Audit Trail tabs, virtualized filterable/searchable diff tree
   with work-item-type badges + create/reuse/dedup-skip action badges +
   include/exclude checkboxes.
5. **Knowledge Base** (`/knowledge-base`) — SharePoint folder tree +
   document list/preview.
6. **Help** (`/help`) — markdown docs page.
7. **Settings** (`/settings`) — profile card + reconnect actions.
8. **404** catch-all.

## Dialogs / modals

- `Dialog` — generic Radix shell (title, close X, description, body,
  footer) — base for all below.
- `ConfirmDialog` — Cancel + Confirm/Danger footer, base for all
  "are you sure" variants.
- **Resubmit job** — non-destructive (JobsList row, JobDetail header,
  failed-job view).
- **Delete job** — destructive; copy branches on succeeded-job (warns ADO
  items not deleted) vs other (JobsList row, JobDetail header, failed-job
  view).
- **Confirm write to ADO** — irreversible-from-app; shows created-item
  count + target area path (JobDetail, `diff_ready`).
- **Reject job** — destructive (JobDetail, `diff_ready`).
- **Cancel run** — destructive, notes checkpoint-delay caveat (JobDetail,
  `pending`/`running`).
- **Remove KB document** — destructive, names doc, warns content deleted
  (KnowledgeBase).
- **Reconnect to Azure DevOps** — Org URL + PAT password field, inline
  error (Settings).
- **Reconnect SharePoint** — access-token field, inline error
  (KnowledgeBase).
- **NodeDetailDialog** — large two-pane takeover: left = `NodeDetailPanel`
  (editable title/description, tag chips, issue chips, quality gauge,
  trace-link chips, KB citation chips, add-child card), right = embedded
  `ChatPanel` (streaming AI chat, model picker, accept-proposal); collapses
  to Details/Chat tabs below `lg`; prev/next chevron nav in header
  (JobDetail, diff tree row → open detail).

## Toasts

`ToastProvider`/`useToast` — global Radix stack, bottom-right, 4 severities
(success/error/warning/info), 4.4s auto-dismiss, manual close. Triggered
from: Jobs load/resubmit/delete, JobDetail actions (confirm/reject/cancel/
download/save/exclude/add-child), NewJobWizard (parse/start failures),
KnowledgeBase (add/remove doc, SharePoint reconnect), Settings (ADO
reconnect), all 4 cascading pickers (load-failure), ChatPanel
(send-failure, special copy on review-closed 409).

## Tooltips

Consistent Radix tooltip + `InfoTip` (info-icon triggered) pattern used
for: nav collapse/expand, per-nav-item labels when collapsed, connection
status, disabled-Confirm-button reason, full-timestamp-on-hover,
KbCitationChips/IssueChips/TraceLinkChips hover context, and explanatory
InfoTips throughout forms/stat tiles/QualityGauge/ProgressBanner/lifecycle
stepper.

No lightbox/file-preview modal exists — file preview is inline stat tiles
+ file-type icon in the wizard.
