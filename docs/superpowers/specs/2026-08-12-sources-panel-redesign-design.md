# Sources Panel Redesign — Design

Date: 2026-08-12
Status: Approved, pending implementation plan

## Context

`NodeDetailPanel.tsx`'s "Sources" block (added by P3c,
`docs/superpowers/specs/2026-07-16-p3c-source-provenance-design.md`, and
extended since with section/page provenance) has drifted into a cluttered,
jargon-heavy wall of text: a monospace breadcrumb line using `§` (a
character several reviewers assumed was Mac-only and unreadable on
Windows) and `›`, a raw `chars 9182–9196` offset nobody reads, two
overlapping explanation paragraphs, and a KB citation chip whose only
signal for "the LLM judged this doc irrelevant" is an unlabeled red fill.
Live screenshots from a Windows reviewer session confirmed the complaint:
"I do not understand anything from here."

This is a frontend-only redesign. No backend/API contract changes —
every field this design reads (`sectionPath`, `page`, `pageEnd`,
`pageProvenance`, `documentPath`, `kbCitations[].relevance`) already
exists and is already sent today.

## Scope

`req2ado/frontend/src/components/NodeDetailPanel.tsx` (the "Sources"
block, current lines ~478–518), `frontend/src/utils/sourceRef.ts`, and
`frontend/src/components/KbCitationChips.tsx`. `NodeDetailDialog.tsx` only
imports `KbCitation`'s type and does not duplicate this rendering, so
there is exactly one render site to change.

Gating logic for whether the "Sources" section renders at all is
**unchanged**: `entry.sourceRef` present, OR (`jobMode === 'survey'` AND
`entry.action === 'create'` AND (`entry.type === 'Requirement'` OR
`kbCitations.length > 0`)).

## Content changes

- **Drop `startOffset`/`endOffset` entirely.** Never computed, never
  rendered. The fields stay on `SourceRefLike`/the API response (backend
  unchanged) — this is a display-only omission.
- **No typographic symbols.** `§` and `›` are gone. Section breadcrumbs
  join with a plain ASCII `>`. A page range uses a plain ASCII `-`
  (`13-14`), not an en dash. The only non-ASCII characters left in the
  block are inline SVG icons (see below), which render identically on
  every OS since they're vector paths, not font glyphs — the actual fix
  for the cross-platform concern that started this, not a symbol swap
  that just moves the same risk to a different character.
- **One-line scoring explanation.** The two paragraphs ("Scored on how
  the requirement is written…" + "The checklist follows established
  requirements-writing practice… Your knowledge base contributed N
  documents.") collapse into one sentence: **"Scored on wording only, not
  engineering content."** The KB-count sentence is dropped — it's
  redundant with the KB reference chips themselves, which already
  enumerate what contributed.
- **KB chips say what they mean without hovering.** Each chip gets an
  inline icon + label prefix from `relevance`, not just a color fill:
  - `relevant` → check icon + "Relevant · <filename>"
  - `not_relevant` → X icon + "Not relevant · <filename>"
  - `unknown` → no icon, "Unverified · <filename>"
  Icons are lucide-react `Check`/`X` (already imported elsewhere in this
  file), not Unicode ✓/✗ — same reasoning as above. The existing tooltip
  (relevance label + similarity score + the "this is a process/style
  guide, not a domain spec" explanation) is unchanged.
- **Chip colors move to the app's existing soft-token palette**, matching
  `KbFileDetailPane.tsx`'s established chip convention, instead of the
  three hardcoded hex values (`#2e7d32`/`#c62828`/`#757575`) in
  `KbCitationChips.tsx` today:
  - `relevant` → `bg: var(--color-ok-soft)`, `color: var(--color-ok-ink)`,
    border `var(--color-ok-border)`
  - `not_relevant` → `var(--color-danger-soft)` / `var(--color-danger-ink)`
    / `var(--color-danger-border)`
  - `unknown` → `var(--color-surface-alt)` / `var(--color-ink-3)` /
    `var(--color-hairline-strong)`
  In scope because the chip is one of the three things flagged as
  confusing, not an unrelated cleanup.

## Layout: labeled metadata card

Replaces the single monospace `<p>` + two prose paragraphs with a
`dl`/`dt`/`dd` label:value layout — the same pattern already established
in `KbFileDetailPane.tsx` (Type/Size/Knowledge base rows), not a new
pattern introduced by this change:

```
📄  AirPro_BP_ICD_Revision_0.3.docx
Section   Power supply > Inrush current requirements
Page      13

Scored on wording only, not engineering content.

KB references
[✓ Relevant · doc-a.docx]  [✗ Not relevant · 02_Public_Source_..._Guidelines.pdf]
```

(📄 above is a stand-in for the `FileText` lucide icon, not a literal
emoji in the implementation.)

Each row is independently conditional — no row renders when its backing
field is absent:
- Filename row: always shown when `sourceRef` is present (same top-level
  gate as today's single `<p>`).
- `Section` row: only when `sectionPath.length > 0`.
- `Page`/`Slide` row: only when `page != null` (see label rule below).

## Page/Slide label rule (PDF / PPTX / XLSX handling)

Confirmed directly against the three format-specific loaders
(`ingestion/app/loaders/{pdf,pptx,xlsx}_loader.py`) before finalizing
this:

- **PDF**: `page` is the real PDF page number (ground truth,
  `page_provenance` is never set for it). `section_path` is always `[]`
  — `pdf_loader.py` never emits a `HEADING` block, only
  `PARAGRAPH`/`FIGURE`. A PDF-sourced entry therefore always renders a
  `Page` row and never a `Section` row — already the correct behavior
  under "omit an absent row," no special-casing needed.
- **PPTX**: `page` is the 1-based slide index, also real/ground-truth.
  `section_path` is at most one element — the slide's own title
  (`heading_level` is always `1`, decks have no sub-heading nesting).
  **Label is `Slide`/`Slides`, not `Page`/`Pages`, for a pptx-sourced
  entry.** There's no `format` field on `SourceRef`/`DryRunDiffEntry` to
  key off directly — the label is derived client-side from
  `documentPath`'s extension (`/\.pptx?$/i` against the basename), which
  is reliable since each loader only ever writes its own format's
  extension into `document_path`. This stays a frontend-only inference;
  no backend field is added for it.
- **XLSX**: `page` is always `null` and `section_path` is always `[]` on
  a Table's `SourceRef` — `xlsx_loader.py` never sets either. The sheet
  name IS captured, but only as `Table.caption`, never threaded into
  `section_path`. An XLSX-sourced entry therefore renders **filename
  only**, same as today — no regression, but no improvement either.
  **Deferred, explicitly out of scope for this design** (see below).

`Pages`/`Slides` (plural) applies under the same range rule as today:
`pageEnd != null && pageEnd > page`. Value renders as `13-14` (ASCII
hyphen). `(approx.)` still appends when `pageProvenance != null`,
unchanged logic, works on both a single page/slide and a range.

## Component split

- `frontend/src/utils/sourceRef.ts`: `formatSourceRef(ref): string`
  (single joined string) is replaced by `sourceRefRows(ref): { label:
  string; value: string }[]` — one row per available field, in order
  (`Section` then `Page`/`Slide`), empty array when neither applies. Pure
  function, same testability as today. Filename/basename extraction stays
  a separate small helper (same `split(/[/\\]/).pop()` logic as today),
  used by the component directly rather than folded into a row.
- New `frontend/src/components/SourceProvenance.tsx`: renders the file
  row (icon + basename), the `sourceRefRows` output as a `dl`, the
  one-line scoring note (`showScoringNote: boolean` prop — passed as
  `entry.type === 'Requirement'` by the caller, same condition as today),
  and the KB reference chip list. Takes `sourceRef`, `showScoringNote`,
  `kbCitations` as props — no `jobMode`/`entry` threading, since gating
  on those stays in `NodeDetailPanel.tsx` (which already has them in
  scope) and this component only renders content, not the decision to
  show the section at all. Pulled out because `NodeDetailPanel.tsx` is
  already large (DESIGN.md's own SRP guidance) and this block has grown
  enough internal structure (file row + metadata rows + scoring note +
  chip list) to warrant its own file and its own focused test suite.
- `NodeDetailPanel.tsx`: the existing inline Sources JSX (~478–518)
  becomes the outer gating `<div>` + `"Sources"` label (unchanged) wrapping
  `<SourceProvenance sourceRef={entry.sourceRef} showScoringNote={entry.type
  === 'Requirement'} kbCitations={kbCitations} />`.
- `KbCitationChips.tsx`: relevance→color maps switch to the CSS-token
  triples above; each chip gains the icon+label prefix.

## Testing

TDD, per this repo's convention.

- `sourceRef.test.ts` rewritten for `sourceRefRows`: drops every `chars
  A–B` assertion. New cases: section-only, page-only, both, page range,
  approx qualifier (single page and range), pptx path → `Slide`/`Slides`
  label, pdf/docx path → `Page`/`Pages` label, no section and no page →
  empty array (the xlsx-today case), and an explicit "output contains no
  §/›/em-dash/en-dash" assertion.
- New `SourceProvenance.test.tsx`: file row renders icon + basename;
  `Section`/`Page` rows render only when their field is present; scoring
  line renders only when `showScoringNote`; KB chip list renders one chip
  per citation with the correct icon+label per `relevance`; KB section
  omitted entirely when `kbCitations` is empty/absent.
- `NodeDetailPanel.test.tsx`: keep the existing outer-gating tests
  (Sources section presence/absence per job mode/action/type — untouched
  logic), update copy assertions from the old two-paragraph text to the
  new one-line "Scored on wording only, not engineering content.", drop
  the `Your knowledge base contributed N documents` assertion (removed
  copy), and drop the `spec.docx · p. 3 · chars 100–200` assertion (moves
  to `SourceProvenance.test.tsx` in its new row-based form).
- `KbCitationChips` relevance→style assertions (wherever they currently
  live) updated for the new token colors and the icon+label prefix.

## Out of scope

- **XLSX sheet-name → `section_path` wiring.** Would require threading
  `Table.caption` (already captured) into `SourceRef.section_path` in
  `xlsx_loader.py`, a backend ingestion change — deferred as a follow-up,
  not part of this frontend-only redesign.
- **PDF section/heading detection.** `pdf_loader.py` has no heading
  detection at all today; adding it is a materially larger ingestion
  change than this design's scope.
- **A real `format` field on `SourceRef`.** The pptx `Slide` label is
  derived from the `documentPath` extension instead — sufficient for this
  one label decision; not proposing a new backend field for it.
