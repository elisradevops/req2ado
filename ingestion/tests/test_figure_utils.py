from app.loaders.figure_utils import extract_figure_title


def test_extract_figure_title_returns_the_text_after_the_figure_label():
    assert extract_figure_title("Figure 1: Power distribution diagram.") == "Power distribution diagram."


def test_extract_figure_title_is_case_insensitive_and_tolerates_a_period():
    assert extract_figure_title("figure 2. Sensor Wiring") == "Sensor Wiring"


def test_extract_figure_title_falls_back_to_the_whole_line_when_the_label_has_no_trailing_title():
    assert extract_figure_title("Figure 3:") == "Figure 3:"


def test_extract_figure_title_returns_none_when_the_text_does_not_look_like_a_figure_label():
    assert extract_figure_title("Just a regular caption, not labeled.") is None
