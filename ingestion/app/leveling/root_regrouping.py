from __future__ import annotations

import hashlib
import logging
from typing import Protocol

from app.leveling.narration_publisher import LevelingProgress, ProgressCallback
from app.leveling.tree_builder import _hash_identity_for_synthesized_node
from app.workitem.model import IntegrityWarning, WarningKind, WorkItemMode, WorkItemNode, WorkItemType

logger = logging.getLogger(__name__)


class RootGroupingClient(Protocol):
    """Interface for topical root regrouping (see
    _regroup_disconnected_roots's own docstring for the real gap this
    closes -- a document with no single top heading produces many
    disconnected root nodes, unlike both external reference outputs this
    session's investigation compared against, which each synthesized one
    coherent hierarchy). Entirely optional (default None, same opt-in
    convention as every other client here) -- when omitted, disconnected
    roots are simply left as-is, matching pre-existing behavior exactly."""

    def group_root_topics(self, titles_by_id: dict[str, str]) -> dict: ...


def _regroup_disconnected_roots(
    nodes: list[WorkItemNode],
    node_id_prefix: str,
    grouping_client: RootGroupingClient | None,
    warnings: list[IntegrityWarning],
    progress_callback: ProgressCallback | None = None,
    blocks_total: int = 0,
    branch_count: int = 0,
) -> None:
    """Real gap closed here, confirmed against a real document (AirPro):
    77 disconnected root nodes, because the document's own Word outline
    has no single top heading -- root titles like "PS_SYSRESET", "PS_SYNC",
    "NVMRO" confirm many are semantically far below top-tier, just flat
    peers in the outline. Both external reference outputs compared against
    in this session's investigation synthesized ONE coherent hierarchy by
    regrouping these by topic (e.g. the gold-standard output's "VPX
    Utility & Management Signals" Feature absorbing 14 of our separate
    root Features) -- this deterministic path structurally cannot do that
    on its own (`id_tree_builder.py`'s own "never invent a node with no
    real source row backing it" policy, the reason an earlier full
    Epic-synthesis mechanism was reverted).

    This is the one exception to that policy, deliberately narrow: a
    synthesized grouping node here carries NO requirement text of its own
    (its description says so explicitly), contributes no fidelity_hash,
    and is excluded from Epic/Feature scoring the same way a bridge
    Feature already is (see _score_epics_and_features's own exclusion
    check) -- it invents STRUCTURE only, never content. Every real leaf
    still traces to a real source heading; only its ANCESTRY changes.

    Sends the LLM only the disconnected roots' own short TITLES (never
    full content) and asks for a topical grouping into a handful of
    Features/Epics. A root not mentioned in any returned group's
    member_ids is left exactly as it was -- a genuinely standalone root
    (e.g. a document's one real top-level domain) is not forced into an
    arbitrary group. Fail-open: any exception, or a response naming a
    root id that doesn't exist, degrades to leaving every root untouched,
    never fails the job."""
    if grouping_client is None:
        return
    roots = [n for n in nodes if n.parent_local_id is None]
    if len(roots) < 2:
        return
    titles_by_id = {n.local_id: n.title for n in roots}
    if progress_callback is not None:
        progress_callback(
            LevelingProgress(
                phase="regroup_roots", branch_index=None, branch_count=branch_count,
                blocks_done=blocks_total, blocks_total=blocks_total,
                kb_grounded=False, kb_citations=[],
            )
        )
    try:
        result = grouping_client.group_root_topics(titles_by_id)
    except Exception as exc:
        logger.warning("Root topical regrouping failed, leaving disconnected roots as-is: %s", exc)
        return
    if not isinstance(result, dict):
        return
    raw_groups = result.get("groups")
    if not isinstance(raw_groups, list):
        return

    root_ids = set(titles_by_id)
    by_id = {n.local_id: n for n in nodes}
    already_grouped: set[str] = set()
    for group_index, raw_group in enumerate(raw_groups):
        if not isinstance(raw_group, dict):
            continue
        group_title = raw_group.get("title")
        member_ids = raw_group.get("member_ids")
        has_valid_title = isinstance(group_title, str) and group_title.strip()
        if not has_valid_title or not isinstance(member_ids, list):
            continue
        # Only real, still-ungrouped root ids count -- an invented id or
        # one already claimed by an earlier group in this same response is
        # dropped rather than trusted, same "never invent, never
        # double-count" discipline as trace-link resolution.
        valid_member_ids = [
            member_id for member_id in member_ids
            if member_id in root_ids and member_id not in already_grouped
        ]
        if len(valid_member_ids) < 2:
            continue
        members = [by_id[member_id] for member_id in valid_member_ids]
        # CMMI validity: same depth-based rule id_hierarchy.classify() uses
        # everywhere else in this codebase -- a group of Features sits one
        # Epic tier above them; only a group of all-Requirement leaves
        # stays a Feature.
        group_type = (
            WorkItemType.FEATURE
            if all(m.type == WorkItemType.REQUIREMENT for m in members)
            else WorkItemType.EPIC
        )
        synth_id = f"{node_id_prefix}synth_group_{group_index}"
        member_titles = ", ".join(m.title for m in members)
        group_node = WorkItemNode(
            local_id=synth_id,
            type=group_type,
            parent_local_id=None,
            title=group_title.strip()[:256],
            description=(
                f"Auto-inserted topical grouping -- the following originally-disconnected root "
                f"sections were grouped by topic: {member_titles}"
            ),
            source_ref=members[0].source_ref,
            fidelity_hash=hashlib.sha256(synth_id.encode()).hexdigest(),
            identity_hash=_hash_identity_for_synthesized_node(synth_id, members[0].source_ref),
            tags=[],
            mode=WorkItemMode.SURVEY,
            grounding_score=1.0,
        )
        nodes.append(group_node)
        for member in members:
            member.parent_local_id = synth_id
            already_grouped.add(member.local_id)
        message = (
            f"Grouped {len(members)} previously-disconnected root section(s) under a new topical "
            f"'{group_node.title}' {group_type.value} -- structure only, no content invented."
        )
        logger.warning(message)
        warnings.append(
            IntegrityWarning.make(
                WarningKind.ROOTS_REGROUPED,
                message,
                node_ids=[synth_id, *(m.local_id for m in members)],
                detail={"groupId": synth_id, "groupTitle": group_node.title, "memberIds": [m.local_id for m in members]},
            )
        )


def _ensure_root_features_have_epic_parent(
    nodes: list[WorkItemNode], node_id_prefix: str, warnings: list[IntegrityWarning]
) -> None:
    """Confirmed real gap (user-reported, live review): after
    _regroup_disconnected_roots runs, a root that either wasn't offered to
    any topical group, or was the sole member of a would-be group (groups
    need >= 2 members to matter), can be left as a standalone root
    FEATURE with no Epic above it at all -- a real, if less severe,
    cousin of the Requirement-directly-under-Epic violation
    `_repair_requirement_hierarchy` already fixes. A CMMI reader expects
    every Feature to trace up to SOME Epic; a bare Feature root breaks
    that expectation even though it isn't a strict parent/child TYPE
    violation the way an Epic-under-Feature would be.

    Only fires when the tree has at least one REAL Epic somewhere -- a
    document whose entire tree is uniformly Feature-topped (no Epic tier
    at all) is a legitimate, already-tested shape (e.g. a small document
    with nothing above Feature level) and must be left alone; the actual
    defect this fixes is a MIXED bag of Epic-typed and bare Feature-typed
    roots sitting as inconsistent siblings. Otherwise runs
    unconditionally (no client/threshold needed, unlike topical
    regrouping) -- this is a structural completeness pass, not a
    judgment call: every remaining root-level Feature (any count >= 1)
    is wrapped under ONE new catch-all root Epic, structure only, same
    "never invent content" discipline as every other synthetic node in
    this module (excluded from scoring via the shared "synth_" local_id
    marker, see _score_epics_and_features's own exclusion check)."""
    if not any(n.type == WorkItemType.EPIC for n in nodes):
        return
    orphan_features = [
        n for n in nodes if n.parent_local_id is None and n.type == WorkItemType.FEATURE
    ]
    if not orphan_features:
        return
    synth_id = f"{node_id_prefix}synth_root_epic"
    epic_node = WorkItemNode(
        local_id=synth_id,
        type=WorkItemType.EPIC,
        parent_local_id=None,
        title="(auto-grouped) Other Sections",
        description=(
            "Auto-inserted catch-all Epic -- the following root Feature(s) had no Epic ancestor "
            "of their own: " + ", ".join(n.title for n in orphan_features)
        ),
        source_ref=orphan_features[0].source_ref,
        fidelity_hash=hashlib.sha256(synth_id.encode()).hexdigest(),
        identity_hash=_hash_identity_for_synthesized_node(synth_id, orphan_features[0].source_ref),
        tags=[],
        mode=WorkItemMode.SURVEY,
        grounding_score=1.0,
    )
    nodes.append(epic_node)
    for feature in orphan_features:
        feature.parent_local_id = synth_id
    message = (
        f"{len(orphan_features)} root Feature(s) had no Epic ancestor of their own -- wrapped "
        "under a new catch-all root Epic to keep every Feature traceable to an Epic, structure "
        "only, no content invented."
    )
    logger.warning(message)
    warnings.append(
        IntegrityWarning.make(
            WarningKind.CATCHALL_EPIC_WRAP,
            message,
            node_ids=[synth_id, *(f.local_id for f in orphan_features)],
            detail={"epicId": synth_id, "featureIds": [f.local_id for f in orphan_features]},
        )
    )


def _repair_requirement_hierarchy(
    nodes: list[WorkItemNode], node_id_prefix: str, warnings: list[IntegrityWarning]
) -> None:
    """Confirmed real bug (user-reported): the model occasionally ignores
    the Epic->Feature->Requirement chain the prompt now explicitly states
    (see _SECTION_ANALYSIS_SYSTEM_PROMPT's hierarchy paragraph) -- emitting
    a Requirement directly under an Epic, or with no parent at all even
    though Epic/Feature nodes exist elsewhere in the same branch. A prompt
    instruction alone is a soft LLM signal with no backstop (confirmed:
    this codebase's own tests already had fixtures asserting two
    sibling-root Requirements as unremarkable output before this fix). This
    runs once per branch, after every node already exists, mutating
    `nodes` in place.

    A Requirement parented under ANOTHER Requirement is deliberately NOT a
    violation (confirmed real gap, live-tested against a reference CMMI
    structure: exceptions/conditions/follow-up behavior of a general parent
    Requirement -- e.g. "Automatic Switching to an Active Source" with
    child Requirements "Multiple Active Sources"/"User Dismisses the
    Suggestion" -- are legitimately child Requirements, not siblings under
    the same Feature). Only a Requirement parented directly under an Epic
    (or with no parent when one is genuinely required) still gets repaired
    here; the walk-up-to-nearest-Feature logic below already handles
    arbitrarily long Requirement->Requirement->...->Feature chains
    correctly, so widening the valid-parent check needed no other change.

    For each Requirement whose resolved parent isn't a Feature: walks UP
    the existing parent chain looking for the nearest real Feature
    ancestor (handles a Requirement->Requirement->...->Feature chain
    correctly, not just a single bad hop) and re-parents there.

    If no Feature is found on that chain but an Epic ancestor IS found
    (the offending Requirement sits directly under some Epic), the target
    becomes: an EXISTING real Feature that is already a direct child of
    that SAME Epic, if one exists; otherwise a bridge Feature synthesized
    under that SAME Epic (created lazily, at most once per Epic). This
    keeps the repair local to the section the Requirement actually came
    from, never reaching into an unrelated part of the document.

    Only when NO Epic ancestor exists on the chain at all (a genuinely
    rootless Requirement with no Epic anywhere above it) does this fall
    back to the branch's first real Feature (if the branch has one at
    all), and only as an absolute last resort -- no Feature or Epic
    anywhere in the branch -- synthesizes ONE branch-level grouping
    Feature (also created lazily, at most once).

    Confirmed real bug this replaced: an earlier version fell back to "the
    branch's first Feature" UNCONDITIONALLY whenever a Requirement's own
    chain had no Feature ancestor -- document-global on the deterministic
    path, where the whole document is one branch. Live-tested against a
    real job: 114 Requirements about e-fuses, GPUs, BP_MEZ and power
    monitoring -- with no relationship to each other -- all got dumped onto
    ONE unrelated Feature under an unrelated Epic ("BP SOSA Compliancy"),
    which ended up with 116 children. Preferring the nearest EPIC
    ancestor's own Feature (real or bridged) before ever reaching for the
    branch-global fallback keeps every repair local to the section it
    actually came from, while still preserving the branch-global fallback
    for the genuinely-rootless case existing tests already cover (a small,
    legitimately single-section branch where "the branch's one Feature" IS
    the correct local answer)."""
    by_id = {node.local_id: node for node in nodes}
    # Keyed by the nearest Epic ancestor's local_id (None key = the
    # branch-level last resort, no Epic ancestor found at all) -- see this
    # function's own docstring for why a single shared bridge (the old
    # behavior) is wrong.
    bridge_features_by_epic_id: dict[str | None, WorkItemNode] = {}
    # Precomputed once, not per violating Requirement -- the null-parent
    # branch below previously ran two full `any(...)` scans over `nodes`
    # PER violation, making a from-scratch-heavy branch O(n^2). Only bites
    # at very large branch sizes (frontier-model branch caps,
    # _ModelCaps.branch_cap=100_000) -- at today's typical branch sizes
    # this was invisible, but cheap to fix regardless.
    root_count = sum(1 for n in nodes if n.parent_local_id is None)
    has_epic_or_feature = any(n.type in (WorkItemType.EPIC, WorkItemType.FEATURE) for n in nodes)
    # Only ever used when a violating Requirement has NO Epic ancestor at
    # all (see docstring) -- for the common case (an Epic ancestor exists),
    # `feature_by_epic_parent_id` below is checked first and is always
    # local to that Epic, never document-global.
    first_feature = next((n for n in nodes if n.type == WorkItemType.FEATURE), None)
    # First EXISTING real Feature child per Epic, computed once from the
    # tree as originally built (not updated as bridge Features get
    # synthesized below -- a just-synthesized bridge is already cached in
    # `bridge_features_by_epic_id` and found there instead, so the two
    # caches compose correctly without this one needing to change).
    feature_by_epic_parent_id: dict[str, WorkItemNode] = {}
    for n in nodes:
        if n.type == WorkItemType.FEATURE and n.parent_local_id is not None:
            feature_by_epic_parent_id.setdefault(n.parent_local_id, n)

    def ensure_bridge_feature(requirement: WorkItemNode, epic: WorkItemNode | None) -> WorkItemNode:
        nonlocal has_epic_or_feature
        epic_key = epic.local_id if epic is not None else None
        existing = bridge_features_by_epic_id.get(epic_key)
        if existing is not None:
            return existing
        synth_id = (
            f"{node_id_prefix}synth_feature" if epic is None
            else f"{node_id_prefix}synth_feature_{epic.local_id}"
        )
        feature = WorkItemNode(
            local_id=synth_id,
            type=WorkItemType.FEATURE,
            parent_local_id=epic.local_id if epic is not None else None,
            title=f"(auto-grouped) {requirement.title[:60]}",
            description=(
                "Auto-inserted grouping Feature -- the model emitted one or more "
                "Requirements in this section without a Feature parent."
            ),
            customer_id=requirement.customer_id,
            source_ref=requirement.source_ref,
            fidelity_hash=hashlib.sha256(synth_id.encode()).hexdigest(),
            identity_hash=_hash_identity_for_synthesized_node(synth_id, requirement.source_ref),
            tags=[],
            mode=WorkItemMode.SURVEY,
            grounding_score=1.0,
        )
        nodes.append(feature)
        by_id[feature.local_id] = feature
        # Human-readable anchor for WHERE this happened: the requirement that
        # triggered it, quoted by title -- never the internal local_id
        # (confirmed real gap, user-reported: "det0_h9_3"/"det0_h3_1_1"-style
        # ids mean nothing to a reviewer who never sees ingestion's internal
        # node numbering anywhere else in the product).
        location = f'under Epic "{epic.title}"' if epic is not None else "at the top level of this section"
        message = (
            f'Requirement(s) near "{requirement.title}" had no Feature ancestor -- inserted a '
            f"grouping Feature {location} to keep the Epic -> Feature -> Requirement chain intact."
        )
        logger.warning(message)
        warnings.append(
            IntegrityWarning.make(
                WarningKind.BRIDGE_FEATURE_SYNTHESIZED,
                message,
                node_ids=[synth_id],
                detail={"featureId": synth_id, "epicId": epic_key},
            )
        )
        bridge_features_by_epic_id[epic_key] = feature
        # The synthesized Feature makes has_epic_or_feature true from this
        # point on (it can only ever become MORE true, never less, as nodes
        # are added) -- must be updated in place so a LATER root Requirement
        # correctly sees this bridge as a real Feature ancestor requiring
        # repair, not a stale "no Feature anywhere" snapshot.
        has_epic_or_feature = True
        return feature

    for node in list(nodes):
        if node.type != WorkItemType.REQUIREMENT:
            continue
        parent = by_id.get(node.parent_local_id) if node.parent_local_id else None
        if parent is None:
            # A null parent is only a violation if this Requirement ISN'T
            # genuinely the section's sole root -- i.e. some other node
            # already owns that slot, or an Epic/Feature exists elsewhere
            # in this branch that should have been its real ancestor.
            # root_count was computed once, before this loop -- node itself
            # is only counted in it when node.parent_local_id is None (the
            # dangling-parent-id case below reaches here with a non-None
            # parent_local_id that just failed to resolve, so node is NOT
            # one of the counted roots in that case).
            other_root_exists = (root_count > 1) if node.parent_local_id is None else (root_count > 0)
            violates = other_root_exists or has_epic_or_feature
        else:
            # A Requirement parent is valid too (a child Requirement --
            # exceptions/conditions/follow-up behavior of a general parent
            # Requirement, per the CMMI reference structure this repair
            # pass now supports) -- only an Epic-direct or another invalid
            # type still requires repair.
            violates = parent.type not in (WorkItemType.FEATURE, WorkItemType.REQUIREMENT)
        if not violates:
            continue

        original_parent_label = "no parent" if parent is None else f"a {parent.type.value} parent"
        # Walk up the (possibly Requirement-chained) parent links looking
        # for the nearest real Feature ancestor before giving up -- also
        # tracks the nearest EPIC ancestor seen along the SAME walk (the
        # first one encountered, i.e. the closest), so a bridge Feature can
        # be planted locally under it instead of reaching elsewhere in the
        # document (see this function's own docstring for the bug this
        # fixes).
        ancestor_id = node.parent_local_id
        seen_ids: set[str] = set()
        nearest_feature: WorkItemNode | None = None
        nearest_epic: WorkItemNode | None = None
        while ancestor_id and ancestor_id not in seen_ids:
            seen_ids.add(ancestor_id)
            ancestor = by_id.get(ancestor_id)
            if ancestor is None:
                break
            if ancestor.type == WorkItemType.FEATURE:
                nearest_feature = ancestor
                break
            if ancestor.type == WorkItemType.EPIC and nearest_epic is None:
                nearest_epic = ancestor
            ancestor_id = ancestor.parent_local_id
        if nearest_feature is not None:
            target = nearest_feature
        elif nearest_epic is not None:
            # An Epic ancestor exists -- stay local to it: reuse its own
            # existing Feature child if it has one, else bridge under it.
            # Never falls through to the branch-global first_feature from
            # here (see this function's own docstring for the bug that
            # caused).
            target = feature_by_epic_parent_id.get(nearest_epic.local_id) or ensure_bridge_feature(node, nearest_epic)
        else:
            # No Epic ancestor anywhere on this Requirement's own chain --
            # the branch-global fallback is only reachable in this genuinely
            # rootless case.
            target = first_feature or ensure_bridge_feature(node, None)
        if target.local_id == node.local_id or node.parent_local_id == target.local_id:
            continue
        message = (
            f'"{node.title}" had {original_parent_label} -- re-parented under Feature '
            f'"{target.title}" to keep the Epic -> Feature -> Requirement chain intact.'
        )
        logger.warning(message)
        warnings.append(
            IntegrityWarning.make(
                WarningKind.REPARENTED_TO_FEATURE,
                message,
                node_ids=[node.local_id],
                detail={
                    "targetFeatureId": target.local_id,
                    "targetFeatureTitle": target.title,
                    "originalParent": original_parent_label,
                },
            )
        )
        node.parent_local_id = target.local_id
