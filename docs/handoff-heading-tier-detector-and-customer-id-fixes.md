# Handoff — generic heading-tier detector + three Customer ID false-positive fixes (2026-08-26)

Repo: `/Users/EdenZviSchwartz/Repos/Projects/elisradevops/req2ado`, branch `bug/auto-svd-fix`.
Everything below is implemented, tested, and live-verified. Code comments were deliberately kept
lean (invariant + one-line why); this doc is where the full live-bug history and reasoning lives.

## Part 1 — Generic heading-tier detector (`app/leveling/heading_outline.py`)

### The bug this replaced

A first version of SURVEY mode's Epic/Feature type hint (`heading_type_hints`) hardcoded
`{1: "Epic", 2: "Feature"}` — it assumed Word's literal "Heading 1"/"Heading 2" numbers are always
the Epic/Feature tiers. Two real documents disproved that:

- `AirPro_BP_ICD_Revision_0.3.docx` has **no heading_level 1 at all** — its own top tier is level 2
  (levels 3–5 exist below it). The old map typed level 2 as "Feature"; it should be Epic.
- `pdf_loader.py`'s font-size-rank heading-level fallback (Tier 2, used only when no PDF
  outline/bookmark and no parsed numbering exist) is **document-relative**: it ranks only the
  distinct heading-candidate font sizes actually observed in *that* document, 1 = largest. A PDF's
  `heading_level=1` is not guaranteed to mean the same structural tier as a DOCX Heading-1 style,
  and isn't even guaranteed comparable across two different PDFs.

Fix: `heading_outline_entries()` never compares heading levels except *relative to each other,
within one document's own observed level set* — the same principle
`tree_builder._split_into_branches`'s `top_level_depth = min(known_depths)` and
`depth.resolve_block_depth` already use elsewhere in this codebase.

### Typing algorithm

Reuses `id_hierarchy.classify_by_nesting` (the same bottom-up, tree-shape-derived ladder
`rows_from_heading_structure` already uses for its own "convention 3") — unmodified. That
function's leaf rule (no non-override children → Requirement) is correct for an AirPro-shaped
document, where a leaf heading's own TEXT is the requirement statement. It is wrong for a
`Mock_PRD_Sensor`-shaped document, where a heading is a pure grouping label and the real
requirements live *below* it (a table's rows). Confirmed live: convention 3's own gate (a
whole-document "shall" fraction over leaf heading text) measures 0.000 for both real
`Mock_PRD_Sensor` files — none of their leaf headings contain "shall" at all, so both fall through
every deterministic convention and reach this hint as the LLM path's only structural signal.

The two conventions are reconciled as **data**, not two competing algorithms: for a leaf heading
with ≥2 distinct requirement-shaped table rows/paragraphs directly below it
(`_obligation_count`), a synthetic "phantom child" one level deeper is added before
classification — `classify_by_nesting` then resolves that leaf to Feature and its parent to Epic.
The threshold of 2 mirrors this codebase's own existing container rule
(`id_hierarchy.MIN_CHILDREN_TO_QUALIFY`).

**Phase 1 (current, deliberate scope limit):** only Epic/Feature-typed headings are ever named in
the model-facing hint. A Requirement-typed heading (AirPro's own leaf convention) is computed
honestly but never surfaced — naming every one would add ~420 items on an AirPro-sized document,
and there's no live evidence any document reaching this hint (vs. being claimed deterministically
first) needs it.

### Title/wrapper suppression (S1 / S2)

`docx_loader.py`'s `_heading_level_for_paragraph` maps Word's built-in "Title" style to
`heading_level=1`, indistinguishable from a real Heading 1 — `Block` carries no separate
style-name signal after loading (deferred: adding one needs a cross-service schema change,
`canonical-doc.schema.json` + `shared/ts` regen — not done, no current need). Two confirmed real
shapes needed two different structural tells:

- **S1** — `Mock_PRD_Sensor (1).docx`'s Title is followed by two short metadata paragraphs before
  the document's real first Heading 1: its span has content, but no table and no deeper heading. A
  real top-tier section in this convention always nests at least one deeper heading or table; a
  bare document title never does.
- **S2** — `Mock_PRD_Sensor (Not Properly Aligned).docx` has NO other heading at the Title's own
  (shallowest) level at all, so S1 alone fails (its span extends to the end of the document and
  legitimately contains tables/headings). **This was a real, confirmed live defect**: an earlier
  version of this module named this Title as its own Epic, producing one Epic literally titled
  "Product Requirements Document" wrapping every Feature in the file.

Both are pure emission filters, never tree edits — `classify_by_nesting`'s bottom-up types don't
depend on ancestors, so suppressing an entry can't change any other entry's computed type.

**A real, deliberately-accepted trade-off found while writing unit tests:** without the
deferred authoritative Title signal, a genuine LONE top-level Epic and a bare Title are
structurally indistinguishable whenever nothing else shares that heading's level (`len(levels) < 2`
guards against firing on a document/section with only one heading at all; beyond that, S1/S2 will
suppress a real solo Epic too). This is intentional: a suppressed real Epic just falls back to the
model's own pre-existing judgment; naming a bare Title as an Epic is the confirmed-wrong shape this
whole fix exists to prevent. Asymmetric risk, resolved toward suppression.

**Also found while testing:** `classify_by_nesting`'s own type computation is subset-invariant (a
node's type depends only on its descendants, never ancestors/siblings) — so recomputing this hint
from a branch's own block subset would NOT retype anything wrong on its own. The REAL reason
`entries_for_blocks` must filter a document-wide computation rather than recompute per branch: a
branch that isolates one Epic's whole subtree makes that Epic look, from inside the branch alone,
exactly like S2's "lone top-tier heading" shape, and get wrongly suppressed even though the full
document has other siblings at that level. (Regression test:
`test_filtering_a_document_wide_outline_survives_a_branch_split_the_suppression_heuristic_would_not`
in `tests/test_heading_outline.py`.)

### PDF loader bug found and fixed alongside this (`app/loaders/pdf_loader.py`)

`_heading_level_from_size_rank`'s rank assignment only ever compared a NEW size against sizes
already seen — it never revisited an EXISTING size's own rank once a genuinely larger size arrived
later in document order. A smaller heading size encountered before a larger one (e.g. a level-3
heading's size seen on page 1, the document's real level-1 size not seen until page 4) kept its
earlier, now-wrong rank — both sizes collided onto rank 1, silently merging two real heading tiers
into one. Fixed: every existing size smaller than a newly-seen size now gets its own rank pushed
one level deeper first, so the final ranking always matches sorted size order regardless of
arrival order.

### Live verification (all three real documents, before → after)

| Document | Before | After |
|---|---|---|
| `Mock_PRD_Sensor (1).docx` | 4 Epic + 5 Feature | 4 Epic + 5 Feature (unchanged, byte-identical) |
| `Mock_PRD_Sensor (Not Properly Aligned).docx` | 1 bogus Epic ("Product Requirements Document") + 5 Feature | 5 Feature, 0 Epic |
| `AirPro_BP_ICD_Revision_0.3.docx` | 0 Epic + 78 Feature (wrong — top tier is level 2) | 28 Epic + 94 Feature + 421 correctly-silent Requirement leaves |
| `mock_icd.docx` (repo fixture) | n/a (pre-existing convention-3 fixture) | 1 Epic + 2 Feature, 3 Requirement leaves — confirms same nominal heading depth can resolve to different types (`Power Distribution` → Epic, `Thermal Management` → Feature) purely from nesting shape |

New fixtures committed for permanent CI coverage: `tests/fixtures/mock_prd_sensor.docx` /
`build_mock_prd_sensor_docx.py` and `mock_prd_flat.docx` / `build_mock_prd_flat_docx.py`, with a
golden regression test running the real `docx_loader.py` parsing path
(`tests/test_heading_outline_golden.py`).

### Design decisions confirmed with the user (2026-08-26)

1. Requirement-typed headings: **stay silent** (Phase 1) — no live evidence any document needs
   them named yet.
2. Epic nesting depth: **every non-leaf tier** gets named Epic (structure-faithful), not just the
   tier directly above Features.
3. Authoritative Word-Title `Block` signal: **deferred** — S1/S2 already handle all three real
   documents correctly; adding it needs a cross-service schema change with no current need.
4. Flat single-tier documents (no Heading-1-equivalent grouping tier at all): **flat Feature hints
   only, no Epic hint** — let the existing `_regroup_disconnected_roots` /
   `_ensure_root_features_have_epic_parent` repair passes decide afterward whether topical Epics
   are warranted, rather than inventing structure with no evidence.
5. The PDF ranking bug above: **fixed in scope**, same day.

---

## Part 2 — Three Customer ID false-positive bugs (all in SURVEY mode)

All three share the same root shape: a generic customer-code regex
(`customer_id.py:extract_customer_requirement_code`, `[A-Z]{2,8}...\d{2,8}`) applied somewhere it
shouldn't have been trusted, because the input text can contain an unrelated, coincidentally
code-shaped token (an industry standard citation, a component part number, a product/variant
name) that isn't the row's own customer-assigned identifier.

### Bug 1 — deterministic path (`app/leveling/id_tree_builder.py`), convention 3

**Found:** a real SURVEY job on `AirPro_BP_ICD_Revision_0.3.docx` (convention 3 — pure heading
structure, no ID text convention by design) showed `customerId` values like `VITA62`, `VITA65`,
`RS-232`, `PCA9517`, `TPS25990`, `LTC4359`, `MAX31785` — industry standard citations (VITA 62/65,
RS-232) and chip part numbers (Texas Instruments, Maxim, Linear/Analog Devices, NXP) mentioned
inside "shall comply with..." requirement text — 47 of 428 Requirements, none of them real
customer IDs.

**Root cause:** `extract_customer_requirement_code` was being run against a Requirement's full
free-flowing text regardless of which of the three deterministic conventions produced the row.
Convention 3 has **no ID concept at all** by its own design (`rows_from_heading_structure`'s own
docstring: "no id text at all -- structural nesting is the only signal available") — scanning its
leaf text for anything code-shaped was scope creep never justified by that convention's own
premise.

**Fix:** gated the whole customer_id assignment (both the regex attempt and the numeric
`id_text` fallback) on `HierarchyRow.id_text_is_authored` — true only for conventions 1/2, which
have a genuine document-authored ID scheme. Convention 3 rows now always get `None`, correctly
surfaced by the existing `MISSING_SOURCE_REFERENCE` warning instead.

### Bug 2 — SURVEY LLM fallback (`app/leveling/llm_leveling.py`, `_author_branch_content`), prose

**Found:** re-running `cubeadcs_icd.pdf` (SURVEY) still showed `customerId: "PC104"` /
`"RS-485"` on several Requirements, even after Bug 1's fix (this document isn't
convention-3-shaped at all — it's a different, later-stage mechanism).

**Root cause:** the STAGE-3 fallback (`node.customer_id = extract_customer_requirement_code(node.description)`)
searched the model's own generated PARAGRAPH prose, not just an embedded table. "PC104" and
"RS-485" were cited product/protocol designators within that prose (e.g. "The PC104 variant...").

**First fix attempt (insufficient on its own):** restrict the search to just the embedded
`<table>...</table>` HTML (`_EMBEDDED_TABLE_HTML_PATTERN`, already used for a different purpose in
`trace_links.py`), never the surrounding prose. This did NOT fully fix it: "PC104" also sat inside
a *real* folded table — one of only 3 "Variant" column values ("PC104", "Backplane", "Demo
Model"), a category label that happens to be code-shaped once, not a repeating id column. Being
inside a genuine source table doesn't by itself make a code-shaped cell a real per-row id.

**Actual fix:** added `requirement_rows.repeated_customer_code_in_table` — trusts a code only when
the SAME column repeats a whole-cell match at least `MIN_ID_ROWS` (2) times in the real `Table`
object. Deliberately NOT reusing `qualifying_requirement_rows`'s own full gate (that function's
50%-of-rows fraction requirement is the *separate* "should this whole table be pre-split into its
own per-row nodes at stage 1" decision) — a table that met that fuller gate is already excluded
from ever reaching this fallback at all (Phase 6 of Part 1's own SURVEY work), so re-checking the
same full gate here would always read empty by construction. This was a real logic bug caught only
by writing the regression test with a fixture that (by construction) also satisfied the fuller
gate.

### Bug 3 — SURVEY primary mechanism (`_validated_skeleton_customer_id`, stage 1)

**Found:** after Bug 2's fix, `cubeadcs_icd.pdf` STILL showed `customerId: "PC104"` on 5 different,
unrelated Requirements across two more job re-runs — same node IDs, same value, every time.

**Root cause:** all 5 nodes had `table_ids: []` (no table folded in at all), proving the value came
from an entirely different, third mechanism: stage 1's own model-reported `customer_id`
(the PRIMARY mechanism, verified only by checking the string appears verbatim somewhere in that
branch's own source text). "PC104" genuinely appears in each node's real source text (it's a
recurring product-family name across the document), so the verbatim-grounding check passed it —
but grounding only proves the string is real, not that it's actually *this row's own unique
identifier* rather than a mentioned category name.

**Fix (whole-tree safety net, not a targeted patch):** a genuine customer ID is unique to one
requirement by definition. Extended `main.py`'s existing `_enforce_requirement_only_fields` exit
pass (already the single choke-point for every Customer-ID-related invariant, same
`VISION_CAPTIONING_DISABLED` precedent) to detect any `customer_id` value shared by 2+ Requirements
ACROSS THE WHOLE TREE and strip it from all of them — since neither stage 1 nor stage 3 has enough
context on its own to know which node (if any) is genuinely correct. New warning kind
`duplicate_customer_id` (schema + generated TS updated) names the value and every affected node.
This catches the bug regardless of *which* mechanism produced the duplicate, so it's also a
backstop for any future variant of Bugs 1/2.

**Live verification, 4 job runs total on `cubeadcs_icd.pdf` (SURVEY):**

| Run | Result |
|---|---|
| 1 (baseline, pre-session) | 85 nodes, 0 customer_id (this doc's shape didn't trigger Bug 1 or 2 back then) |
| 2 (after heading-outline work + Bug 1 fix) | 43 nodes; `PC104`×5, `RS-485`×1 — Bug 2 discovered |
| 3 (after Bug 2's first, insufficient fix) | same `PC104`×5 persisted — led to the `repeated_customer_code_in_table` fix |
| 4 (after Bug 2's real fix) | `PC104`×5 STILL persisted — led to discovering Bug 3 (table_ids was `[]` for all 5, proving a different mechanism) |
| 5 (after Bug 3's duplicate-detection fix) | `customer_id` count: **0** — `duplicate_customer_id` warning correctly names `PC104` and all 5 node IDs |

Node count (43, same 5 Epic / 22 Feature / 16 Requirement split) was stable across runs 2–5 —
the earlier 85 → 43 drop between runs 1 and 2 is attributed to ordinary SURVEY LLM run-to-run
node-count variance (already documented elsewhere in this codebase for other real documents),
not a regression: Feature/Epic counts (the tier Part 1's own work actually touches) stayed nearly
identical, and hierarchy/coverage warnings were comparable both times.

### Files touched, Part 2

- `app/leveling/id_tree_builder.py` — `id_text_is_authored` gate (Bug 1).
- `app/leveling/requirement_rows.py` — new `repeated_customer_code_in_table` (+ `_best_matching_column`
  refactored out of `_id_column_index`) (Bug 2).
- `app/leveling/llm_leveling.py` — stage-3 fallback now calls `repeated_customer_code_in_table`
  against `skeleton.tables_by_id`, not a raw regex search (Bug 2).
- `app/main.py` — `_enforce_requirement_only_fields` duplicate-detection pass (Bug 3).
- `app/workitem/model.py` + `shared/schemas/work-item-tree.schema.json` +
  `shared/ts/src/generated/WorkItemTree.ts` — new `WarningKind.DUPLICATE_CUSTOMER_ID`.
- `frontend/src/components/CollapsibleWarnings.tsx` — `KIND_META` entry for the new warning.
- Tests: `tests/test_id_tree_builder.py`, `tests/test_requirement_rows.py`,
  `tests/test_llm_leveling.py`, `tests/test_enforce_requirement_only_fields.py` (new),
  `tests/test_worktree_schema_conformance.py`.

Full ingestion suite: 1629 passed, 1 skipped (pre-existing), 1 deselected (pre-existing known
flake, `test_ingest_survey_mode_still_captions_when_vision_is_configured`, unrelated to any of
this). Orchestrator (`nest build`) and frontend (`npm run build`) both clean.
