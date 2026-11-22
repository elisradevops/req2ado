from fractions import Fraction

from app.leveling.quantities import compare, quantities


def _read(text: str) -> list[tuple[str, Fraction, str, bool]]:
    return [(q.dimension, q.value, q.kind, q.tolerance) for q in quantities(text)]


def test_units_normalise_to_one_base_so_equal_values_compare_equal() -> None:
    assert _read("respond within 500 ms") == _read("respond within 0.5 seconds")
    assert _read("85 °C") == _read("85 degrees Celsius") == _read("358.15 kelvin")
    assert _read("1.5 kV") == _read("1500 V")
    assert _read("1,000 Hz") == _read("1 kHz")


def test_ac_and_dc_are_part_of_a_voltage() -> None:
    assert _read("Input 28VAC") == [("voltage", Fraction(28), "ac", False)]
    assert _read("an input of 28V DC") == [("voltage", Fraction(28), "dc", False)]
    assert _read("28 V ACME") == [("voltage", Fraction(28), "", False)]  # a word, not AC


def test_a_range_gives_both_ends_the_unit_and_signs_count() -> None:
    assert [v for _, v, *_ in _read("operate from -40 to +85 °C")] == [
        Fraction(-40) + Fraction("273.15"),
        Fraction(85) + Fraction("273.15"),
    ]
    assert [v for _, v, *_ in _read("between 10-20 V")] == [10, 20]
    assert _read("±5%") == [("percent", Fraction(5), "", True)]


def test_counts_ids_standards_and_section_references_are_not_quantities() -> None:
    assert quantities("The unit has 4 channels.") == []
    assert quantities("Tested per MIL-STD-810G section 4.2.1.") == []
    assert quantities("x-5 V") == []


def test_units_whose_conversion_is_ambiguous_or_rounded_compare_only_with_themselves() -> None:
    assert compare("8 MB", "8 Mb").status == "incomparable"  # megabyte vs megabit
    assert compare("14.7 psi", "101.3 kPa").status == "incomparable"
    assert compare("212 °F", "100 °C").status == "incomparable"


def test_compare_agrees_differs_or_cannot_tell() -> None:
    assert compare("efficiency at least 85%", "efficiency at-least 93%").differing == ("85%", "93%")
    assert compare("Input 28VAC", "input of 28V DC").status == "differ"
    assert (
        compare("input 28 V", "input 28 VDC").status == "agree"
    )  # an unstated kind is no conflict
    assert compare("28 V input and 5 V output", "28 V input").status == "agree"  # one states more
    assert compare("painted green", "painted red").status == "incomparable"


def test_a_hebrew_statement_is_read_the_same_way() -> None:
    result = compare("מתח הכניסה יהיה 28V", "היחידה תפעל במתח כניסה של 24V")
    assert (result.status, result.differing) == ("differ", ("28V", "24V"))


def test_hebrew_unit_words_and_prefixed_numbers_are_quantities() -> None:
    assert _read("מתח הכניסה יהיה 28 וולט") == _read("28 V")
    assert _read("תוך 2 שניות") == _read("within 2000 ms")
    assert _read("ב-5 שניות") == _read("5 s")  # a joined prefix, not a minus sign
    assert _read("לאחר 10 דקות") == _read("after 600 seconds")
    assert _read("150 מילישניות") == _read("150 ms")
    result = compare("מתח הכניסה של היחידה יהיה 28 וולט.", "היחידה תפעל במתח כניסה של 24 וולט.")
    assert result.differing == ("28 וולט", "24 וולט")
