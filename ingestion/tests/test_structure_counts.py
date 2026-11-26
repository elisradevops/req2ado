"""scripts/pdf_structure_counts.py, the numbers-only probe run on real files in production. On the fictional TV twin every number is
known, so a count that drifts from what the builder did shows up here before it misleads a probe (2026-11-26: four sections left out on
purpose were reported as "without item", and five empty sections as 0)."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent / "fixtures" / "tv_twin"))
from build_tv_twin_pdf import build_twin_spec_pdf  # noqa: E402

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "pdf_structure_counts.py"


@pytest.fixture(scope="module")
def counts(tmp_path_factory) -> dict:
    spec = importlib.util.spec_from_file_location("pdf_structure_counts", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.counts_for(build_twin_spec_pdf(tmp_path_factory.mktemp("counts"))[0])


def test_no_numbered_section_is_lost(counts: dict) -> None:
    assert counts["numbered_sections_lost"] == 0


def test_sections_left_out_on_purpose_are_counted_apart(counts: dict) -> None:
    # 1.3 Revision history, 1.4 References, 1.5 Abbreviations (front matter), 3 Requirement identities (back matter) and the five empty
    # sections (R2)
    assert counts["numbered_sections_left_out"] == 9
    assert "numbered_sections_without_item" not in counts


def test_empty_sections_are_counted_and_none_is_an_item(counts: dict) -> None:
    assert counts["empty_sections"] == 5
    assert counts["empty_items"] == 0
