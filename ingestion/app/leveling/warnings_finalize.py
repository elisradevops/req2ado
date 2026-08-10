"""Groups per-occurrence IntegrityWarning records into one summary record
per distinct group, run ONCE over a tree's fully-assembled warnings list
right before it's handed to WorkItemTree (see build_survey_tree/
build_baseline_tree's own call sites) -- never inside the per-node/per-row
loops that emit these records, so those loops stay simple (append one fact
per occurrence) and the "make it readable" logic lives in exactly one
place.

Deliberately standalone (imports only app.workitem.model) so both
tree_builder.py and llm_leveling.py can call it without adding to their
existing import graph -- see id_tree_builder.py's own docstring for why a
cross-import between those two would be circular.

Real gap this closes: several IntegrityWarning kinds are still emitted
inside a per-node/per-row loop (e.g. root_regrouping.py's
_repair_requirement_hierarchy appends one REPARENTED_TO_FEATURE record per
violating Requirement) -- a document with 40 violations produced 40
near-identical lines. Kinds that already batch themselves at the emission
site (one record per cluster/branch/chunk -- e.g. NEAR_DUPLICATE_CONFLICT,
DROPPED_BLOCKS) are not listed in _GROUP_KEY_FIELD and pass through
unchanged."""
from __future__ import annotations

from collections.abc import Callable

from app.workitem.model import IntegrityWarning, WarningKind

# Maps a still-per-occurrence kind to the `detail` key that identifies "the
# same underlying event" -- occurrences sharing that key's value collapse
# into one summary record. None means group ALL occurrences of that kind
# together (there's no meaningful sub-key, e.g. every LOW_GROUNDING node in
# the tree is one flat bucket). A kind absent from this dict is not
# groupable at all and always passes through untouched.
_GROUP_KEY_FIELD: dict[WarningKind, str | None] = {
    WarningKind.REPARENTED_TO_FEATURE: "targetFeatureId",
    WarningKind.GROUP_REPARENTED: "targetParentId",
    WarningKind.ENHANCEMENT_CALL_FAILED: "pass",
    WarningKind.ENHANCEMENT_RESPONSE_INCOMPLETE: "pass",
    WarningKind.NO_MODEL_TITLE: None,
    WarningKind.INVALID_FIGURE_IDS: None,
    WarningKind.INVALID_TABLE_IDS: None,
    WarningKind.INVALID_NODE_TYPE: None,
    WarningKind.DANGLING_PARENT: None,
    WarningKind.LOW_GROUNDING: None,
    WarningKind.FRONT_MATTER_FOLDED: None,
    WarningKind.DROPPED_ROW: None,
}


_PASS_LABELS = {
    "title_tag": "title/tag",
    "parent_summary": "parent summary",
    "synthesis": "text synthesis",
}


def _pass_label(enhancement_pass: object) -> str:
    return _PASS_LABELS.get(str(enhancement_pass), str(enhancement_pass))


def _reparented_to_feature(members: list[IntegrityWarning], node_ids: list[str]) -> str:
    target = members[0].detail.get("targetFeatureTitle") or members[0].detail.get("targetFeatureId")
    return (
        f'{len(node_ids)} Requirement(s) were re-parented under Feature "{target}" to keep the '
        "Epic -> Feature -> Requirement chain intact."
    )


def _group_reparented(members: list[IntegrityWarning], node_ids: list[str]) -> str:
    target = members[0].detail.get("targetParentTitle") or members[0].detail.get("targetParentId")
    return (
        f'{len(node_ids)} item(s) matching a source table group were attached under the wrong '
        f'ancestor -- re-parented under "{target}" to match their known correct parent from the '
        "table's own ID hierarchy."
    )


def _enhancement_call_failed(members: list[IntegrityWarning], node_ids: list[str]) -> str:
    enhancement_pass = _pass_label(members[0].detail.get("pass"))
    return (
        f"The {enhancement_pass} enhancement call failed for {len(node_ids)} item(s) across "
        f"{len(members)} chunk(s) -- those kept their existing text."
    )


def _enhancement_response_incomplete(members: list[IntegrityWarning], node_ids: list[str]) -> str:
    enhancement_pass = _pass_label(members[0].detail.get("pass"))
    return (
        f"The {enhancement_pass} enhancement response omitted {len(node_ids)} item(s) across "
        f"{len(members)} chunk(s) -- those kept their existing text."
    )


def _no_model_title(members: list[IntegrityWarning], node_ids: list[str]) -> str:
    return f"{len(node_ids)} node(s) had no model title -- derived from description text."


def _invalid_figure_ids(members: list[IntegrityWarning], node_ids: list[str]) -> str:
    return (
        f"{len(node_ids)} node(s) named figure_ids that didn't match a real figure offered in "
        "their section -- the invalid ones were dropped."
    )


def _invalid_table_ids(members: list[IntegrityWarning], node_ids: list[str]) -> str:
    return (
        f"{len(node_ids)} node(s) named table_ids that didn't match a real table offered in "
        "their section -- the invalid ones were dropped."
    )


def _invalid_node_type(members: list[IntegrityWarning], node_ids: list[str]) -> str:
    return f"{len(node_ids)} node(s) had an invalid type from section analysis -- defaulted to Requirement."


def _dangling_parent(members: list[IntegrityWarning], node_ids: list[str]) -> str:
    return f"{len(node_ids)} node(s) referenced an unknown parent -- attached as their section's root."


def _low_grounding(members: list[IntegrityWarning], node_ids: list[str]) -> str:
    return (
        f"{len(node_ids)} node(s) have low grounding (their generated description shares little "
        "vocabulary with the source section) -- worth reviewing for possible fabrication."
    )


def _front_matter_folded(members: list[IntegrityWarning], node_ids: list[str]) -> str:
    count = len(members)
    return (
        f"{count} table(s)/block(s) preceded any heading/numbering in their branch -- folded "
        "into a synthetic front-matter node instead of being dropped."
    )


def _dropped_row(members: list[IntegrityWarning], node_ids: list[str]) -> str:
    count = len(members)
    return (
        f"{count} row(s) had no node-producing ancestor to fold into -- their content is not "
        "represented anywhere in the proposed tree."
    )


_SUMMARY_BUILDERS: dict[WarningKind, Callable[[list[IntegrityWarning], list[str]], str]] = {
    WarningKind.REPARENTED_TO_FEATURE: _reparented_to_feature,
    WarningKind.GROUP_REPARENTED: _group_reparented,
    WarningKind.ENHANCEMENT_CALL_FAILED: _enhancement_call_failed,
    WarningKind.ENHANCEMENT_RESPONSE_INCOMPLETE: _enhancement_response_incomplete,
    WarningKind.NO_MODEL_TITLE: _no_model_title,
    WarningKind.INVALID_FIGURE_IDS: _invalid_figure_ids,
    WarningKind.INVALID_TABLE_IDS: _invalid_table_ids,
    WarningKind.INVALID_NODE_TYPE: _invalid_node_type,
    WarningKind.DANGLING_PARENT: _dangling_parent,
    WarningKind.LOW_GROUNDING: _low_grounding,
    WarningKind.FRONT_MATTER_FOLDED: _front_matter_folded,
    WarningKind.DROPPED_ROW: _dropped_row,
}

# Sentinel distinct from a real `None` group-key-field value (which means
# "group ALL occurrences of this kind together") -- lets .get() tell "not in
# the dict at all" (never grouped) apart from "in the dict with value None".
_NOT_GROUPABLE = object()


def finalize_warnings(warnings: list[IntegrityWarning]) -> list[IntegrityWarning]:
    """Collapses occurrences of a still-per-occurrence kind (see
    _GROUP_KEY_FIELD) that share the same group key into one summary record,
    in place at the position of that group's FIRST occurrence -- preserves
    original ordering, and a group with exactly one member is returned
    byte-identical to how it was built at its emission site (no wording
    change for the common single-occurrence case). Kinds not in
    _GROUP_KEY_FIELD pass through untouched."""
    result: list[IntegrityWarning] = []
    first_index_by_key: dict[tuple, int] = {}
    members_by_key: dict[tuple, list[IntegrityWarning]] = {}

    for warning in warnings:
        key_field = _GROUP_KEY_FIELD.get(warning.kind, _NOT_GROUPABLE)
        if key_field is _NOT_GROUPABLE:
            result.append(warning)
            continue
        key = (warning.kind, warning.detail.get(key_field) if key_field else None)
        if key not in members_by_key:
            members_by_key[key] = [warning]
            first_index_by_key[key] = len(result)
            result.append(warning)
        else:
            members_by_key[key].append(warning)

    for key, index in first_index_by_key.items():
        members = members_by_key[key]
        if len(members) == 1:
            continue
        kind = key[0]
        node_ids = [node_id for member in members for node_id in member.node_ids]
        raw = _SUMMARY_BUILDERS[kind](members, node_ids)
        result[index] = IntegrityWarning.make(
            kind, raw, node_ids=node_ids, detail={**members[0].detail, "mergedCount": len(members)}
        )

    return result
