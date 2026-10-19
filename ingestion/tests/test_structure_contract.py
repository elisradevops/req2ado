"""One contract for every input format: the items of a SURVEY tree are fixed by the document's structure, never by the chat
model.

The same rules run over a registry of real fixture files, one per format, loaded through the app's own loaders. For each
file, with the structure taken from the document (`structure_mode="baseline"`):
  * the model that writes wording is never asked how many items exist (the analysis client refuses every structure call);
  * the item count is the same for three simulated models and for repeated runs;
  * every block, table and figure of the document is a node or folded into one (nothing silently lost);
  * the nodes are exactly the BASELINE nodes of the same file (plus the deterministic grouping nodes), so BASELINE and
    SURVEY agree on what the items are."""
from __future__ import annotations

import random
import shutil
from pathlib import Path

import pytest

from app.dispatch import dispatch_by_extension
from app.leveling.llm_leveling import build_survey_tree
from app.leveling.tree_builder import build_baseline_tree

FIXTURES = Path(__file__).parent / "fixtures"
HAS_OCR = shutil.which("tesseract") is not None and shutil.which("pdftoppm") is not None

# One row per format. Adding a format means adding a row.
REGISTRY: list[tuple[str, str]] = [
    ("docx prose", "sample.docx"),
    ("docx ICD with headings", "mock_icd.docx"),
    ("docx flat", "mock_flat.docx"),
    ("docx PRD with tables", "mock_prd_flat.docx"),
    ("docx PRD sensor", "mock_prd_sensor.docx"),
    ("docx remote", "mock_tv_remote.docx"),
    ("pdf text", "sample.pdf"),
    ("txt", "sample.txt"),
    ("markdown", "sample.md"),
    ("pptx", "sample.pptx"),
    ("xlsx", "sample.xlsx"),
    ("csv", "sample.csv"),
    ("rtf", "sample.rtf"),
    ("image", "sample.png"),
    ("pdf scanned", "scanned_sample.pdf"),
    ("pdf scanned hebrew", "hebrew_scanned_sample.pdf"),
]


class StructureRefusingClient:
    """The model client that writes wording. Every structural call is a failure of the contract."""

    model = "simulated"

    def _refuse(self, *args, **kwargs):
        raise AssertionError("the model must not be asked to decide the structure")

    analyze_section = analyze_section_agentic = analyze_section_skeleton = author_content = _refuse
    analyze_section_skeleton_agentic = _refuse

    def __getattr__(self, name: str):
        if name.startswith(("analyze_", "author_", "map_")):
            return self._refuse
        raise AttributeError(name)


class SimulatedGrouper:
    """A model that groups and names root sections differently on every run (seeded), like prod did."""

    def __init__(self, seed: int) -> None:
        self._random = random.Random(seed)

    def group_root_topics(self, titles_by_id, user_id=None):
        ids = list(titles_by_id)
        self._random.shuffle(ids)
        return {"groups": [{"title": f"Group {self._random.random()}", "member_ids": ids[: self._random.randint(2, max(2, len(ids)))]}]}

    def assign_leftover_roots(self, leftovers, groups, user_id=None):
        return {"assignments": {}}

    def name_root_groups(self, titles_by_group_id, user_id=None):
        return {key: f"Name {self._random.random()}" for key in titles_by_group_id}


def _load(filename: str):
    path = FIXTURES / filename
    if filename.endswith(".pdf") and "scanned" in filename and not HAS_OCR:
        pytest.skip("OCR tools are not installed")
    return dispatch_by_extension(filename, str(path), languages="eng+heb" if "hebrew" in filename else "eng")


class TitleHashEmbedder:
    """A fake embedder: the same text always gets the same vector, different texts get unrelated ones."""

    def embed(self, texts, user_id=None):
        import hashlib

        import numpy as np

        vectors = []
        for text in texts:
            seed = int.from_bytes(hashlib.sha256(text.encode()).digest()[:4], "big")
            vectors.append(list(np.random.default_rng(seed).normal(0, 1, 64)))
        return vectors


def _survey(doc, seed: int, mode: str = "baseline"):
    return build_survey_tree(
        doc, StructureRefusingClient(), grouping_client=SimulatedGrouper(seed), embed_client=TitleHashEmbedder(),
        structure_mode=mode, root_regroup_mode="deterministic",
    )


@pytest.mark.parametrize("label,filename", REGISTRY, ids=[label for label, _ in REGISTRY])
def test_the_item_count_is_the_same_for_every_model_and_every_run(label: str, filename: str) -> None:
    doc = _load(filename)
    counts = {len(_survey(doc, seed).nodes) for seed in (1, 2, 3, 4)}
    assert len(counts) == 1, f"{label}: counts differ between simulated models/runs: {sorted(counts)}"


@pytest.mark.parametrize("label,filename", REGISTRY, ids=[label for label, _ in REGISTRY])
def test_the_items_are_the_baseline_items_of_the_same_file(label: str, filename: str) -> None:
    doc = _load(filename)
    baseline = build_baseline_tree(doc)
    survey = _survey(doc, 1)
    baseline_titles = sorted(n.title for n in baseline.nodes)
    survey_titles = sorted(n.title for n in survey.nodes if not n.local_id.startswith(("regroup_", "synth_")))
    assert survey_titles == baseline_titles, label
    assert not any(w.kind.value == "items_lost" for w in survey.warnings)


@pytest.mark.parametrize("label,filename", REGISTRY, ids=[label for label, _ in REGISTRY])
def test_nothing_in_the_document_is_dropped(label: str, filename: str) -> None:
    doc = _load(filename)
    survey = _survey(doc, 1)
    assert survey.nodes, f"{label}: a document with content must produce items"
    assert not [w for w in survey.warnings if w.kind.value in ("dropped_blocks", "missing_table_group_coverage")]
    text = " ".join(f"{n.title} {n.description}" for n in survey.nodes)
    import re

    for block in doc.blocks:
        if block.kind.value == "figure":
            continue  # a figure is covered through the figure ids below, its placeholder text is not content
        words = [w for w in re.findall(r"[^\W\d_]{4,}", block.text)][:3]
        assert all(word in text for word in words), f"{label}: block {block.id} text is not in any item"
    attached = {fid for n in survey.nodes for fid in [*n.figure_ids, *n.uncaptioned_figure_ids, *n.insignificant_figure_ids]}
    for figure in doc.figures:
        assert figure.id in attached or figure.id in text, f"{label}: figure {figure.id} is attached to no item"


def test_the_model_mode_is_still_available_as_the_rollback() -> None:
    from app.leveling import llm_leveling

    assert "structure_mode" in llm_leveling.build_survey_tree.__code__.co_varnames
