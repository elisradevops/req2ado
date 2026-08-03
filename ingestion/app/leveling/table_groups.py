# ingestion/app/leveling/table_groups.py
"""Detects "group rows" in a source table using the Requirement-ID/Section
convention confirmed live against a real customer-requirements document:

    Requirement ID | Requirement / Section
    1              | Television Receiver
    1.1            | Broadcast Reception and Input Sources
    1.1.2          | External Source Detection (HDMI / USB / AV)
    1.1.2.1        | The system shall detect a newly connected HDMI source...

Rows with a dotted numeric ID and NO "shall" statement (e.g. "1.1.2 External
Source Detection") are pure structural group labels the source document's
own author used to organize two or more child leaf requirements underneath
them. Confirmed live (3 separate runs against the same real document): a
QUALITATIVE prompt instruction to "use the source's own group label" had
ZERO measured effect on model behavior -- identical missing-group set before
and after. This module exists to compute a REAL, document-derived count
(mirroring build_survey_tree's existing heading_count/topic_count pattern,
already proven to work) so the analysis prompt can state a concrete "at
least N" floor instead of a soft reminder.

Every function here is a graceful no-op (returns [] / 0) for a table that
doesn't match this convention -- this is an enhancement for ONE common
document convention, not a hard requirement on all tables. It never raises
for a malformed/unexpected table shape.

Known, deliberate limitations (accepted, not silently papered over):
- Exactly 2 columns required. A 3rd column (e.g. "Priority") makes the
  whole table non-conforming. Real limitation if a customer table uses this
  convention plus extra columns -- flagged as a follow-up, not handled here.
- "shall" (case-insensitive, word-boundary) is the sole leaf/group
  discriminator -- English-only, and a group label whose own prose happens
  to contain "shall" (e.g. "Features the system shall eventually support")
  is misclassified as a leaf and excluded as a group candidate. This is the
  same class of pragmatic, non-NLP, English-specific heuristic this
  module's sibling code already uses (_GROUNDING_STOPWORDS,
  _REFERENCED_ATTACHMENT_PATTERN in llm_leveling.py) -- under-triggering
  (missing a real group) is the accepted failure direction, not
  over-triggering (inventing a group that isn't one).
- Counts DIRECT children only, not total descendant leaves -- matches the
  already-shipped prompt's own wording ("that group has TWO OR MORE child
  items under it"), not a transitive-descendant-leaf count (which would
  silently inflate a group's count via grandchildren of a nested sub-group).

`suggested_type` (Epic/Feature/Requirement) -- confirmed real gap, live-
tested against a reference structure: a group whose direct children are
THEMSELVES further split (group-of-groups, e.g. "Television Receiver" ->
"Broadcast Reception"/"System Settings"/"System Description", each of which
has its own children) represents a large functional domain and should
become a nested EPIC, not a Feature -- the original hint only ever offered
Feature or Requirement as options and never mentioned Epic at all, so the
model had no signal this was even possible. A group whose direct children
are ALL letter-suffixed leaves (e.g. "1.2.2.4 Mute and Volume-Restore
Behavior" -> "1.2.2.4.a"/"1.2.2.4.b") is a general statement being refined
by its own exceptions/conditions -- a parent REQUIREMENT with child
Requirements, confirmed by the reference's own convention of using a
lettered sub-ID specifically for this case (vs. a further NUMERIC dotted ID
for an unrelated sibling sub-topic, e.g. "1.2.1.4.1"/"1.2.1.4.2" under
Picture Modes, which is Feature-level grouping of distinct Requirements,
not one Requirement's own conditions). Anything else (children are numeric
leaves, or a mix) defaults to Feature.

`is_top_level` -- confirmed real gap, live-tested against the same
reference: a document can define MULTIPLE independent top-level domains
with no common ancestor (e.g. "Television Receiver" id "1" and "Remote
Control" id "2", each its own root Epic) -- the generation prompt's
hardcoded "at most ONE null-parent node" rule can't express this, so the
model invents a single wrapping root to merge them. A group's own ID
being a single segment (no dot) means it has no parent row in this
table's ID hierarchy -- the concrete count of such rows is threaded
into the prompt as an explicit root-count floor, the same
countable-instruction pattern `suggested_type`/`child_count` already use.

This module is now a thin, behavior-identical shim over
`app.leveling.id_hierarchy`, whose `qualifying_groups` is the same core
algorithm shared by the table-row convention here AND the ID-bearing-
heading convention (see `id_hierarchy.py`'s own module docstring) --
confirmed empirically to produce identical output across both sources on
the same real document content. Every name below is re-exported for
backward compatibility; nothing about this module's own behavior changed.
"""
from __future__ import annotations

from collections.abc import Iterable

from app.canonical.model import Table
from app.leveling.id_hierarchy import (
    EPIC,
    FEATURE,
    ID_PATTERN as _ID_PATTERN,
    LETTER_SEGMENT_BASE as _LETTER_SEGMENT_BASE,
    MIN_CHILDREN_TO_QUALIFY as _MIN_CHILDREN_TO_QUALIFY,
    MIN_ID_ROW_FRACTION as _MIN_ID_ROW_FRACTION,
    MIN_ID_ROWS as _MIN_ID_ROWS,
    REQUIREMENT,
    SHALL_PATTERN as _SHALL_PATTERN,
    TableGroupInfo,
    is_letter_segment as _is_letter_segment,
    parsed_id_rows_from_table,
    qualifying_groups,
)

# Forward-looking alias -- a future consumer of the source-agnostic name
# can use this without a rename touching this module's own 268-line test
# file or llm_leveling.py's existing import.
GroupInfo = TableGroupInfo


def qualifying_table_groups(tables: Iterable[Table] | None) -> list[TableGroupInfo]:
    """Every table-sourced "group row" (no 'shall' statement of its own,
    and either 2+ direct children or exactly 1 direct child that is itself
    a further-split group) across all given tables, in table/row order.
    Each table's IDs are scoped to that table alone -- two unrelated tables
    both using "1.1"-style numbering never cross-pollinate parent/child
    counting."""
    if not tables:
        return []
    results: list[TableGroupInfo] = []
    for table in tables:
        parsed = parsed_id_rows_from_table(table)
        if not parsed:
            continue
        results.extend(qualifying_groups(parsed))
    return results
