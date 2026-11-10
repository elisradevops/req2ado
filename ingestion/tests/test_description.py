from app.distillation.description import assemble_description, strip_leading_title


def test_joins_existing_and_addition_with_a_newline() -> None:
    assert (
        assemble_description("First paragraph.", "Second paragraph.")
        == "First paragraph.\nSecond paragraph."
    )


def test_preserves_text_verbatim_no_mutation_or_normalization() -> None:
    existing = "OPEN: confirm connector part number before release."
    addition = "  extra whitespace preserved  "
    result = assemble_description(existing, addition)
    assert (
        result
        == "OPEN: confirm connector part number before release.\n  extra whitespace preserved  "
    )


def test_does_not_mutate_the_input_strings() -> None:
    existing = "unchanged"
    addition = "also unchanged"
    assemble_description(existing, addition)
    assert existing == "unchanged"
    assert addition == "also unchanged"


def test_handles_empty_addition() -> None:
    assert assemble_description("existing", "") == "existing\n"


def test_multiple_sequential_assemblies_accumulate_in_order() -> None:
    result = assemble_description("first", "second")
    result = assemble_description(result, "third")
    assert result == "first\nsecond\nthird"


# --- strip_leading_title (R5: the title must not be repeated inside the description) ---


def test_strip_leading_title_removes_a_whole_first_line_title_when_body_follows() -> None:
    text = "3.3V Rail\nThe rail shall hold +/-2%."
    assert strip_leading_title(text, "3.3V Rail") == "The rail shall hold +/-2%."


def test_strip_leading_title_keeps_a_heading_only_description() -> None:
    assert strip_leading_title("Synchronization", "Synchronization") == "Synchronization"


def test_strip_leading_title_keeps_a_blank_body_description() -> None:
    text = "Synchronization\n  \n"
    assert strip_leading_title(text, "Synchronization") == text


def test_strip_leading_title_leaves_a_first_sentence_only_title() -> None:
    text = "The unit shall boot. The unit shall log.\nNote."
    assert strip_leading_title(text, "The unit shall boot.") == text


def test_strip_leading_title_leaves_an_unrelated_title() -> None:
    assert strip_leading_title("Label\nBody.", "Other") == "Label\nBody."


def test_strip_leading_title_ignores_an_empty_title() -> None:
    assert strip_leading_title("Body\nmore", "") == "Body\nmore"
