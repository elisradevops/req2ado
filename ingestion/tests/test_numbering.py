from app.leveling.numbering import numbering_depth, parse_numbering


def test_parses_single_level_numbering() -> None:
    label, remainder = parse_numbering("1 Receiver")
    assert label == "1"
    assert remainder == "Receiver"


def test_parses_four_level_numbering() -> None:
    label, remainder = parse_numbering("1.1.1.1 The receiver shall scan all channels.")
    assert label == "1.1.1.1"
    assert remainder == "The receiver shall scan all channels."


def test_parses_lettered_sub_item_numbering() -> None:
    label, remainder = parse_numbering("1.1.1.1.a The receiver shall support terrestrial broadcast.")
    assert label == "1.1.1.1.a"
    assert remainder == "The receiver shall support terrestrial broadcast."


def test_returns_none_for_unnumbered_text() -> None:
    label, remainder = parse_numbering("The receiver shall scan all channels.")
    assert label is None
    assert remainder == "The receiver shall scan all channels."


def test_parses_top_level_numbering_with_a_trailing_dot() -> None:
    # Regression: '1. Receiver' previously fell through to (None, text)
    # entirely -- the '.' immediately after '1' was followed by a space,
    # not a digit or letter, so neither optional group could consume it and
    # the mandatory whitespace then failed to match against the dot itself.
    # Silently dropped every top-level line of a document using this
    # convention (see tree_builder.py's depth=None + empty-stack path).
    label, remainder = parse_numbering("1. Receiver")
    assert label == "1"
    assert remainder == "Receiver"


def test_parses_multi_level_numbering_with_a_trailing_dot() -> None:
    label, remainder = parse_numbering("1.1.1.1. The receiver shall scan all channels.")
    assert label == "1.1.1.1"
    assert remainder == "The receiver shall scan all channels."


def test_still_rejects_a_decimal_value_immediately_followed_by_a_letter() -> None:
    # '3.3V' -- no whitespace immediately after the dot-adjacent digit
    # sequence -- must stay unmatched, same as before the trailing-dot fix.
    label, remainder = parse_numbering("3.3V shall not exceed the rated voltage.")
    assert label is None
    assert remainder == "3.3V shall not exceed the rated voltage."


def test_numbering_depth_counts_dot_separated_segments() -> None:
    assert numbering_depth("1") == 1
    assert numbering_depth("1.1") == 2
    assert numbering_depth("1.1.1.1") == 4
    assert numbering_depth("1.1.1.a") == 4
    assert numbering_depth("1.1.1.1.a") == 5
