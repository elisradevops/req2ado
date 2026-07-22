from app.leveling.llm_leveling import _grounding_score


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
