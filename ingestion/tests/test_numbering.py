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


def test_numbering_depth_counts_dot_separated_segments() -> None:
    assert numbering_depth("1") == 1
    assert numbering_depth("1.1") == 2
    assert numbering_depth("1.1.1.1") == 4
    assert numbering_depth("1.1.1.a") == 4
    assert numbering_depth("1.1.1.1.a") == 5
