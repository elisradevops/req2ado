from app.distillation.title import extract_baseline_title


def test_returns_text_unchanged_when_under_the_limit() -> None:
    assert extract_baseline_title("Channel scan") == "Channel scan"


def test_strips_leading_and_trailing_whitespace() -> None:
    assert extract_baseline_title("  Channel scan  ") == "Channel scan"


def test_boundary_255_chars_unchanged() -> None:
    text = "A" * 255
    result = extract_baseline_title(text)
    assert result == text
    assert len(result) == 255


def test_boundary_256_chars_is_over_the_azure_devops_limit() -> None:
    # Azure DevOps refuses a title over 255 characters (owner rule R6, 2026-11-26): one more is shortened, with the "…" marker.
    result = extract_baseline_title("A" * 256)
    assert len(result) == 255
    assert result.endswith("…")


def test_truncates_at_last_word_boundary_when_one_exists_within_the_window() -> None:
    # "word " repeated so a whitespace boundary exists well before the limit; the function must cut back to that boundary rather than
    # inside a word, mark the cut, and never exceed the limit.
    text = ("word " * 60).strip()  # 299 chars, many boundaries before 255
    result = extract_baseline_title(text)
    assert len(result) <= 255
    assert result.endswith("word…")  # a whole word, then the marker
    assert text.startswith(result[:-1])  # a genuine prefix, not paraphrased


def test_hard_cuts_when_no_word_boundary_exists_in_window() -> None:
    # No whitespace anywhere: no boundary to cut back to, so it is cut at the limit, the marker included.
    result = extract_baseline_title("A" * 300)
    assert result == "A" * 254 + "…"


def test_never_summarizes_or_paraphrases_short_text() -> None:
    # BASELINE must extract, never summarize — the full sentence is used
    # verbatim as the title when it already fits within the limit.
    text = "The receiver shall scan all available channels within 10 seconds of power-on."
    assert extract_baseline_title(text) == text


def test_multibyte_codepoints_truncate_safely_without_corruption() -> None:
    # Python str slicing operates on Unicode codepoints, not bytes, so a 300-codepoint emoji string is cut to the limit in codepoints
    # without raising or producing invalid output. Extended-grapheme-cluster awareness is out of scope.
    result = extract_baseline_title("\U0001f600" * 300)  # 😀 repeated 300 times, no whitespace
    assert result == "\U0001f600" * 254 + "…"


def test_multibyte_text_with_word_boundaries_trims_correctly() -> None:
    text = ("שלום " * 60).strip()  # Hebrew "hello" repeated, many boundaries
    result = extract_baseline_title(text)
    assert len(result) <= 255
    assert result.endswith("שלום…") and text.startswith(result[:-1])


def test_respects_a_custom_max_length() -> None:
    assert extract_baseline_title("Channel scan test", max_length=8) == "Channel…"


def test_uses_only_the_first_sentence_of_multi_sentence_text() -> None:
    text = "The receiver shall scan all channels. This improves coverage. A third sentence follows."
    assert extract_baseline_title(text) == "The receiver shall scan all channels."


def test_does_not_split_on_a_decimal_number() -> None:
    # "3.3V" must not be mistaken for a sentence boundary -- no whitespace
    # immediately follows the '.' there.
    text = "The BP shall operate at 3.3V and comply with MIL-STD-704A."
    assert extract_baseline_title(text) == text


def test_does_not_split_on_an_abbreviation() -> None:
    # "e.g." must not be mistaken for a sentence boundary either.
    text = "The system shall support common formats, e.g. PDF and DOCX, for ingestion."
    assert extract_baseline_title(text) == text


def test_falls_back_to_whole_text_when_no_sentence_boundary_exists() -> None:
    # No '.', '!', or '?' anywhere -- behavior unchanged from pre-sentence-rule.
    text = "Channel scan without terminal punctuation"
    assert extract_baseline_title(text) == text


def test_truncates_the_first_sentence_when_it_alone_exceeds_max_length() -> None:
    # The first sentence itself is too long -- shorten JUST that sentence at a word boundary, not the whole multi-sentence text (a later
    # sentence must never leak into the result).
    long_sentence = ("word " * 60).strip() + "."  # ~300 chars, one long sentence
    text = long_sentence + " A short second sentence."
    result = extract_baseline_title(text)
    assert len(result) <= 255
    assert "second sentence" not in result
    assert long_sentence.startswith(result[:-1]) and result.endswith("…")


def test_hard_cuts_the_first_sentence_when_it_has_no_word_boundary() -> None:
    text = ("A" * 300) + ". A short second sentence."
    assert extract_baseline_title(text) == "A" * 254 + "…"
