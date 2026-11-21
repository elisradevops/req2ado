"""Within-job conflict detection, per pair: code settles what it can read, the model judges only what needs language."""

from app.leveling.conflict_detection import _detect_conflicting_duplicates
from app.workitem.model import (
    IntegrityWarning,
    RequirementQualityIssue,
    SourceRef,
    WarningKind,
    WorkItemMode,
    WorkItemNode,
    WorkItemType,
)


def _req(local_id: str, text: str) -> WorkItemNode:
    return WorkItemNode(
        local_id=local_id,
        type=WorkItemType.REQUIREMENT,
        parent_local_id=None,
        title=text[:60],
        description=text,
        source_ref=SourceRef(document_path="x.docx", start_offset=0, end_offset=1),
        mode=WorkItemMode.SURVEY,
    )


class _Embed:
    def __init__(self, vectors: dict[str, list[float]]) -> None:
        self._vectors = vectors

    def embed(self, texts: list[str], user_id: str | None = None) -> list[list[float]]:
        return [self._vectors[t] for t in texts]


class _Judge:
    def __init__(self, same: str, agree: str = "yes") -> None:
        self._answer = {"same_parameter": same, "values_agree": agree}
        self.calls: list[dict[str, dict[str, str]]] = []

    def judge_parameter_pairs(
        self, pairs_by_id: dict[str, dict[str, str]], user_id: str | None = None
    ) -> dict[str, dict]:
        self.calls.append(pairs_by_id)
        return {pair_id: dict(self._answer) for pair_id in pairs_by_id}


def _run(texts: list[str], judge: _Judge, vectors: list[list[float]] | None = None):
    nodes = [_req(f"n{i}", t) for i, t in enumerate(texts)]
    vectors = vectors or [[1.0, 0.001 * i] for i in range(len(texts))]
    by_text = {t: v for t, v in zip(texts, vectors)} | {t[:60]: v for t, v in zip(texts, vectors)}
    warnings: list[IntegrityWarning] = []
    _detect_conflicting_duplicates(nodes, _Embed(by_text), judge, warnings)
    return nodes, warnings


def test_values_that_agree_after_unit_normalisation_are_never_asked() -> None:
    judge = _Judge("yes", "no")
    nodes, warnings = _run(["Respond within 500 ms.", "Respond within 0.5 s."], judge)
    assert judge.calls == [] and warnings == []
    assert all(n.quality_issues == [] for n in nodes)


def test_differing_values_of_different_parameters_are_no_conflict() -> None:
    judge = _Judge("no")
    nodes, warnings = _run(
        ["The 5 V rail shall supply 2 A.", "The 12 V rail shall supply 4 A."], judge
    )
    assert len(judge.calls) == 1 and warnings == []
    assert all(n.quality_issues == [] for n in nodes)


def test_an_uncertain_same_parameter_asks_the_reviewer_and_tags_nothing() -> None:
    nodes, warnings = _run(
        ["Efficiency shall be at least 85%.", "Efficiency shall be at least 93%."],
        _Judge("uncertain"),
    )
    assert [(w.kind, w.detail) for w in warnings] == [
        (WarningKind.CONFLICT_JUDGMENT_SKIPPED, {"reason": "uncertain"})
    ]
    assert "compare them manually" in warnings[0].raw and warnings[0].node_ids == ["n0", "n1"]
    assert all(n.quality_issues == [] for n in nodes)


def test_where_code_cannot_compare_the_values_the_model_decides_them() -> None:
    texts = ["The enclosure shall be painted green.", "The enclosure shall be painted black."]
    nodes, warnings = _run(texts, _Judge("yes", "no"))
    assert [w.kind for w in warnings] == [WarningKind.NEAR_DUPLICATE_CONFLICT]
    assert warnings[0].detail == {"conflictingValues": []} and "()" not in warnings[0].raw
    assert all(RequirementQualityIssue.CONFLICTING_VALUE in n.quality_issues for n in nodes)

    nodes, warnings = _run(texts, _Judge("yes", "yes"))
    assert warnings == []
    nodes, warnings = _run(texts, _Judge("yes", "uncertain"))
    assert [w.detail for w in warnings] == [{"reason": "uncertain"}]


def test_values_agree_is_never_read_where_code_compared_the_values() -> None:
    # The model says the values agree; code read 85% against 93%, so the pair is a conflict.
    nodes, warnings = _run(
        ["Efficiency shall be at least 85%.", "Efficiency shall be at least 93%."],
        _Judge("yes", "yes"),
    )
    assert [w.detail for w in warnings] == [{"conflictingValues": ["85%", "93%"]}]


def test_only_the_similar_pairs_of_a_cluster_are_asked() -> None:
    # a ~ b and b ~ c cluster all three, but a and c are not alike: two pairs, not three.
    judge = _Judge("no")
    _run(
        ["Mode A shall be red.", "Mode B shall be red too.", "Mode C shall be blue."],
        judge,
        vectors=[[1.0, 0.0], [0.92, 0.392], [0.7, 0.714]],
    )
    assert [len(call) for call in judge.calls] == [2]
    assert {(p["a"][:6], p["b"][:6]) for p in judge.calls[0].values()} == {
        ("Mode A", "Mode B"),
        ("Mode B", "Mode C"),
    }


def test_a_hebrew_pair_is_compared_by_value() -> None:
    texts = ["מתח הכניסה של היחידה יהיה 28 וולט.", "היחידה תפעל במתח כניסה של 24 וולט."]
    nodes, warnings = _run(texts, _Judge("yes"))
    assert [w.detail for w in warnings] == [{"conflictingValues": ["28 וולט", "24 וולט"]}]
