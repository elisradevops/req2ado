"""A proposed rewrite is checked against the original before the user applies it: no model, only what can be seen in the two texts.

A prod chat turn turned a 115-character requirement into 741 characters (6.4x), changed the title, and scored lower in 14 of
15 categories. Nothing bounded or even flagged it."""
from app.chat.rewrite_check import check_rewrite

TITLE = "Receiver lock time"
ORIGINAL = "The receiver shall lock onto the carrier within 5 ms at 3.3 V per MIL-STD-461G."


def codes(warnings: list[dict]) -> set[str]:
    return {w["code"] for w in warnings}


def test_a_faithful_rewrite_raises_nothing() -> None:
    proposal = "The receiver shall acquire carrier lock within 5 ms when supplied with 3.3 V, as required by MIL-STD-461G."
    assert check_rewrite(TITLE, ORIGINAL, None, proposal) == []


def test_the_prod_case_a_much_longer_bundled_rewrite_with_a_new_title_is_flagged_three_ways() -> None:
    long = (
        "The receiver shall lock onto the carrier within 5 ms at 3.3 V per MIL-STD-461G. The receiver shall report loss of lock "
        "to the controller within 2 ms. The receiver shall retry acquisition up to three times before declaring failure. "
        "Rationale: fast lock keeps the downstream filter settled. Acceptance: verified by test with a calibrated source. "
        "The receiver shall log every acquisition attempt together with its duration, the supply voltage and the temperature."
    )
    found = check_rewrite(TITLE, ORIGINAL, "Receiver acquisition behaviour", long)
    assert {"much_longer", "more_statements", "title_changed"} <= codes(found)
    assert all(w["severity"] in ("high", "notice") for w in found)


def test_dropped_numbers_and_identifiers_are_named() -> None:
    found = {w["code"]: w for w in check_rewrite(TITLE, ORIGINAL, None, "The receiver shall lock quickly.")}
    assert set(found["dropped_numbers"]["detail"].split(", ")) == {"5", "3.3"}
    assert "MIL-STD-461G" in found["dropped_identifiers"]["detail"]
    assert found["dropped_numbers"]["severity"] == "high" and found["dropped_identifiers"]["severity"] == "high"


def test_a_title_that_only_differs_in_case_or_spacing_is_not_a_change_and_no_proposed_title_is_not_one_either() -> None:
    proposal = "The receiver shall lock onto the carrier within 5 ms at 3.3 V per MIL-STD-461G."
    assert "title_changed" not in codes(check_rewrite(TITLE, ORIGINAL, "  receiver   LOCK time ", proposal))
    assert "title_changed" not in codes(check_rewrite(TITLE, ORIGINAL, None, proposal))
    changed = {w["code"]: w for w in check_rewrite(TITLE, ORIGINAL, "Something else", proposal)}
    assert changed["title_changed"]["severity"] == "notice"


def test_a_short_item_that_grows_a_little_is_not_flagged_as_much_longer() -> None:
    assert "much_longer" not in codes(check_rewrite("T", "The unit shall start.", None, "The unit shall start within 10 s of power-on."))


def test_growth_is_judged_against_the_original_length() -> None:
    original = "x" * 400
    assert "much_longer" not in codes(check_rewrite("T", original, None, "x" * 900))  # 2.25x
    assert "much_longer" in codes(check_rewrite("T", original, None, "x" * 1100))  # 2.75x


def test_a_statement_count_that_does_not_grow_is_not_bundling() -> None:
    two = "The unit shall start. The unit shall stop."
    assert "more_statements" not in codes(check_rewrite("T", two, None, "The unit shall start, and the unit shall stop cleanly."))
    assert "more_statements" in codes(check_rewrite("T", "The unit shall start.", None, two))


def test_an_empty_proposed_description_is_flagged() -> None:
    assert "empty_description" in codes(check_rewrite("T", ORIGINAL, None, "   "))
    assert codes(check_rewrite("T", "", None, "")) == set()  # nothing to lose


def test_it_never_raises_and_is_deterministic() -> None:
    assert check_rewrite(None, None, None, None) == []  # type: ignore[arg-type]
    first = check_rewrite(TITLE, ORIGINAL, "Other", "no numbers here")
    assert first == check_rewrite(TITLE, ORIGINAL, "Other", "no numbers here")
