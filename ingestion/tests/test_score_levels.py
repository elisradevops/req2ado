"""Scores computed in code from the model's anchored levels and quoted findings (app.leveling.score_levels)."""

from app.leveling.score_levels import (
    COMPLETENESS,
    FINDINGS,
    LEVEL_ISSUES,
    entry_from_votes,
    findings_of,
    levels_of,
)

TEXT = "The system shall be user-friendly and fast, TBD."


def _answer(levels: dict[str, object], findings: list[tuple[str, str]] = ()) -> dict:
    return {
        "categories": [{"name": n, "level": v, "evidence": ""} for n, v in levels.items()],
        "findings": [{"issue": i, "quote": q} for i, q in findings],
    }


def test_levels_outside_the_scale_or_without_a_name_are_not_read() -> None:
    answer = _answer({"clarity": 3, "style": 5, "rationale": -1, "atomicity": True, " ": 2})
    answer["categories"] += [{"level": 2}, "x", {"name": "clarity", "level": 0}]
    assert levels_of(answer) == {"clarity": 3}  # the first entry of a name wins
    assert levels_of("not an answer") == {} and levels_of({"categories": "x"}) == {}


def test_a_finding_counts_only_when_its_quote_is_in_the_item() -> None:
    answer = _answer(
        {},
        [
            ("vague_term", "user-friendly  and FAST"),  # whitespace and case aside
            ("placeholder", "TBD"),
            ("compound", "and the unit shall reboot"),  # not in the text
            ("conflicting_value", "fast"),  # not a finding the model may state
            ("ambiguous", ""),
        ],
    )
    assert findings_of(answer, TEXT) == {"vague_term", "placeholder"}
    assert "conflicting_value" not in FINDINGS


def test_the_overall_score_is_the_quality_mean_gated_by_completeness() -> None:
    full = entry_from_votes([_answer({"clarity": 4, "testability": 2, COMPLETENESS: 4})], TEXT)
    assert full["score"] == 75 and full["categoryScores"] == {
        "clarity": 100,
        "testability": 50,
        COMPLETENESS: 100,
    }
    fragment = entry_from_votes([_answer({"clarity": 4, "testability": 4, COMPLETENESS: 1})], TEXT)
    assert fragment["score"] == 25  # reads well, but is not a requirement: scores low anyway
    assert entry_from_votes([_answer({COMPLETENESS: 0})], TEXT)["score"] == 0
    assert (
        entry_from_votes([_answer({"clarity": 3})], TEXT)["score"] == 75
    )  # no completeness: no gate


def test_low_levels_state_their_issues_for_built_in_categories_only() -> None:
    entry = entry_from_votes(
        [
            _answer(
                {
                    "clarity": 1,
                    "testability": 2,
                    "atomicity": 0,
                    "style": 2,
                    "rationale": 1,
                    COMPLETENESS: 1,
                    "Necessary": 0,  # an organization's category: no fixed meaning to code
                }
            )
        ],
        TEXT,
    )
    assert entry["issues"] == [
        "ambiguous",
        "compound",
        "fragment",
        "missing_acceptance_criteria",
        "missing_rationale",
    ]
    assert entry_from_votes([_answer({COMPLETENESS: 0})], TEXT)["issues"] == ["not_a_requirement"]
    assert set(LEVEL_ISSUES) == {
        COMPLETENESS,
        "clarity",
        "testability",
        "atomicity",
        "style",
        "rationale",
    }


def test_confidence_is_how_far_the_two_votes_agree() -> None:
    def vote(level: int, completeness: int = 4, findings=()):  # noqa: ANN001, ANN202
        return _answer({"clarity": level, COMPLETENESS: completeness}, list(findings))

    assert entry_from_votes([vote(3), vote(4)], TEXT)["confidence"] == "high"
    assert entry_from_votes([vote(2), vote(4)], TEXT)["confidence"] == "medium"
    assert entry_from_votes([vote(0), vote(3)], TEXT)["confidence"] == "low"
    # Agreeing levels but different findings: not high.
    assert (
        entry_from_votes([vote(3), vote(3, findings=[("placeholder", "TBD")])], TEXT)["confidence"]
        == "medium"
    )
    # One vote says it is a requirement, the other says it is not: low, whatever the gap.
    assert entry_from_votes([vote(3, 1), vote(3, 2)], TEXT)["confidence"] == "low"


def test_two_votes_are_averaged_and_their_findings_pooled() -> None:
    entry = entry_from_votes(
        [
            _answer({"clarity": 3, COMPLETENESS: 4}, [("placeholder", "TBD")]),
            _answer({"clarity": 2, COMPLETENESS: 4}, [("vague_term", "fast")]),
        ],
        TEXT,
    )
    assert entry["categoryScores"]["clarity"] == 62 and entry["score"] == 62
    assert entry["issues"] == ["placeholder", "vague_term"]


def test_one_usable_vote_is_a_medium_confidence_and_none_is_no_entry() -> None:
    entry = entry_from_votes([None, _answer({"clarity": 4, COMPLETENESS: 4})], TEXT)
    assert entry["score"] == 100 and entry["confidence"] == "medium"
    assert entry_from_votes([None, _answer({})], TEXT) is None
    assert entry_from_votes([], TEXT) is None
