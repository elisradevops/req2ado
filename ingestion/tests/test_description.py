from app.distillation.description import assemble_description


def test_joins_existing_and_addition_with_a_newline() -> None:
    assert assemble_description("First paragraph.", "Second paragraph.") == "First paragraph.\nSecond paragraph."


def test_preserves_text_verbatim_no_mutation_or_normalization() -> None:
    existing = "OPEN: confirm connector part number before release."
    addition = "  extra whitespace preserved  "
    result = assemble_description(existing, addition)
    assert result == "OPEN: confirm connector part number before release.\n  extra whitespace preserved  "


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
