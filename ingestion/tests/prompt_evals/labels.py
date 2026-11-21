"""Human labels the scoring and duplicate-judging prompts are measured against. Synthetic items, written to cover the cases the review named.

STATUS: DRAFT -- written by the assistant, not yet confirmed by the owner or a reviewer. A label is only ground truth once `CONFIRMED` is True;
until then the report marks these cases as measured against draft labels."""

from __future__ import annotations

CONFIRMED = False

# (id, text, lowest acceptable score, highest acceptable score, why)
SCORE_LABELS: list[tuple[str, str, int, int, str]] = [
    (
        "good",
        "The power supply shall deliver 28 VDC ±0.5 V at loads from 0 A to 10 A, verified by test per ATP section 4.2.",
        70,
        100,
        "complete, measurable, verification stated",
    ),
    ("fragment", 'Size: 3U 1"', 0, 30, "a table cell, not a requirement"),
    (
        "vague",
        "The system shall be user-friendly and fast.",
        0,
        50,
        "vague terms, nothing checkable",
    ),
    ("tbd", "The unit shall operate from a supply voltage of TBD V.", 0, 45, "value not decided"),
    (
        "compound",
        "The unit shall log every fault, send it to the host within 1 s and light the fault LED until reset.",
        20,
        65,
        "three obligations in one",
    ),
    (
        "good_he",
        "היחידה תספק מתח של 28 וולט ישר בטווח עומסים של 0 עד 10 אמפר, ותאומת בבדיקה לפי סעיף 4.2 בנוהל הקבלה.",
        70,
        100,
        "Hebrew, complete and measurable",
    ),
]

# (id, candidate, existing, expected verdict, why)
PAIR_LABELS: list[tuple[str, str, str, str, str]] = [
    (
        "same_fact",
        "The unit shall start within 2 seconds of power-on.",
        "Start-up time after power is applied shall not exceed 2 s.",
        "redundant",
        "same fact, different words",
    ),
    (
        "unit_notation",
        "The output voltage shall be 5 V.",
        "The output shall provide 5.0 VDC.",
        "redundant",
        "same value in another notation",
    ),
    (
        "conflict",
        "Efficiency shall be at least 85% at full load.",
        "Efficiency at full load shall be at least 93%.",
        "contradictory",
        "same parameter, different values",
    ),
    (
        "same_topic",
        "Connector J1 shall have 9 pins.",
        "Connector J1 shall carry RS-422 at 115200 baud.",
        "distinct",
        "same connector, different requirement",
    ),
]

# (id, statement a, statement b, expected same_parameter, expected values_agree, why) -- the within-job conflict judge
# (judge_parameter_pairs). values_agree is None where code compares the values itself and never reads it.
PARAMETER_PAIR_LABELS: list[tuple[str, str, str, str, str | None, str]] = [
    (
        "ac_dc",
        "Input voltage shall be 28 VDC.",
        "Input voltage shall be 28 VAC.",
        "yes",
        None,
        "the same input, AC against DC (code reads both values)",
    ),
    (
        "restated",
        "Input voltage shall be 28 VDC.",
        "The unit shall accept 28 VDC input.",
        "yes",
        None,
        "the same fact said twice",
    ),
    (
        "other_rail",
        "The 5 V rail shall supply at least 2 A.",
        "The 12 V rail shall supply at least 4 A.",
        "no",
        None,
        "the same kind of parameter of a different rail",
    ),
    (
        "colour",
        "The enclosure shall be painted green.",
        "The enclosure shall be painted black.",
        "yes",
        "no",
        "a word value code cannot compare",
    ),
    (
        "hebrew_input",
        "מתח הכניסה של היחידה יהיה 28 וולט.",
        "היחידה תפעל במתח כניסה של 24 וולט.",
        "yes",
        None,
        "the same input voltage, Hebrew",
    ),
]
