"""A document's own requirement-code shape, learned from the document instead of assumed.

Customers write requirement codes in many shapes: ``REQ-001:``, ``SRS-12 -``, ``abc_12`` with no separator in a column beside the
text, ``[PWR042]``. A fixed pattern recognises some and misses the rest (a lowercase code with no separator was never read, so every
Customer ID of a real specification was lost), and it also reads tokens inside the text as codes (a colour standard, a product
number). Instead, the shape is learned:

  * every token that opens a paragraph and is followed by text (a sentence, not a bare list of codes) is a candidate;
  * candidates are grouped by their shape (lowercase letters -> ``a``, capitals -> ``A``, digits -> ``9``, runs collapsed,
    separators kept): ``abc_12`` and ``pwr_4`` share the shape ``a_9``;
  * the shape that opens the most paragraphs, clearly more than any other, is the document's code shape;
  * its pattern is induced from its own instances (each run's observed length range), so only tokens of that shape, at the start
    of a paragraph, are ever read as a code.

The pre-study may confirm the shape with example codes (study/model_rules.py); `CodeShape.from_examples` induces the same pattern
from them. Pure and deterministic: the same text always gives the same shape."""

from __future__ import annotations

import re
from collections import Counter, defaultdict
from collections.abc import Iterable
from dataclasses import dataclass

# A token's characters, classed: lowercase letters, capitals, digits; any other character is kept as itself.
_RUN = re.compile(r"[a-z]+|[A-Z]+|[0-9]+|[^a-zA-Z0-9]")
# What may follow a code before the requirement text: nothing, a colon, a closing bracket or period, or a spaced dash.
_SEPARATOR = r"(?:\s*[:.)\]]|\s+[-–—])?\s+"
# A candidate is followed by at least this many words of text, two of them alphabetic: a requirement, not a list of parent codes.
MIN_WORDS_AFTER = 3
# A shape is the document's code shape when it opens at least this many paragraphs ...
MIN_INSTANCES = 5
# ... with at least this many distinct codes, and at least this many times as often as the next shape.
MIN_DISTINCT = 3
DOMINANCE = 2.0


def token_shape(token: str) -> str:
    """``abc_12`` -> ``a_9``; ``REQ-001`` -> ``A-9``; ``SYS_12.1`` -> ``A_9.9``."""
    out = []
    for run in _RUN.findall(token):
        if run[0].islower():
            out.append("a")
        elif run[0].isupper():
            out.append("A")
        elif run[0].isdigit():
            out.append("9")
        else:
            out.append(run)
    return "".join(out)


def _is_code_like(token: str) -> bool:
    """A requirement code opens with a letter and has digits: not a section number, a value with its unit ("28V") or a plain word."""
    return (
        2 <= len(token) <= 40
        and token[0].isalpha()  # "28V", "5G", "24VDC" are values, not codes
        and any(c.isdigit() for c in token)
        and not re.fullmatch(r"\d+(?:\.\d+)*\.?", token)
    )


def _leading_token(text: str) -> tuple[str, str] | None:
    """(token, rest) for a text that opens with a token followed by a separator and text; the token without its separator."""
    match = re.match(r"\s*(\[?[^\s\[\]():]+\]?)" + _SEPARATOR + r"(\S.*)$", text, re.DOTALL)
    if match is None:
        return None
    return match.group(1).strip("[]"), match.group(2)


def _followed_by_text(rest: str) -> bool:
    words = rest.split()
    return len(words) >= MIN_WORDS_AFTER and sum(1 for w in words[:6] if re.fullmatch(r"[^\W\d_]{2,}[,.;:]?", w)) >= 2


@dataclass(frozen=True)
class CodeShape:
    shape: str  # "a_9": how the code is written, for people
    pattern: str  # the induced regex, matched at the start of a paragraph
    examples: tuple[str, ...]  # a few of the document's own codes

    def leading(self, text: str) -> tuple[str, str] | None:
        """(code, rest) when `text` opens with a code of this shape followed by text; None otherwise."""
        match = re.match(r"\s*\[?(" + self.pattern + r")\]?" + _SEPARATOR + r"(\S.*)$", text, re.DOTALL)
        if match is None:
            return None
        return match.group(1), match.group(2)

    def opens(self, text: str) -> bool:
        return self.leading(text) is not None

    @staticmethod
    def from_examples(codes: Iterable[str]) -> CodeShape | None:
        """The shape and pattern of a set of codes that share one shape; None when they do not."""
        codes = sorted({c for c in codes if _is_code_like(c)})
        shapes = {token_shape(c) for c in codes}
        if not codes or len(shapes) != 1:
            return None
        shape = shapes.pop()
        runs = [_RUN.findall(c) for c in codes]
        parts = []
        for i, sample in enumerate(runs[0]):
            if sample[0].isalnum():
                lengths = [len(r[i]) for r in runs]
                cls = "[a-z]" if sample[0].islower() else "[A-Z]" if sample[0].isupper() else r"\d"
                low, high = min(lengths), max(lengths)
                # Digits vary in width with the count of requirements ("_9" to "_123"): allow one more digit than seen.
                if cls == r"\d":
                    low, high = 1, max(high + 1, 2)
                parts.append(f"{cls}{{{low},{high}}}" if low != high else f"{cls}{{{low}}}")
            else:
                parts.append(re.escape(sample))
        pattern = "".join(parts) + r"(?![\w-])"
        return CodeShape(shape=shape, pattern=pattern, examples=tuple(codes[:5]))


def leading_code_token(text: str) -> str | None:
    """The code-like token a paragraph opens with when text follows it ("abc_12 The unit ..." -> "abc_12"); None otherwise."""
    lead = _leading_token(text)
    if lead is None:
        return None
    token, rest = lead
    return token if _is_code_like(token) and _followed_by_text(rest) else None


def shape_candidates(texts: Iterable[str]) -> list[tuple[str, list[str]]]:
    """(shape, the tokens of that shape in document order) for every code-like token that opens a paragraph, most frequent first."""
    by_shape: dict[str, list[str]] = defaultdict(list)
    for text in texts:
        token = leading_code_token(text)
        if token is not None:
            by_shape[token_shape(token)].append(token)
    ranked = Counter({shape: len(tokens) for shape, tokens in by_shape.items()}).most_common()
    return [(shape, by_shape[shape]) for shape, _count in sorted(ranked, key=lambda kv: (-kv[1], kv[0]))]


def learn_code_shape(texts: Iterable[str]) -> CodeShape | None:
    """The document's requirement-code shape, from the texts of its paragraphs in order; None when no shape clearly dominates."""
    ranked = shape_candidates(texts)
    if not ranked:
        return None
    _best, tokens = ranked[0]
    runner_up = len(ranked[1][1]) if len(ranked) > 1 else 0
    if len(tokens) < MIN_INSTANCES or len(set(tokens)) < MIN_DISTINCT or len(tokens) < DOMINANCE * runner_up:
        return None
    return CodeShape.from_examples(tokens)
