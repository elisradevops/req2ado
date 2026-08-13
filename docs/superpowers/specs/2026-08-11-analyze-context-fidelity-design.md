# Analyze-Stage Context Fidelity — Design

Date: 2026-08-11
Status: Approved, pending implementation plan

## Problem

Investigation of the SURVEY analyze stage (`build_survey_tree` in
`ingestion/app/leveling/llm_leveling.py`) surfaced two related but
independently-scoped fidelity gaps:

1. **Cross-branch context loss.** Branches are analyzed independently
   (deliberately, to avoid lost-in-the-middle degradation), with a
   compact document outline as the only whole-document signal threaded
   into every branch's call. That outline is built from the wrong
   primitive and misses most of the document's actual heading structure,
   and there is no mechanism to give every branch access to short,
   universally-relevant content (definitions/acronyms) without a full
   whole-document dump.
2. **docx ingestion structural gaps.** Cross-referencing the docx loader
   (`ingestion/app/loaders/docx_loader.py`) against `docgen-json-to-word`
   (the sibling repo that generates real .docx files) surfaced multiple
   document structures the loader silently drops or misclassifies:
   heading detection depends entirely on Word style-name matching,
   `w:sdt`-wrapped content is skipped whole, lists are never
   distinguished from paragraphs, embedded/attached documents
   (`w:altChunk`, OLE objects) vanish with no trace, nested tables inside
   cells lose their text, heading numbers exist only as style numbering
   (never in run text) so ordinal identity ("3.4.2") is lost on
   ingestion, and figure captions are never linked to their figure.

These are addressed together because Component 1's outline-building
logic is only as good as Component 2's block classification — a heading
the loader never emits cannot appear in the outline regardless of how
the outline code is fixed.

## Non-goals

- Full recursive extraction of embedded/attached documents (`w:altChunk`,
  OLE payloads) — flagged visibly instead (see Component 2).
- Full text-box content extraction, OCR on docx-embedded images, and
  hyperlink/bookmark target capture — no evidence yet these are common
  enough in real customer documents to justify the effort; flagged
  visibly, deferred.
- Header/footer text extraction — low value for requirement analysis
  (typically metadata/pagination, not requirements content).
- Any change to PDF/RTF/OCR loaders beyond what's noted as shared
  helpers (e.g. `resolve_block_depth` reuse).

## Component 1: Cross-branch context (`llm_leveling.py`)

### Outline completeness

`_build_document_outline` currently derives each branch's outline entry
via `_derive_section_label`, which returns only the branch's *first*
heading block (`BlockKind.HEADING` match). This misses:

- Every heading in a branch beyond the first (branches are frequently
  merged from multiple original sections via `_merge_branches_by_budget`).
- Numbered pseudo-headings in plain paragraph text (e.g. `"3.2 Backplane
  Power"` with no `HEADING`-styled block) — the exact case
  `_split_into_branches`/`resolve_block_depth` already treats as a real
  heading boundary. Using `BlockKind.HEADING` directly is inconsistent
  with the predicate that actually drove the branch split.

**Fix:** add `_branch_heading_labels(blocks) -> list[str]`, iterating a
branch's blocks and collecting the text of every block where
`resolve_block_depth(block)[0] is not None` (the same predicate
`_split_into_branches` uses — covers both real `HEADING` blocks and
numbered-paragraph pseudo-headings). `_build_document_outline` joins
these per branch (e.g. `"; "`-separated) instead of calling
`_derive_section_label`. `_derive_section_label` itself is unchanged —
it's still correct for its own use (a single short narration label).

The same undercount bug exists a second time at `llm_leveling.py:1691`
(`topic_count` computed via `b.kind == BlockKind.HEADING`) — fix it with
the same predicate for consistency.

### Glossary/definitions inlining

Short definitions/acronyms/glossary sections are exactly the content a
*different* branch is most likely to need and least likely to have —
confirmed live as a real failure mode (duplicate/conflicting spec values
restated across sections, per `conflict_detection.py`'s own comments).

**Fix:** add `_inline_glossary_context(branches, branch_tables) ->
str | None`. For each branch:
- Match its heading label(s) against a keyword pattern (definitions,
  acronyms, glossary, abbreviations, terminology — case-insensitive).
- If matched, render its full content via `render_section(blocks,
  tables, figures)` (already used elsewhere — interleaves tables in
  document order).
- If the rendered length is under a small token cap (module-level
  constant, e.g. `_GLOSSARY_INLINE_MAX_TOKENS`), append the rendered
  text (labeled with its source section) to `global_context` for every
  *other* branch. Oversized matches are left as outline-label-only —
  never partially inlined, to avoid an unpredictable truncation
  appearing mid-glossary.

This requires threading `branch_tables` (already computed, currently
only used for per-branch rendering) into the outline/glossary assembly
call site, which today receives only `blocks`.

### Error handling

No new failure surface. `resolve_block_depth` and `render_section` are
existing, already-called-elsewhere primitives; this only changes which
blocks get selected before calling them.

### Testing

New/updated cases (existing `ingestion/app/test/` suite for
`llm_leveling.py`):
- Outline lists every heading in a multi-heading merged branch, not just
  the first.
- Outline lists a numbered pseudo-heading (plain paragraph text, no
  `HEADING`-kind block).
- `topic_count` matches branch count on a numbered-pseudo-heading-only
  document (regression for the second undercount site).
- A small "Definitions" branch's content appears verbatim in a
  *different* branch's `global_context`.
- An oversized "Definitions" branch is NOT inlined (stays label-only).

## Component 2: docx loader fidelity (`docx_loader.py`)

### Heading detection

Replace `style_name.startswith("Heading ")` + unguarded `int()` with
`_heading_level_for_paragraph(paragraph) -> int | None`:
1. Check `w:pPr/w:outlineLvl` first — the template-independent OOXML
   signal for heading depth, unaffected by style name/language/customization.
2. Fall back to style-name match: `Title` maps to level 1 (same rank as
   `Heading1` — no separate level 0 semantics introduced); `Heading\s*\d+`
   parses its trailing number (allow no space, since
   `docgen-json-to-word` emits `Heading3`).
3. Any parse failure (non-numeric custom style suffix) logs and falls
   through to `PARAGRAPH` — never aborts the load.

### `w:sdt` unwrap

The body walk currently matches only `w:p`/`w:tbl` at the top level, so
a `w:sdt` (content control) subtree is skipped whole. Fix: when a
`w:sdt` is encountered, descend into `w:sdt/w:sdtContent` and recurse
the same walk over its children (which may themselves contain
`w:p`/`w:tbl`/nested `w:sdt`).

### List items

When a paragraph is not a heading, check for `w:pPr/w:numPr` — if
present, emit `BlockKind.LIST_ITEM` (already exists in the canonical
model, never emitted for docx) instead of `PARAGRAPH`.

### Icon-figure filtering

The fallback rel-sweep (which catches otherwise-unreferenced image
parts) currently also catches OLE-object icon images (referenced via
VML `ImageData`, not `a:blip`), emitting one phantom `FIGURE` block per
attachment. Fix: exclude any image part that's referenced by a sibling
`w:object`'s VML icon reference from the fallback sweep.

### Heading number synthesis

Track a per-level counter while walking; on each detected heading,
increment its level's counter and reset deeper levels, then prepend the
computed dotted number to the stored heading text — **unless** the text
already starts with its own number (reuse the existing number-detection
predicate in `app/leveling/numbering.py` as the guard, to avoid
double-numbering documents that already write their own numbers).

### Caption linking

When a `Caption`-styled paragraph is immediately adjacent to a `FIGURE`
block with no caption set, attach the paragraph's text to that figure's
`caption` field instead of emitting it as a separate `PARAGRAPH` block.

### Fail-loud markers (not silent drops)

Each isolated in its own try/except, so one malformed element degrades
to a marker (or today's pre-fix behavior) rather than aborting the whole
document load:
- `w:altChunk` → `BlockKind.NOTE`: `"[UNSUPPORTED: embedded document
  (altChunk) — content not extracted]"`.
- OLE-embedded object → `BlockKind.NOTE` near the existing
  icon+filename paragraph: `"[UNSUPPORTED: embedded object '<filename>'
  — content not extracted]"`.
- Table cell containing a nested `<w:tbl>` → cell text becomes
  `"[UNSUPPORTED: nested table]"` instead of the empty/partial text
  `cell.text` would otherwise produce.
- `w:txbxContent` with any text runs → `BlockKind.NOTE`:
  `"[UNSUPPORTED: text box content — N chars not extracted: '<first 40
  chars>…']"` (a truncated peek, not a claim of full extraction).

### Testing

New fixtures in the existing docx-loader test suite:
- `Title`-styled paragraph + a custom heading style with a non-numeric
  suffix → no crash; both handled correctly (logged fallback for the
  custom style).
- `w:sdt`-wrapped heading + paragraph → content is not dropped.
- Numbered list (`w:numPr`) → `LIST_ITEM` blocks, not `PARAGRAPH`.
- OLE-embedded object (icon + filename) → one `NOTE` block, no phantom
  icon `FIGURE`.
- Nested table inside a cell → placeholder marker, not silently empty.
- Unnumbered headings ("Introduction", "Scope") → synthesized "1.", "2."
  prefixes; headings that already carry their own numbers → no
  double-numbering.
- `Caption`-styled paragraph adjacent to an image → `Figure.caption`
  populated, no stray paragraph block.
- `w:altChunk` → `NOTE` block present, no crash, no silent loss.

## Implementation sequencing

Two independent phases (Component 2 has no dependency on Component 1,
but Component 1's outline quality improves once Component 2 emits more
accurate `LIST_ITEM`/heading blocks):
1. Component 2 (docx loader fidelity) first — improves the primitives
   Component 1 consumes.
2. Component 1 (cross-branch context) second, building on the corrected
   block classification.
