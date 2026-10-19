from __future__ import annotations

import random

import numpy as np

from app.canonical.model import SourceRef
from app.leveling.conservation import restore_lost_nodes
from app.leveling.root_regrouping import _regroup_disconnected_roots, deterministic_root_groups
from app.workitem.model import IntegrityWarning, WarningKind, WorkItemMode, WorkItemNode, WorkItemType


def _root(local_id: str, title: str, node_type: WorkItemType = WorkItemType.FEATURE) -> WorkItemNode:
    return WorkItemNode(
        local_id=local_id, type=node_type, parent_local_id=None, title=title, description=title,
        source_ref=SourceRef(document_path="d", start_offset=0, end_offset=1),
        fidelity_hash="f" + local_id, identity_hash="i" + local_id, tags=[], mode=WorkItemMode.SURVEY,
    )


def _topic_vectors(topics: list[int], dim: int = 8, noise: float = 0.01, seed: int = 1) -> list[list[float]]:
    """One tight cluster per topic number: a unit vector per topic plus a little noise."""
    rng = np.random.default_rng(seed)
    base = {t: np.eye(dim)[t] for t in set(topics)}
    return [list(base[t] + rng.normal(0, noise, dim)) for t in topics]


def test_similar_titles_form_groups_and_unrelated_ones_stay_alone() -> None:
    vectors = _topic_vectors([0, 0, 1, 1, 1, 2])
    assert deterministic_root_groups(vectors, 0.75) == [[0, 1], [2, 3, 4]]  # the lone topic-2 vector is no group


def test_groups_do_not_depend_on_anything_but_the_vectors() -> None:
    vectors = _topic_vectors([0, 1, 0, 2, 1, 2, 0, 1])
    first = deterministic_root_groups(vectors, 0.75)
    for _ in range(20):
        assert deterministic_root_groups([list(v) for v in vectors], 0.75) == first


def test_tiny_float_noise_does_not_change_the_groups() -> None:
    vectors = _topic_vectors([0, 0, 1, 1, 2, 2, 2])
    noisy = [[x + 1e-9 for x in v] for v in vectors]
    assert deterministic_root_groups(vectors, 0.75) == deterministic_root_groups(noisy, 0.75)


def test_threshold_boundaries_and_degenerate_inputs() -> None:
    vectors = _topic_vectors([0, 1, 2])
    assert deterministic_root_groups(vectors, 0.75) == []
    assert deterministic_root_groups(vectors, -1.0) == []  # unrelated vectors are never merged, whatever the threshold
    assert deterministic_root_groups([], 0.75) == []
    assert deterministic_root_groups([[1.0, 0.0]], 0.75) == []
    assert deterministic_root_groups([[0.0, 0.0], [0.0, 0.0]], 0.75) == []  # zero vectors are never "similar"


class _Embed:
    def __init__(self, vectors: dict[str, list[float]], fail: bool = False) -> None:
        self._vectors = vectors
        self._fail = fail
        self.calls = 0

    def embed(self, texts: list[str], user_id: str | None = None) -> list[list[float]]:
        self.calls += 1
        if self._fail:
            raise RuntimeError("embeddings down")
        return [self._vectors[t] for t in texts]


class _Namer:
    """A grouping client whose LLM methods must never be asked to group; it only names."""

    def __init__(self, names: dict[str, str] | Exception) -> None:
        self._names = names
        self.group_calls = 0
        self.assign_calls = 0

    def group_root_topics(self, titles_by_id, user_id=None):
        self.group_calls += 1
        raise AssertionError("the deterministic path must not ask the model to group")

    def assign_leftover_roots(self, a, b, user_id=None):
        self.assign_calls += 1
        raise AssertionError("the deterministic path must not run the leftover pass")

    def name_root_groups(self, titles_by_group_id, user_id=None):
        if isinstance(self._names, Exception):
            raise self._names
        return dict(self._names)


def _doc(titles_topics: list[tuple[str, int]]):
    titles = [t for t, _ in titles_topics]
    vecs = _topic_vectors([k for _, k in titles_topics])
    nodes = [_root(f"n{i}", t) for i, t in enumerate(titles)]
    return nodes, _Embed(dict(zip(titles, vecs)))


def _run(nodes, embed, namer, warnings=None):
    _regroup_disconnected_roots(
        nodes, "regroup_", namer, warnings if warnings is not None else [],
        embed_client=embed, deterministic=True, cosine_threshold=0.75,
    )


def test_deterministic_regrouping_builds_the_same_nodes_whichever_model_names_them() -> None:
    spec = [("A1", 0), ("A2", 0), ("B1", 1), ("B2", 1), ("B3", 1), ("C1", 2)]
    results = []
    for names in ({"regroup_synth_group_0": "Alpha", "regroup_synth_group_1": "Beta"}, {}, RuntimeError("model down")):
        nodes, embed = _doc(spec)
        _run(nodes, embed, _Namer(names))
        synth = sorted((n.local_id, n.type.value) for n in nodes if "synth_group" in n.local_id)
        parents = {n.local_id: n.parent_local_id for n in nodes if "synth_group" not in n.local_id}
        results.append((synth, parents))
    assert results[0] == results[1] == results[2]
    assert results[0][0] == [("regroup_synth_group_0", "Epic"), ("regroup_synth_group_1", "Epic")]  # Feature members -> an Epic above them
    assert results[0][1]["n5"] is None  # the lone root stays a root


def test_group_names_come_from_the_model_or_a_fallback_and_never_change_the_structure() -> None:
    spec = [("Bus Interfaces I2C", 0), ("Bus Interfaces SMBus", 0), ("Power A", 1), ("Power B", 1)]
    nodes, embed = _doc(spec)
    _run(nodes, embed, _Namer({"regroup_synth_group_0": "Bus Interfaces"}))
    titles = {n.local_id: n.title for n in nodes if "synth_group" in n.local_id}
    assert titles["regroup_synth_group_0"] == "Bus Interfaces"
    assert titles["regroup_synth_group_1"] == "Power A and related sections"


def test_embedding_failure_leaves_every_root_alone_and_never_calls_the_model_to_group() -> None:
    nodes = [_root("n0", "A"), _root("n1", "B")]
    namer = _Namer({})
    _run(nodes, _Embed({}, fail=True), namer)
    assert all(n.parent_local_id is None for n in nodes) and len(nodes) == 2
    assert namer.group_calls == 0


def test_without_an_embed_client_the_model_path_is_unchanged() -> None:
    class Llm:
        def group_root_topics(self, titles_by_id, user_id=None):
            return {"groups": [{"title": "G", "member_ids": ["n0", "n1"]}]}

    nodes = [_root("n0", "A"), _root("n1", "B")]
    _regroup_disconnected_roots(nodes, "regroup_", Llm(), [], deterministic=True, embed_client=None)
    assert any(n.title == "G" for n in nodes)


def test_77_titles_in_known_clusters_give_a_fixed_group_count() -> None:
    spec = [(f"T{k}-{i}", k) for k in range(7) for i in range(11)]
    counts = set()
    for seed in range(5):
        nodes = [_root(f"n{i}", t) for i, (t, _) in enumerate(spec)]
        vecs = _topic_vectors([k for _, k in spec], dim=8, noise=0.02, seed=seed)
        namer = _Namer({})
        _run(nodes, _Embed(dict(zip([t for t, _ in spec], vecs))), namer)
        counts.add(sum(1 for n in nodes if "synth_group" in n.local_id))
    assert counts == {7}


def test_a_node_lost_by_a_stage_is_restored_and_reported() -> None:
    kept, gone = _root("n0", "Kept"), _root("n1", "Gone")
    child = _root("n2", "Child")
    child.parent_local_id = "n1"
    expected = [kept, gone, child]
    nodes = [kept]
    warnings: list[IntegrityWarning] = []

    restored = restore_lost_nodes(expected, nodes, warnings, "regroup")

    assert restored == ["n1", "n2"] and {n.local_id for n in nodes} == {"n0", "n1", "n2"}
    assert [w.kind for w in warnings] == [WarningKind.ITEMS_LOST] and warnings[0].node_ids == ["n1", "n2"]
    assert child.parent_local_id == "n1"  # a parent that came back with it is kept
    assert restore_lost_nodes(expected, nodes, warnings, "again") == [] and len(warnings) == 1


def test_a_restored_node_whose_parent_is_gone_becomes_a_root() -> None:
    parent, orphan = _root("p", "P"), _root("o", "O")
    orphan.parent_local_id = "missing"
    nodes: list[WorkItemNode] = [parent]
    restore_lost_nodes([parent, orphan], nodes, [], "x")
    assert orphan.parent_local_id is None


def test_shuffling_the_input_order_of_ids_does_not_change_group_membership() -> None:
    spec = [(f"T{k}-{i}", k) for k in range(4) for i in range(5)]
    vecs = dict(zip([t for t, _ in spec], _topic_vectors([k for _, k in spec])))
    memberships = set()
    for seed in range(5):
        order = list(range(len(spec)))
        random.Random(seed).shuffle(order)
        nodes = [_root(f"n{i}", spec[i][0]) for i in sorted(order)]  # same ids and order each time
        _run(nodes, _Embed(vecs), _Namer({}))
        memberships.add(frozenset(frozenset(m.local_id for m in nodes if m.parent_local_id == g.local_id)
                                  for g in nodes if "synth_group" in g.local_id))
    assert len(memberships) == 1


def test_groups_are_built_from_the_source_headings_not_from_titles_the_model_rewrote() -> None:
    spec = [("A1", 0), ("A2", 0), ("B1", 1), ("B2", 1), ("C1", 2), ("C2", 2)]
    vecs = dict(zip([t for t, _ in spec], _topic_vectors([k for _, k in spec])))
    totals = set()
    shapes = set()
    for run in range(3):
        nodes = [_root(f"n{i}", f"Model title {run}-{i}") for i in range(len(spec))]
        for node, (source, _) in zip(nodes, spec):
            node.source_title = source  # what the document's heading said; the title above changes every run
        _run(nodes, _Embed(vecs), _Namer({}))
        totals.add(len(nodes))
        shapes.add(frozenset(frozenset(m.local_id for m in nodes if m.parent_local_id == g.local_id) for g in nodes if "synth_group" in g.local_id))
    assert len(totals) == 1 and len(shapes) == 1


def test_the_source_title_is_never_serialized_and_survives_a_copy() -> None:
    node = _root("a", "T")
    node.source_title = "Heading"
    assert "source_title" not in node.model_dump() and "source_title" not in node.model_dump_json()
    assert node.model_copy().source_title == "Heading"


# --- the cut adapts to the embedding scale (prod: at a fixed 0.75 only 8 of 77 short headings were grouped) ------------

def _clusters_with_similarity(topics: list[int], within: float, dim: int = 24, seed: int = 3) -> list[list[float]]:
    """Unit vectors where members of one topic have cosine similarity close to `within` and different topics are near 0."""
    rng = np.random.default_rng(seed)
    base = {t: np.eye(dim)[t] for t in set(topics)}
    shared = (1 - within) ** 0.5
    vectors = []
    for t in topics:
        noise = rng.normal(0, 1, dim)
        noise -= noise @ base[t] * base[t]
        noise /= np.linalg.norm(noise)
        vectors.append(list(within ** 0.5 * base[t] + shared * noise))
    return vectors


def test_the_same_clusters_are_found_whether_related_headings_embed_close_together_or_loosely() -> None:
    topics = [0, 0, 0, 1, 1, 1, 2, 2, 3, 4, 5, 6, 6, 6, 6]
    tight = deterministic_root_groups(_clusters_with_similarity(topics, 0.9), 0.75)
    loose = deterministic_root_groups(_clusters_with_similarity(topics, 0.58), 0.75)
    assert tight == loose
    assert [len(g) for g in loose] == [3, 3, 2, 4]  # topics 0, 1, 2 and 6; the single-heading topics stay alone


def test_without_a_clear_gap_the_fixed_threshold_decides() -> None:
    rng = np.random.default_rng(5)
    vectors = [list(v) for v in rng.normal(0, 1, (12, 256))]  # unrelated headings in a real-sized space: similarities near 0
    assert deterministic_root_groups(vectors, 0.75) == []


def test_a_group_never_grows_past_the_size_cap() -> None:
    vectors = _clusters_with_similarity([0] * 30, 0.95)
    groups = deterministic_root_groups(vectors, 0.75, max_group_size=8)
    assert groups and max(len(g) for g in groups) <= 8
    assert sorted(i for g in groups for i in g) == sorted(set(i for g in groups for i in g))  # no root in two groups
