from app.leveling.grounding import grounding_score as _grounding_score
from app.leveling.grounding import significant_words as _significant_words


def test_identical_text_scores_1() -> None:
    assert _grounding_score("The display shall support HDR.", "The display shall support HDR.") == 1.0


def test_paraphrase_reusing_source_vocabulary_scores_highly() -> None:
    score = _grounding_score(
        "The system shall handle: The display supports HDR playback.",
        "The display supports HDR playback.",
    )
    assert score > 0.5


def test_completely_unrelated_text_scores_0() -> None:
    score = _grounding_score(
        "The warranty period is thirty-six months from purchase.",
        "The display shall support HDR.",
    )
    assert score == 0.0


def test_generated_text_with_no_significant_words_scores_1() -> None:
    # "The system shall be the system" -- every word is a stopword, nothing
    # to be ungrounded about.
    assert _grounding_score("The system shall be the system.", "unrelated source text") == 1.0


def test_stopwords_do_not_count_toward_the_denominator() -> None:
    # "the"/"system"/"shall"/"be" are all stopwords -- only "hdr" is
    # significant, and it IS in the source, so this scores 1.0 despite most
    # words being boilerplate requirement phrasing absent from the
    # (contrived, single-word) source.
    assert _grounding_score("The system shall be HDR.", "hdr") == 1.0


def test_partial_overlap_scores_between_0_and_1() -> None:
    score = _grounding_score(
        "The display shall support HDR and voice control.",
        "The display supports HDR.",
    )
    assert 0.0 < score < 1.0


def test_significant_words_matches_hebrew_text_not_just_ascii() -> None:
    # NEW-04/300541 regression guard: the word pattern used to be
    # [a-z0-9]+ (ASCII-only), which silently returned an empty set for any
    # non-Latin script -- both this check and _grounding_score treat an
    # empty word set as "nothing to judge," making them inert on Hebrew.
    assert _significant_words("המערכת תציג נתונים בזמן אמת") == {"המערכת", "תציג", "נתונים", "בזמן", "אמת"}


def test_grounding_score_is_not_trivially_1_for_unrelated_hebrew_text() -> None:
    # Before the fix, an empty word set on either side made this always
    # score 1.0 (both branches short-circuit on "nothing significant to
    # judge") regardless of whether the texts were actually related.
    score = _grounding_score("המערכת תציג התרעה על תקלה בחיישן", "לוח הזמנים של הרכבת השתנה")
    assert score < 1.0
