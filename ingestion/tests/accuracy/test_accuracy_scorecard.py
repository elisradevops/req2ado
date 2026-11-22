"""Every supported input format, built from the same ground truth, must come out with the same items: right type, right parent, readable
description, no markup leaking. A format that fails here fails for a real customer file the same way."""

from __future__ import annotations

import pytest

from app.dispatch import dispatch_by_extension
from app.leveling.tree_builder import build_baseline_tree

from .scorecard import score
from .variants import VARIANTS


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    out = tmp_path_factory.mktemp("variants")
    return {v.name: v.build(out) for v in VARIANTS}


@pytest.mark.parametrize("variant", VARIANTS, ids=lambda v: v.name)
def test_baseline_keeps_every_item_right(variant, built) -> None:
    path = built[variant.name]
    tree = build_baseline_tree(dispatch_by_extension(path.name, str(path)))
    result = score(tree, rich=variant.rich)
    assert not result.problems(), result.summary()
    assert result.produced == result.expected, result.summary()


@pytest.mark.parametrize("variant", [v for v in VARIANTS if v.tabular], ids=lambda v: v.name)
def test_survey_keeps_every_stated_item_right(variant, built) -> None:
    """SURVEY with a model that refuses every structure call: the file's own stated types and parents decide the items."""
    from app.leveling.llm_leveling import build_survey_tree

    from ..test_structure_contract import (
        SimulatedGrouper,
        StructureRefusingClient,
        TitleHashEmbedder,
    )

    path = built[variant.name]
    tree = build_survey_tree(
        dispatch_by_extension(path.name, str(path)),
        StructureRefusingClient(),
        grouping_client=SimulatedGrouper(1),
        embed_client=TitleHashEmbedder(),
    )
    result = score(tree, rich=variant.rich)
    assert not result.problems(), result.summary()
    assert result.produced == result.expected, result.summary()
