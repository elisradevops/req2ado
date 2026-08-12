# Table fidelity in extracted work items — design spec

Status: approved, implementation in progress via autonomous /loop.

## Problem

Source document tables (docx/xlsx/pptx/pdf) lose their "form factor" when folded
into a work item's `System.Description`: merged cells duplicate text (partially
fixed this session), alignment/bold/color/borders/column widths are all
discarded, and the flat `<table><tr><td>` HTML today carries none of it. Font
family/weight must still default to ADO's own rich-text theme — never fight it,
matching `description-html.ts`'s existing prose philosophy.

## Scope

All four formats (docx, xlsx, pptx, PDF) are in scope, explicitly accepted by
the user with PDF known to be heuristic/lower-confidence. Sequencing follows a
phased build order (below) rather than one combined change, because two of the
phases turned out to be much larger/riskier than initially scoped:
pptx currently extracts **no tables at all** (new capability, not a styling
add-on), and ADO's real handling of inline `style=`/`colspan`/`<thead>` in
`System.Description` is unverified — ungate that before trusting any
color/width/border decision.

## Data model

`ingestion/app/canonical/model.py`'s `Table` (schema-first: edit
`shared/schemas/canonical-doc.schema.json`, regenerate, THEN update the
pydantic model — the schema is the declared source of truth, guarded by
`ingestion/tests/test_schema_conformance.py` and `shared/ts/test/generated.spec.ts`):

```python
class TableCell(BaseModel):
    text: str
    colspan: int = 1
    rowspan: int = 1
    is_header: bool = False
    bold: bool = False
    background_color: str | None = None   # normalized #rrggbb, "no fill" already resolved to None
    text_color: str | None = None          # normalized #rrggbb, contrast-adapted (see below)
    align: Literal["left", "center", "right", "justify"] | None = None

class Table(BaseModel):
    id: str
    cells: list[list[TableCell | None]]
    # None has TWO distinct meanings that must render differently:
    #   - a position covered by a preceding cell's colspan/rowspan -> emit NO <td>
    #   - a genuine gap (PDF only, a cell pdfplumber found no content for) -> emit an EMPTY <td>
    # Distinguish via a sibling `is_gap: list[list[bool]]` grid, or a 3-state
    # cell (spanned/gap/real) -- decide the exact encoding during Phase 1, but
    # the distinction itself is mandatory, not optional (conflating them
    # produces structurally broken tables on gappy PDFs).
    column_widths: list[float] | None = None   # FRACTIONS of table width, never source units (twips/EMU/chars/points)
    border_style: Literal["none", "grid", "outer"] | None = None  # deliberately coarse -- document this plainly, don't over-promise
    style_provenance: str | None = None   # None = read from explicit source markup; "heuristic" = geometrically/heuristically inferred (PDF). Mirrors SourceRef.page_provenance's exact precedent -- str, NOT Literal, values documented in the docstring.
    caption: str | None = None   # must actually be rendered by _table_to_html (currently captured, dropped -- fix in Phase 1)
    source_ref: SourceRef
```

A validator enforces every row has the same grid width (docx `gridBefore`/
`gridAfter` and PDF gaps will violate this otherwise — must fail loudly, not
silently misalign).

`plain_text_rows(table) -> list[list[str]]` (extracts `.text`, `""` for
spanned/gap positions) is the ONLY thing `id_hierarchy.py`'s
`rows_from_table`/`parsed_id_rows_from_table` and `llm_leveling.py`'s
`_table_to_markdown` non-empty check need — confirmed by direct reading that
neither has any positional/dimensional assumption beyond
`_parse_id_hierarchy_table_rows`'s `len(row) != 2` gate, which the `None`
sentinel design satisfies (an omit-and-reconstruct alternative would silently
break this gate on a merged 2-column table — rejected).

`redact_canonical_doc` (`app/redaction/redactor.py`) redacts `cell.text` per
`TableCell` in place, style fields untouched (none of them can carry PII).
While touching this function: also redact `table.caption` (currently never
redacted despite xlsx sheet names / csv filename stems being able to contain
sensitive strings — pre-existing hole, closed as part of this work).

## is_header derivation (per format — previously unspecified, now required)

- docx: `w:trPr/w:tblHeader` on the row.
- xlsx: no real signal exists — heuristic: `ws.freeze_panes` row, documented as a heuristic.
- pptx: `table.first_row` (once table extraction exists at all — Phase 3).
- PDF: heuristic (first row of a detected table, or geometric/font-weight signal if available).

## Bold detection rule

**Uniform bold**: a cell is bold only if *every* run containing non-whitespace
text is bold. Rejects "first non-empty run" (mis-fires badly on
"*Note:* rest of sentence" patterns — would bold the entire cell for a bold
label prefix, a fidelity loss worse than not detecting bold at all).

## Per-format extraction — corrected

**docx**: `tc.grid_span`/`tc.vMerge` for spans (proven working this session).
`w:tcPr/w:shd/@w:fill` for background — but treat `"auto"` and `"FFFFFF"` as
*no fill*, and be aware **python-docx does not resolve table-STYLE
inheritance** (`w:tblPr/w:tblStyle` + `styles.xml` conditional formatting) —
most real Word tables get their header shading/banding from a table style, not
per-cell `w:shd`, so per-cell-only extraction will miss the common case. This
must be verified against a real styled (not just per-cell-shaded) docx fixture
in Phase 0 before the docx confidence level is trusted. `w:jc` values include
the modern `start`/`end` spellings alongside `left`/`right`/`center`/`both`
(→justify). `w:tblGrid/w:gridCol/@w:w` for column widths — convert to
fractions immediately, never carry twips downstream. Border presence via
`w:tblBorders`/`w:tcBorders`. Rowspan requires column-index bookkeeping across
rows (accounting for `gridBefore`/`gridAfter`), not just counting
`vMerge=="continue"` rows naively.

**xlsx (openpyxl)**: `cell.fill.fgColor.rgb` is meaningless unless
`cell.fill.patternType == 'solid'` (else `'00000000'` for every cell — check
patternType first). `rgb` is ARGB (8 hex chars) — strip the alpha byte.
`color.type` can be `'theme'`/`'indexed'` where `.rgb` is None/bogus — leave
`None` (honest) rather than mis-render; do not attempt theme/indexed
resolution in v1. `merged_cells.ranges` for spans (style/value live only on
the top-left cell — confirmed via docs). `column_dimensions[x].width` is
character units (~7px), `None` for default width — convert to fractions
relative to the table's own columns, treat `None` as an equal-share default.
Force non-read-only mode only for the sheet region actually containing a
detected table (per-cell style access is slow; unbounded `max_row`/
`max_column` on a real workbook can be catastrophic). Decide explicitly
whether `cell.number_format` (e.g. `3.30` vs `3.3`) is in scope — flagged as a
real, user-visible fidelity question, default to **out of scope for v1**
unless directed otherwise.

**pptx (python-pptx)** — Phase 3, new capability, not a styling add-on.
`pptx_loader.py` currently builds **no `Table` objects at all** (`has_text_frame`
is False for a `GraphicFrame` table, and the shape loop only handles pictures
and text frames) — every pptx table is silently dropped today. Must add real
table detection (`shape.has_table`) and extraction before any styling applies.
Once extraction exists: `is_merge_origin`/`is_spanned`/`span_height`/
`span_width`, gated correctly (span values are ONLY valid on a cell that
tests `is_merge_origin` true first — confirmed via docs). `cell.fill.type` is
`None` when inherited from the table style, and touching `.fore_color` then
raises — guard explicitly. `font.color.type` can be `MSO_THEME_COLOR`, where
`.rgb` raises `AttributeError` — guard explicitly. Border: default to `None`
(unknown), never assert `"grid"` without real detection — pptx tables usually
get gridlines from an applied table-style reference, not explicit per-cell
border XML, so asserting "grid" would claim confidence that doesn't exist.

**PDF (pdfplumber)** — Phase 4, explicitly best-effort. Investigated:
`Table.rows` returns `Row(cells: List[Optional[bbox]])` — merged cells already
surface as `None` at covered positions (confirmed by reading pdfplumber's own
source, `table.py`). **`None` is ambiguous** between "spanned" and "a genuine
gap" — must be disambiguated in the model (see Data model section above), or
gappy PDFs produce structurally broken tables. Column count = number of
distinct `x0` values (sub-pixel misalignment can inflate it); row grouping is
on exact `top` equality (same fragility) — both need real-fixture
verification in Phase 0, not just doc-read confidence. Better span inference
than bbox-width comparison: colspan = count of column x-starts within
`[cell.x0, cell.x1)`; rowspan = count of row tops within
`[cell.top, cell.bottom)` — reuses the same edge sets pdfplumber already
derived. `page.rects[...]["non_stroking_color"]` is **not a hex** — a tuple
whose arity depends on colorspace (1=gray/3=RGB/4=CMYK), can be `None` or a
pattern name — needs real conversion + a skip-if-unknown branch. Bold via
`fontname` substring match needs a wider token list than `"bold"` alone
(`-Black`, `-Heavy`, `-Semibold`, `-Bd` are all real, common subset-font
suffixes that a bare `"bold"` check misses). Alignment via text position
within the cell bbox (geometric heuristic). Column widths/border presence are
more reliable (same geometry that found the table at all) — but this
reliability is conditional on the table having been found via the `"lines"`
strategy in the first place; a borderless PDF table already yields nothing
today, unrelated to this feature.

## Contrast-adaptation algorithm (replaces the originally-proposed HSL-lightness-clamp approach, which was the wrong tool)

Constraint: ADO's `System.Description` only honors inline `style="..."` —
no `<style>` blocks, no media queries, no runtime dark-mode detection
possible. A single literal color value must work in both ADO themes at once.

1. **Normalize away "no fill."** `auto`, `none`, `#FFFFFF`, and any background
   with relative luminance > 0.92 → treated as no background at all. This is
   fidelity-*correct* (matches Word/Excel's own "no fill" defaults) and
   eliminates the white-patch-in-dark-mode failure mode before it starts.
2. **When a cell has a real background: emit BOTH `background-color` AND
   `color` together.** This makes the pair theme-independent by construction
   — both layers are overridden, so the underlying ADO theme is irrelevant.
   Background passes through close to verbatim (max fidelity). Text color:
   the source text color if its contrast against that background is ≥ 4.5:1,
   else whichever of `#1b1b1b`/`#ffffff` scores higher against it.
3. **Text color with NO background (the one genuinely hard case).** The math:
   contrast(white) = 1.05/(L+0.05); contrast(ADO dark surface ≈ #1f1f1f,
   L≈0.0129) = (L+0.05)/0.0629. Their product is a constant ≈16.7 regardless
   of L, so simultaneous WCAG AA (4.5:1) against both themes at once is
   **mathematically impossible** (best achievable ≈4.09:1 at L≈0.207). Honest
   target: 3:1 both ways, which holds for L ∈ [0.139, 0.30]. Pass the source
   color through verbatim if it's already in-band; otherwise scale into the
   band preserving hue — using **linearized-sRGB relative luminance**, not
   HSL lightness (HSL L=50% treats `#FFFF00` and `#0000FF` as equally light
   despite a ~20x real luminance difference — exactly the case "still
   recognizably yellow" needs to get right).
4. **Borders: `border: 1px solid` with NO explicit color.** CSS falls back to
   `currentColor`, inheriting ADO's own theme text color — genuine, free,
   automatic light/dark adaptation. Never emit a captured/literal border
   color.
5. **Escape hatch**: one config knob, `table_style_fidelity: full |
   structure-only | off`, since this can't be fully verified against a real
   ADO dark theme until it ships to one.
6. **Testability**: every rule above is a pure function of a color. Property
   test: for any input color, `min(contrast_against_light, contrast_against_dark) ≥ 3.0`
   after adaptation. This is the actual acceptance criterion for the
   dark-mode claim, not a visual spot-check.

## Security: style-attribute injection (new attack surface, not present today)

Today the only untrusted content in generated HTML is `html.escape`'d text
content. This feature interpolates source-document-derived values
(colors, alignment, widths) into `style="..."` attributes for the first time.
**Never pass a raw source string into a style value.** Build every style
string only from validated, normalized primitives: hex colors matched against
`^#[0-9a-f]{6}$`, floats clamped to a sane range, alignment restricted to the
literal enum. A crafted `w:shd/@w:fill` value like `x" onmouseover="..."`
must never reach the output.

## Layout overflow (same bug class as the figure-sizing bug fixed this session)

Absolute source units (twips/EMU/characters/points) must never reach the
renderer. Convert to fractions of table width in the loader; render as
percentages with `width:100%; border-collapse:collapse`. The HTML-generation
layer should never see a source unit, only fractions.

## Consumers requiring updates (full sweep, not just the obvious ones)

- `ingestion/app/leveling/tree_builder.py`'s `_table_to_html` — full rewrite
  to walk the `TableCell` grid, emit `<thead>/<th>`, `colspan`/`rowspan`,
  validated inline styles, `<caption>`.
- `ingestion/app/leveling/id_hierarchy.py` — swap to `plain_text_rows`, zero
  logic change.
- `ingestion/app/leveling/llm_leveling.py:671`'s `_table_to_markdown` — same
  swap.
- `ingestion/app/leveling/table_groups.py:120` — uses
  `parsed_id_rows_from_table`, same swap.
- `ingestion/app/main.py:833` — `table_row_count=len(table.rows)` →
  `len(table.cells)`. This is asserted by an existing test
  (`test_ingest_endpoint.py`) and is itself the subject of a prior
  known-issue about honest row counts — not a zero-change consumer.
- `ingestion/app/kb/chunker.py:33` — table text feeds KB chunk embeddings
  persisted in Chroma. New pptx table content appearing for the first time
  changes KB content for any document with pptx tables; decide whether
  existing KB documents need re-ingestion once pptx extraction ships
  (Phase 3).
- `ingestion/app/redaction/redactor.py` — see Data model section.
- **`orchestrator/src/modules/pipeline/description-html.ts:20`**'s
  `TABLE_BLOCK_PATTERN` and **`frontend/src/ui/Markdown.tsx:48`**'s matching
  pattern — both hardcoded to bare `<table>` with no attributes. Must be
  updated in lockstep to tolerate the real emitted shape (attributes on
  `<table>`, `<thead>`, `<th>`, `colspan`, `rowspan`) or every table silently
  breaks into literal escaped garbage in the real ADO work item — this is
  exactly the bug class known-issues #17 already fixed once.
- **`frontend/src/ui/Markdown.tsx`'s `TrustedTable`/`parseTrustedTableRows`**
  — currently a narrow regex parser matching only `<td>...</td>`. Replace
  with a real `DOMParser`-based walk over the trusted block, mapping to React
  elements through an explicit tag/attribute allowlist (`table`/`thead`/
  `tbody`/`tr`/`th`/`td`/`caption`/`colgroup`/`col` + `colspan`/`rowspan`/
  validated `style` properties). Still zero `dangerouslySetInnerHTML` — the
  file's stated safety invariant is preserved, just implemented properly
  instead of via a regex that grows a new special case per feature.
- **`orchestrator/src/modules/writeback/dry-run.service.ts:382`**'s
  `dedupCheck` call vs. **`orchestrator/src/modules/writeback/backfill.service.ts:78-79,139`**'s
  `stripHtmlTags` — a pre-existing, already-documented asymmetry (raw HTML on
  one side, stripped on the other) that materially worsens once table HTML
  carries real `style="..."` bulk. Fix: make both sides consistent (strip
  HTML / use `plain_text_rows` derived text on both call sites) as part of
  this work, not deferred.
- `orchestrator/src/modules/pipeline/jobs.service.ts:702-708`'s integrity
  audit byte-compares generated HTML against what ADO actually stored — see
  Phase 0 spike below; this is exactly what the spike must validate before
  colors/widths/borders are trusted.
- Hardcoded expected-HTML test fixtures needing updates:
  `ingestion/tests/test_tree_builder.py` (lines ~253, 619, 649),
  `orchestrator/test/description-html.spec.ts` (lines ~56, 58, 63, 66),
  `frontend/src/ui/Markdown.test.tsx` (lines ~39, 48, 55).
- `ingestion/build/lib/**` is a stale full copy of the app — never edit it,
  and expect it to pollute greps.

## fidelity_hash / identity_hash

`identity_hash` (the real idempotency key, position-only) is unaffected by
description content changes — confirmed by reading `pipeline.worker.ts:440`.
`fidelity_hash` (`sha256(description)`) WILL change for every table-bearing
node once this ships, but it's a legacy fallback only, not the reuse-matching
key. Re-run the golden-e2e 100%-reuse assertion (`scripts/run-golden-e2e.sh`)
as part of Phase 1/2 verification to confirm this holds in practice, not just
in theory.

## Phase 0 findings (confirmed empirically, not assumed)

1. **ADO round-trip HTML normalization — UNRESOLVED, requires a live write.**
   No public documentation covers ADO's server-side REST-API HTML storage
   behavior for `System.Description` (roosterjs's sanitizer is a client-side
   paste-cleanup path in the browser editor, not what happens when a REST
   client PATCHes raw HTML directly, which is how req2ado writes). This
   remains a genuine open question, but it only gates Phase 2 (the first
   phase introducing inline `style="..."` attributes) — Phase 1 emits only
   `<table>/<thead>/<tr>/<th>/<td>` plus `colspan`/`rowspan`, and bare
   `<table>/<tr>/<td>` is ALREADY proven working in real ADO today (existing
   production behavior). Resolve this with an explicit live-write spike
   (one throwaway work item, real MCP path, crafted HTML, read back and
   diff) before Phase 2 starts, not before Phase 1.

2. **docx table-style shading — confirmed via real fixture, scope decision made.**
   Built a real docx using Word's built-in "Light Grid Accent 1" table style
   (visually has header shading + row banding in Word) and inspected every
   cell's raw XML directly: **zero** `w:shd/@w:fill` present anywhere. All
   styling lives in `w:tblStyle`'s reference into `styles.xml`'s conditional
   formatting (`w:tblStylePr` variants per firstRow/lastRow/band1Horz/etc.),
   invisible to per-cell XML reading. Decision: full OOXML table-style
   conditional-formatting resolution (layering wholeTable < conditional
   variant < explicit per-cell override) is a disproportionately large
   feature on its own — **out of scope for v1**. Only explicit per-cell
   `w:shd` and explicit `w:trPr/w:tblHeader` are captured; table-style-implied
   shading is a documented, honest v1 gap (consistent with "absent means not
   detected, never half-guess").

3. **PDF span-vs-gap disambiguation — confirmed via real fixture, algorithm locked in.**
   Built a real PDF (reportlab) with a genuine horizontal cell merge (`SPAN`
   command) plus a separate genuinely-empty cell, then inspected
   `pdfplumber.find_tables()`'s actual output directly:
   - A **spanned** position: `bbox=None`, and the origin cell's own bbox is
     abnormally wide (200pt vs. every other cell's 100pt) — colspan is
     directly readable by counting how many normal column widths the
     origin's bbox covers.
   - A **genuine gap**: bbox is present and completely normal
     (single-column-width), extracted text is merely empty.
   These are unambiguously distinguishable by checking `bbox is None` first
   (span) vs. `bbox is not None` + empty text (gap) — confirms the model's
   span/gap disambiguation requirement is both necessary and directly
   implementable exactly as designed.

## Phased build order

- **Phase 0 (prerequisite spike, blocks Phase 2+)**: (a) write one real work
  item through the actual MCP path with `style=`, `colspan`, `<thead>`,
  `<th>` in its description, read it back, diff against what was sent — does
  ADO preserve inline styles/structure byte-for-byte or renormalize them? (b)
  build a real docx fixture using an actual Word **table style** (not just
  per-cell `w:shd`) and confirm python-docx's raw-XML reading genuinely
  misses style-inherited shading, exactly as flagged. (c) build a real
  multi-column, gappy PDF table fixture and directly inspect pdfplumber's
  `find_tables()` per-cell bbox/None structure to confirm the span-vs-gap
  disambiguation plan.
- **Phase 1**: schema + model (`TableCell`/`Table`, schema-first per the
  existing convention) + docx and xlsx structural extraction (colspan,
  rowspan, alignment, `is_header`) + both `TABLE_BLOCK_PATTERN` site fixes +
  frontend `TrustedTable` rewrite (DOMParser + allowlist) + the dedup
  asymmetry fix. Shippable and high-value standalone — no colors/borders/
  widths yet.
- **Phase 2**: colors (background/text, contrast-adapted per the algorithm
  above), borders (`currentColor` approach), column widths (fractions).
- **Phase 3**: pptx table extraction as its own feature (new capability),
  then structural + color/border/width parity with Phase 1/2 once extraction
  exists.
- **Phase 4**: PDF heuristic extraction (structure, then color/border/width
  parity), explicitly labeled lower-confidence via `style_provenance`.

## Testing expectations

Per-phase: ingestion pytest (loader-specific + shared `_table_to_html` +
schema conformance + identity/fidelity-hash-unaffected invariant tests),
orchestrator jest (`description-html.spec.ts` updates, dedup-asymmetry
regression test), frontend vitest (`Markdown.test.tsx` covering the new
DOMParser-based renderer across colspan/rowspan/thead/style-attribute cases,
including a malicious-style-injection test proving the allowlist rejects an
unvalidated value). Contrast algorithm gets property-based tests per the
stated acceptance criterion. Full-suite + golden-e2e re-run at the end of
each phase, not just at the very end.

## Final review

After all phases: a full review pass (architecture/correctness/security),
fixing any bugs found, before considering this complete.
