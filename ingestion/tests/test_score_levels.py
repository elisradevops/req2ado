"""Scores computed in code from the model's anchored levels and quoted findings (app.leveling.score_levels)."""

from app.leveling.score_levels import (
    COMPLETENESS,
    FINDINGS,
    LEVEL_ISSUES,
    LEVEL_ONLY_ISSUES,
    STANDARD_REQUIREMENTS,
    builtin_categories,
    entry_from_votes,
    findings_for,
    findings_of,
    levels_of,
)

EVERYTHING = frozenset(STANDARD_REQUIREMENTS)

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
        requires=EVERYTHING,
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


def test_an_issue_about_something_missing_comes_from_the_levels_only() -> None:
    # The flip seen on the fixture: same levels, one vote also reports a "missing" finding quoting the whole item. It no longer counts,
    # so the item keeps one issue set and a high confidence.
    whole = [("missing_acceptance_criteria", TEXT), ("missing_rationale", TEXT)]
    levels = {"clarity": 4, "testability": 4, COMPLETENESS: 4}
    entry = entry_from_votes([_answer(levels), _answer(levels, whole)], TEXT, requires=EVERYTHING)
    assert entry["issues"] == [] and entry["confidence"] == "high"
    assert LEVEL_ONLY_ISSUES.isdisjoint(FINDINGS)
    low = entry_from_votes(
        [_answer({"testability": 2, "rationale": 1, COMPLETENESS: 4})], TEXT, requires=EVERYTHING
    )
    assert low["issues"] == ["missing_acceptance_criteria", "missing_rationale"]


def test_without_a_standard_active_voice_and_rationale_are_not_judged() -> None:
    assert builtin_categories() == ("clarity", "testability", "atomicity")
    assert "passive_voice" not in findings_for() and "passive_voice" in findings_for(
        frozenset({"active_voice"})
    )
    answer = _answer(
        {
            "clarity": 4,
            "testability": 4,
            "atomicity": 4,
            "style": 0,
            "rationale": 0,
            COMPLETENESS: 4,
        },
        [("passive_voice", "shall be")],
    )
    entry = entry_from_votes([answer], "The output shall be verified.")
    assert entry["score"] == 100 and entry["issues"] == []
    assert set(entry["categoryScores"]) == {"clarity", "testability", "atomicity", COMPLETENESS}
    # Required by the standard: judged, scored, and its issue raised.
    voiced = entry_from_votes(
        [answer], "The output shall be verified.", requires=frozenset({"active_voice"})
    )
    assert voiced["categoryScores"]["style"] == 0 and voiced["issues"] == ["passive_voice"]
    assert "rationale" not in voiced["categoryScores"]


def test_an_organization_category_named_like_a_built_in_one_is_kept() -> None:
    entry = entry_from_votes([_answer({"style": 2, COMPLETENESS: 4})], TEXT, builtin=False)
    assert entry["categoryScores"]["style"] == 50 and "passive_voice" not in entry["issues"]
