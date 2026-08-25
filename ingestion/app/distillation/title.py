from __future__ import annotations

import re

# Matches whitespace immediately after a sentence-ending punctuation mark
# (. ! ?) -- used to take just the FIRST sentence as a title candidate
# instead of the whole (possibly multi-sentence) text. Deliberately NOT a
# naive `.split(". ")`: that breaks on decimals like "3.3V" mid-sentence --
# this pattern only fires on whitespace immediately following the
# punctuation, so "3.3V shall..." (no space after the first '.') is never
# treated as a sentence boundary. A real WHITESPACE-FOLLOWED abbreviation
# ("e.g. PDF...") still matches this pattern -- _ABBREVIATIONS below is the
# second-stage filter that rejects those specific false-positive boundaries.
_SENTENCE_END_PATTERN = re.compile(r"(?<=[.!?])\s+")

# Common abbreviations whose trailing period is followed by whitespace but
# is NOT a real sentence boundary -- lowercased, including the trailing
# period, matched against the token immediately preceding a candidate split
# point. Deliberately a small, well-known set (not an exhaustive NLP
# sentence-tokenizer) -- good enough to avoid the real false positives this
# module's requirement-document content actually produces ("e.g.", "i.e.",
# "etc.") without over-engineering a full abbreviation dictionary.
_ABBREVIATIONS = {
    "e.g.", "i.e.", "etc.", "vs.", "approx.", "fig.", "eq.", "no.",
    "mr.", "mrs.", "ms.", "dr.", "st.", "cf.", "pp.", "al.",
}


def _first_sentence(text: str) -> str:
    """Returns the text up to and including the first REAL sentence-ending
    boundary (rejecting a whitespace-followed abbreviation like "e.g. "),
    or the whole text if no real boundary is found."""
    for match in _SENTENCE_END_PATTERN.finditer(text):
        boundary = match.start()
        preceding_tokens = text[:boundary].split()
        preceding_word = preceding_tokens[-1].lower() if preceding_tokens else ""
        if preceding_word in _ABBREVIATIONS:
            continue
        return text[:boundary]
    return text


def extract_baseline_title(text: str, max_length: int = 256) -> str:
    """BASELINE-mode title extraction: never summarizes or paraphrases, only
    extracts/truncates the existing verbatim text. Takes the FIRST SENTENCE
    of the (stripped) text as the title candidate when one is detectable
    (see _SENTENCE_END_PATTERN) -- e.g. a multi-sentence requirement's title
    is just its first sentence, not the whole paragraph. Falls back to the
    whole stripped text when no sentence boundary is found (single-sentence
    or unpunctuated text -- unchanged from before this rule existed).

    If the candidate (first sentence, or whole text when no boundary
    exists) already fits within max_length, it is returned unchanged.
    Otherwise, truncates the CANDIDATE at the last whitespace boundary at
    or before max_length so words aren't split mid-way; if no whitespace
    exists within the window (a single unbroken run of characters),
    hard-cuts at exactly max_length.

    Operates on Unicode codepoints (Python's native str semantics), so
    multi-codepoint content (e.g. emoji) truncates safely without raising or
    corrupting individual codepoints. Full extended-grapheme-cluster
    awareness (e.g. not splitting an emoji+skin-tone-modifier sequence) is
    out of scope.

    Deliberately does NOT attempt "use a summary when the first sentence is
    unsuitable" -- that requires judgment a pure, deterministic function
    can't make (and would need an LLM call, which BASELINE mode's
    verbatim/no-LLM guarantee rules out). Out of scope by design, not an
    oversight -- see title_is_low_quality/distill_survey_title for that
    judgment-based half, wired into SURVEY mode only (300553)."""
    stripped = text.strip()
    candidate = _first_sentence(stripped) if stripped else stripped

    if len(candidate) <= max_length:
        return candidate

    window = candidate[:max_length]
    last_space = window.rfind(" ")
    if last_space == -1:
        return window
    return window[:last_space].rstrip()


# Deliberately small and literal, not a general "is this a good title"
# judgment (that needs an LLM -- see survey_title.py's TitleDistillationClient)
# -- just the small set of placeholder/generic labels a structure-analysis
# pass can plausibly emit when a section gives it nothing more specific to
# name a node with (e.g. an untitled table row, a bare "3." heading).
# Casefold-compared, so "Requirement", "REQUIREMENT", "requirement " all match.
_GENERIC_TITLE_LABELS = {
    "requirement", "item", "section", "untitled", "unnamed", "unknown", "n/a", "tbd",
}
# A title this short (after stripping) carries essentially no information for
# a reviewer to recognize the item by, regardless of whether it happens to
# match a literal label above -- e.g. "Item 3", "TBD.", a bare number.
_MIN_MEANINGFUL_TITLE_LENGTH = 8


def title_is_low_quality(title: str) -> bool:
    """SURVEY-mode smart-title fallback (300553) gate: True when `title` is
    too generic/short to be worth keeping as-is, so a caller should replace
    it with a real distillation call (see distill_survey_title) once the
    node's actual description text exists to distill FROM. Deliberately
    conservative -- false negatives (a mediocre-but-specific title kept
    as-is) are fine; false positives (rewriting a perfectly good short title)
    waste an LLM call and risk drifting from the source wording for no
    reason."""
    stripped = title.strip()
    if len(stripped) < _MIN_MEANINGFUL_TITLE_LENGTH:
        return True
    return stripped.casefold().rstrip(".") in _GENERIC_TITLE_LABELS
