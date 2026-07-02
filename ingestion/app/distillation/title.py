from __future__ import annotations


def extract_baseline_title(text: str, max_length: int = 256) -> str:
    """BASELINE-mode title extraction: never summarizes or paraphrases, only
    extracts/truncates the existing verbatim text. If the (stripped) text
    already fits within max_length, it is returned unchanged. Otherwise,
    truncates at the last whitespace boundary at or before max_length so
    words aren't split mid-way; if no whitespace exists within the window
    (a single unbroken run of characters), hard-cuts at exactly max_length.

    Operates on Unicode codepoints (Python's native str semantics), so
    multi-codepoint content (e.g. emoji) truncates safely without raising or
    corrupting individual codepoints. Full extended-grapheme-cluster
    awareness (e.g. not splitting an emoji+skin-tone-modifier sequence) is
    out of scope."""
    stripped = text.strip()
    if len(stripped) <= max_length:
        return stripped

    window = stripped[:max_length]
    last_space = window.rfind(" ")
    if last_space == -1:
        return window
    return window[:last_space].rstrip()
