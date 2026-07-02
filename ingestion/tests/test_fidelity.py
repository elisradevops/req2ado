from app.canonical.model import SourceRef
from app.workitem.fidelity import verify_fidelity
from app.workitem.model import WorkItemMode, WorkItemNode, WorkItemType


def _sr() -> SourceRef:
    return SourceRef(document_path="x.txt", start_offset=0, end_offset=10)


def _node(description: str, fidelity_hash: str | None) -> WorkItemNode:
    return WorkItemNode(
        local_id="n0",
        type=WorkItemType.REQUIREMENT,
        parent_local_id=None,
        title="Title",
        description=description,
        customer_id=None,
        source_ref=_sr(),
        fidelity_hash=fidelity_hash,
        tags=[],
        mode=WorkItemMode.BASELINE,
    )


def test_verify_fidelity_true_when_hash_matches_description() -> None:
    import hashlib

    description = "The receiver shall scan all channels."
    node = _node(description, hashlib.sha256(description.encode()).hexdigest())
    assert verify_fidelity(node) is True


def test_verify_fidelity_detects_drift_when_description_was_mutated_after_hashing() -> None:
    import hashlib

    original = "The receiver shall scan all channels."
    stale_hash = hashlib.sha256(original.encode()).hexdigest()
    mutated_node = _node("The receiver shall scan all channels quickly.", stale_hash)
    assert verify_fidelity(mutated_node) is False


def test_verify_fidelity_false_when_fidelity_hash_is_none() -> None:
    # SURVEY-mode nodes have fidelity_hash=None (no BASELINE guarantee to
    # verify) — verify_fidelity must not raise, and must report False rather
    # than silently treating "no hash" as "verified."
    node = _node("some text", None)
    assert verify_fidelity(node) is False


def test_verify_fidelity_is_deterministic_across_repeated_calls() -> None:
    import hashlib

    description = "OPEN: confirm connector part number.\n[FIGURE: none]"
    node = _node(description, hashlib.sha256(description.encode()).hexdigest())
    assert verify_fidelity(node) is True
    assert verify_fidelity(node) is True
