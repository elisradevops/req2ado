from app.leveling.customer_id import extract_customer_requirement_code


def test_extracts_a_hyphenated_multi_segment_code() -> None:
    assert extract_customer_requirement_code("REQ-AV-014 The receiver shall tune across 2-18 GHz.") == "REQ-AV-014"


def test_extracts_a_simple_hyphenated_code() -> None:
    assert extract_customer_requirement_code("REQ-014: The system shall do X.") == "REQ-014"


def test_extracts_an_underscore_separated_code() -> None:
    assert extract_customer_requirement_code("ABC_1234 The system shall do Y.") == "ABC_1234"


def test_extracts_a_prefix_with_no_separator() -> None:
    assert extract_customer_requirement_code("SR12345 The system shall do Z.") == "SR12345"


def test_finds_the_code_anywhere_in_the_text_not_just_at_the_start() -> None:
    assert extract_customer_requirement_code("The system shall satisfy REQ-AV-014 at all times.") == "REQ-AV-014"


def test_returns_none_when_no_code_is_present() -> None:
    assert extract_customer_requirement_code("The system shall mute audio output within 50ms.") is None


def test_never_matches_ordinary_technical_units_and_measurements() -> None:
    # Confirmed real risk this pattern must avoid: real ingestion test
    # fixtures and the live AirPro ICD reference document are full of
    # exactly this kind of numeric/unit prose -- none of it is a customer
    # requirement code and must never be reported as one.
    for text in [
        "The receiver shall provide 3.3V regulated power to the backplane.",
        "The system shall mute audio output within 50ms of receiving the mute command.",
        "The receiver shall tune across 2-18 GHz in 1 MHz steps.",
        "The system shall detect an over-current condition within 10ms.",
        "3.3V Rail Requirements",
        "V_AUX shall stay within tolerance.",
    ]:
        assert extract_customer_requirement_code(text) is None, text


def test_returns_none_for_empty_text() -> None:
    assert extract_customer_requirement_code("") is None
