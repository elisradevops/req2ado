"""Shared significant-word / grounding-score primitives -- extracted out of
llm_leveling.py so id_tree_builder.py can use the SAME (Unicode-aware)
implementation instead of maintaining its own second copy. Confirmed real
bug this closes: id_tree_builder.py's own copy used an ASCII-only word
pattern, which silently emptied its significant-word set (and therefore
made every grounding_score trivially 1.0) for Hebrew/Arabic/any non-Latin
script content -- exactly the "always 1.0, can't judge, assume fine" failure
mode NEW-04/300541 already fixed once here, but not there. A leaf module
with zero intra-package dependencies, importable from both llm_leveling.py
and id_tree_builder.py without the circular import a direct cross-import
between those two would create."""
from __future__ import annotations

import re

# Common connective/requirement-boilerplate words excluded from the overlap
# calculation so they don't inflate the score for genuinely unrelated
# content that merely happens to also be phrased as a "shall" statement.
_GROUNDING_STOPWORDS = {
    "a", "an", "the", "shall", "system", "is", "are", "of", "to", "and", "or",
    "in", "on", "for", "with", "be", "will", "this", "that", "it", "its",
}
# Unicode word characters (Python 3 `\w` is Unicode-aware by default for
# `str` patterns) -- NOT `[a-z0-9]+` (ASCII-only), which would silently empty
# significant_words() for any non-Latin script (Hebrew, Arabic, ...), making
# grounding_score trivially 1.0 ("can't judge, assume fine") for exactly the
# content that most needs real verification.
_WORD_PATTERN = re.compile(r"\w+", re.UNICODE)


def significant_words(text: str) -> set[str]:
    return {word for word in _WORD_PATTERN.findall(text.lower()) if word not in _GROUNDING_STOPWORDS}


def grounding_score(generated_text: str, source_text: str) -> float:
    """Fraction of the generated text's own significant vocabulary that
    also appears in its source block's text -- precision, not similarity:
    a generated description using mostly words absent from the source
    (invented/unrelated content) scores low regardless of the source's own
    length. 1.0 when the generated text has no significant words at all
    (nothing to be ungrounded about) or when every significant word is
    present in the source."""
    generated_words = significant_words(generated_text)
    if not generated_words:
        return 1.0
    source_words = significant_words(source_text)
    return len(generated_words & source_words) / len(generated_words)
