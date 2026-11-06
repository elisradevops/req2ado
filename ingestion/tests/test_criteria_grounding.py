import pytest

from app.leveling.criteria_grounding import given_values, has_quantity, ungrounded


def _check(criterion: str, *given: str) -> list[str]:
    return ungrounded(criterion, given_values(given))


def test_a_number_copied_from_the_input_is_grounded() -> None:
    assert (
        _check("Verify the latency is below 5 ms.", "The system shall respond within 5 ms.") == []
    )


def test_an_invented_number_is_reported() -> None:
    assert _check("Verify the latency is below 7 ms.", "The system shall respond quickly.") != []


def test_numbers_compare_by_value_not_spelling() -> None:
    assert _check("Measure 5.0 s.", "Timeout is 5 s.") == []
    assert _check("Measure 1000 samples.", "Capture 1,000 samples.") == []
    assert _check("Measure 1000 samples.", "Capture 1 000 samples.") == []


def test_unicode_minus_and_signs_do_not_change_the_value() -> None:
    assert _check("Operate at -40 °C.", "Range: −40 ℃ to +85 ℃.") == []
    assert _check("Operate at +85 °C.", "Range: −40 ℃ to +85 ℃.") == []


def test_ranges_are_checked_per_number() -> None:
    assert _check("Check 10-20 V.", "Supply 10 to 20 V.") == []
    assert _check("Check 10-25 V.", "Supply 10 to 20 V.") != []


def test_number_words_ground_digits_both_ways() -> None:
    assert _check("Run 5 attempts.", "It shall retry five times.") == []
    assert _check("Run five attempts.", "It shall retry 5 times.") == []
    assert _check("Run three attempts.", "It shall retry quickly.") != []


def test_hebrew_number_words_and_prefixed_digits() -> None:
    assert _check("בדוק 3 ניסיונות.", "המערכת תנסה שלוש פעמים.") == []
    assert _check("בדוק ב-5 שניות.", "זמן התגובה 5 שניות.") == []
    assert _check("בדוק ל־10 שניות.", "עד 10 שניות.") == []
    assert _check("בדוק 9 שניות.", "זמן התגובה 5 שניות.") != []


def test_bidi_marks_are_ignored() -> None:
    assert _check("בדוק ‏5‎ שניות.", "זמן 5 שניות.") == []


def test_a_unit_attached_to_a_number_must_be_present() -> None:
    assert _check("Measure 5 ms.", "Respond in 5 ms.") == []
    assert _check("Measure 5 s.", "Respond in 5 ms.") != []


def test_a_unit_letter_that_is_a_word_is_not_a_unit() -> None:
    assert _check("Apply 5 A of current.", "Supply 5 A.") == []
    assert _check("Test 3 a time.", "Run 3 tests.") == []


def test_a_standard_is_grounded_as_a_whole_token_and_its_digits_are_not_numbers() -> None:
    assert _check("Comply with MIL-STD-810G.", "Environmental tests per MIL-STD-810G.") == []
    assert _check("Comply with MIL-STD-810G.", "Environmental tests per MIL STD 810G.") == []
    assert _check("Use RS-422.", "Use RS-232.") != []
    assert (
        _check("Per ISO 9001.", "Per ISO 9001:2015.") == []
    )  # a year suffix is its own number; the base standard matches


def test_a_standard_in_a_criterion_missing_from_the_input_is_reported() -> None:
    assert _check("Conforms to DO-178C.", "The software shall be safe.") != []


def test_extra_grounding_text_grounds_a_standard() -> None:
    assert _check("Conforms to DO-178C.", "The software shall be safe.", "DO-178C") == []


def test_section_references_must_match_exactly() -> None:
    assert _check("As described in 4.2.1.", "See section 4.2.1 for details.") == []
    assert _check("As described in 4.2.2.", "See section 4.2.1 for details.") != []


def test_list_enumerators_in_a_criterion_are_not_values() -> None:
    assert _check("Step 1: power on the unit.", "The unit shall start.") == []
    assert _check("(2) Observe the display.", "The unit shall show a status.") == []
    assert _check("3. Record the result.", "The unit shall log.") == []


def test_text_without_digits_has_nothing_to_ground() -> None:
    assert _check("Verify the display shows an error.", "The display shall show an error.") == []


@pytest.mark.parametrize(
    "text",
    [
        "The latency shall not exceed 5 ms.",
        "Supply voltage 28 V.",
        "Accuracy of 2%.",
        "Operate at 85 °C.",
        "The response time shall be at least 3 seconds.",
        "No more than 10 retries.",
        "At most 4 channels.",
        "The value shall be >= 5.",
        "Mass < 3 kg",
        "המערכת תגיב תוך 5 שניות.",
        "לפחות 3 ניסיונות.",
        "Startup power draw should stay under two watts.",
        "The unit shall survive a one-meter drop onto a hard surface.",
        "The unit shall run for one hour.",
        "The unit shall comply with MIL-STD-810G.",
        "The unit shall meet RS-422.",
        "Conforms to IEEE 802.3.",
        "The function shall be verified by test.",
        "Compliance is demonstrated by inspection.",
        "This shall be tested.",
        "יאומת בבדיקה.",
        "ייבדק בניתוח.",
    ],
)
def test_text_with_a_checkable_value_or_verification_has_a_quantity(text: str) -> None:
    assert has_quantity(text)


@pytest.mark.parametrize(
    "text",
    [
        "The system shall support 4 channels.",
        "The unit shall be described in section 4.2.1.",
        "See Table 3.",
        "The system shall be reliable.",
        "Version 2.0 of the tool shall be used.",
        "The product shall start quickly.",
        "No one shall enter the room.",
        "Step 3-A shall be reviewed later.",
        "המערכת תהיה אמינה.",
        "",
    ],
)
def test_text_without_a_checkable_value_has_no_quantity(text: str) -> None:
    assert not has_quantity(text)


def test_unit_words_and_symbols_compare_equal() -> None:
    assert _check("Check 5 watts.", "The supply gives 5 W.") == []
    assert _check("Check a one-meter drop.", "Survive a drop of 1 m.") == []
    assert _check("Check 2 seconds.", "Time out after 2 s.") == []
    assert _check("Check 5 volts.", "Supply 5 A.") != []


def test_the_digits_of_a_standard_in_a_criterion_are_not_checked_as_numbers() -> None:
    assert _check("Test per MIL-STD-810G.", "The unit shall be rugged.", "MIL-STD-810G") == []


# -- review findings ------------------------------------------------------------------------------------------------------------------------


def test_one_before_a_unit_and_big_number_words_are_values_in_a_criterion() -> None:
    assert (
        _check("Verify the unit responds within one second.", "The unit shall respond promptly.")
        != []
    )
    assert (
        _check("Verify the unit responds within one second.", "The unit shall respond within 1 s.")
        == []
    )
    assert _check("Verify a thousand samples.", "The unit shall log samples.") != []
    assert (
        _check("Verify no one is hurt.", "The unit shall be safe.") == []
    )  # "one" without a unit is a pronoun


def test_a_decimal_at_the_start_of_a_criterion_is_not_a_list_enumerator() -> None:
    assert _check("99.9% availability over a day.", "Availability shall be 99.9%.") == []
    assert _check("1.5 V ripple at most.", "Ripple of 5 V.") != []
    assert _check("1. Record the result.", "The unit shall log.") == []


@pytest.mark.parametrize(
    "text",
    [
        "SRS-045 The system shall log faults.",
        "REQ-12: Operator shall confirm the action.",
        "The UART 2 shall carry telemetry.",
        "The CAN 2.0B bus shall carry telemetry.",
        "The display shall show the measured temperature.",
        "The tool shall store analyzed results.",
        "המערכת תציג ניתוח נתונים.",
    ],
)
def test_a_requirement_id_a_port_name_or_a_content_word_is_not_a_checkable_value(text: str) -> None:
    assert not has_quantity(text)


@pytest.mark.parametrize(
    "text",
    [
        "The temperature shall be measured by an external probe.",
        "Compliance shall be verified per TP-11.",
        "Per ARINC 429 the bus shall carry data.",
        "The unit shall meet IEC 61508.",
        "הדרישה תיבדק בניתוח.",
    ],
)
def test_a_verification_phrase_or_a_real_standard_is_still_a_checkable_value(text: str) -> None:
    assert has_quantity(text)
