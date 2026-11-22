"""The output-language policy of a job: which script its source is written in, and how its requirements state an obligation.

Code decides the language, never the model. A text's script is read from its words (a run of letters), each word counted once for the
script most of its letters belong to (the Unicode character name's first word: LATIN, HEBREW, ARABIC, CYRILLIC, ...). A word written all
in capitals in a cased script is an acronym or an identifier ("TBD", "VDC") and is not counted, so the Latin identifiers and units that
technical documents carry in any language do not decide it.

The obligation form (how a requirement says something is mandatory) is never hard-coded either. It is the organization's own, from its
knowledge-base profile (`KbProfile.obligation_forms`), and only when the profile states none, the source document's own (a short
verbatim sample read by the model, see `obligation_sample`). Both are text someone else wrote, so prompts carry them only in a data
block (app.prompts.assembly), never in their instructions."""

from __future__ import annotations

import logging
import re
import unicodedata
from collections import Counter
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

from app.job_cancel import JobCancelled

if TYPE_CHECKING:
    from app.canonical.model import CanonicalDoc

logger = logging.getLogger(__name__)

_WORD = re.compile(r"[^\W\d_]+")
# The document sample the obligation-form call reads: body text only, enough sentences to show how the document states an obligation.
OBLIGATION_SAMPLE_MAX_CHARS = 4_000
_SAMPLE_MIN_WORDS = 6
OBLIGATION_FORM_MAX_CHARS = 120
OBLIGATION_FORMS_MAX = 3


def _letter_script(char: str) -> str:
    return unicodedata.name(char, "UNKNOWN").split(" ", 1)[0]


def _word_script(word: str) -> str | None:
    """The script most of the word's letters are written in, or None for a word that does not count (one letter, or an acronym)."""
    if len(word) < 2 or (word.isupper() and word.lower() != word):
        return None
    counts = Counter(_letter_script(c) for c in word)
    return max(counts.items(), key=lambda kv: (kv[1], kv[0]))[0]


def _scripts(text: str, skip: frozenset[str] = frozenset()) -> Counter[str]:
    counts: Counter[str] = Counter()
    for word in _WORD.findall(text or ""):
        if word.casefold() in skip:
            continue
        script = _word_script(word)
        if script is not None:
            counts[script] += 1
    return counts


def dominant_script(text: str) -> str | None:
    """The script most of the text's counted words are written in; None when it has none (only numbers, symbols or acronyms).
    A tie goes to the script name that sorts last, so the answer never depends on word order."""
    counts = _scripts(text)
    if not counts:
        return None
    return max(counts.items(), key=lambda kv: (kv[1], kv[0]))[0]


def script_name(script: str) -> str:
    """The script as a prompt names it ("HEBREW" -> "Hebrew")."""
    return script.title()


def writes_in_script(output: str, source: str) -> bool:
    """Whether `output` is written in the script of the `source` it was written from. Only the words the output adds count (a word
    copied from the source, such as a name or a term, is the source's own, whatever its script). True when either side has nothing to
    judge by: no counted source words, or no added words."""
    expected = dominant_script(source)
    if expected is None:
        return True
    added = _scripts(output, frozenset(w.casefold() for w in _WORD.findall(source or "")))
    if not added:
        return True
    return max(added.items(), key=lambda kv: (kv[1], kv[0]))[0] == expected


def obligation_sample(texts: Iterable[str]) -> str:
    """The document text the obligation-form call reads: its body sentences (texts of at least _SAMPLE_MIN_WORDS words, in document
    order), up to OBLIGATION_SAMPLE_MAX_CHARS. Deterministic, so the same document always sends the same request."""
    kept: list[str] = []
    size = 0
    for text in texts:
        line = " ".join((text or "").split())
        if len(line.split()) < _SAMPLE_MIN_WORDS:
            continue
        if size + len(line) + 1 > OBLIGATION_SAMPLE_MAX_CHARS:
            break
        kept.append(line)
        size += len(line) + 1
    return "\n".join(kept)


def _squash(text: str) -> str:
    return " ".join((text or "").split()).casefold()


def checked_obligation_forms(raw: object, text: str) -> list[str]:
    """The answer's obligation forms that `text` really contains (whitespace and case aside), each at most OBLIGATION_FORM_MAX_CHARS,
    first spelling of each kept, at most OBLIGATION_FORMS_MAX."""
    if not isinstance(raw, list):
        return []
    squashed = _squash(text)
    kept: list[str] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, str):
            continue
        form = " ".join(item.split())
        key = form.casefold()
        if not form or len(form) > OBLIGATION_FORM_MAX_CHARS or key in seen or key not in squashed:
            continue
        seen.add(key)
        kept.append(form)
        if len(kept) == OBLIGATION_FORMS_MAX:
            break
    return kept


@dataclass(frozen=True)
class LanguagePolicy:
    """`script`: the job's main script (dominant_script over its text), None when it has no words. `obligation_forms`: verbatim text
    that says how a requirement states an obligation, from `forms_from` ("kb": the organization's profile, "document": the source).
    `document_forms`: the document's own forms for the scripts the profile's forms are not written in (empty when the forms are the
    document's already)."""

    script: str | None = None
    obligation_forms: tuple[str, ...] = ()
    forms_from: Literal["kb", "document"] | None = None
    document_forms: tuple[str, ...] = ()

    def forms_for(
        self, script: str | None
    ) -> tuple[tuple[str, ...], Literal["kb", "document"] | None]:
        """The forms a text written in `script` may follow, and where they come from: the main forms written in that script, else the
        document's own in that script, else none (a form in another language cannot be followed in this one). Unfiltered when the
        script is unknown."""
        if script is None:
            return (self.obligation_forms, self.forms_from) if self.obligation_forms else ((), None)
        main = tuple(f for f in self.obligation_forms if dominant_script(f) == script)
        if main:
            return main, self.forms_from
        own = tuple(f for f in self.document_forms if dominant_script(f) == script)
        return (own, "document") if own else ((), None)


_PROSE_KINDS = ("title", "heading", "paragraph", "list_item", "note", "open_tbd")
_SENTENCE_KINDS = ("paragraph", "list_item")


def _read_forms(
    find_forms: Callable[[str], list[str]] | None, sentences: list[str]
) -> tuple[str, ...]:
    """The document's own forms read from `sentences` (find_forms over their obligation_sample); empty when there is nothing to read or the
    read fails: the form is guidance, and without it the prompts still state the language."""
    sample = obligation_sample(sentences)
    if find_forms is None or not sample:
        return ()
    try:
        return tuple(find_forms(sample))
    except JobCancelled:
        raise
    except Exception as error:  # noqa: BLE001 -- see the docstring
        logger.warning(
            "Obligation form could not be read from the document (%s); prompts name the language only",
            type(error).__name__,
        )
        return ()


def policy_for_document(
    doc: CanonicalDoc,
    kb_forms: Sequence[str],
    find_forms: Callable[[str], list[str]] | None,
) -> LanguagePolicy:
    """The job's policy: the script of the document's prose (headings, paragraphs, list items, notes; tables and figures are mostly
    values and labels), and the obligation form from the organization's profile, or when it states none, from the document itself
    (`find_forms` reads obligation_sample of its sentences). When the profile's forms do not cover a script the document's sentences are
    written in, the document's own forms are read from those sentences only. A failed or empty read leaves that form unknown: the prompts
    then name only the language, and nothing guesses a form."""
    script = dominant_script(
        "\n".join(b.text for b in doc.blocks if b.kind in _PROSE_KINDS and b.text)
    )
    sentences = [b.text for b in doc.blocks if b.kind in _SENTENCE_KINDS and b.text]
    if not kb_forms:
        forms = _read_forms(find_forms, sentences)
        return LanguagePolicy(script, forms, "document") if forms else LanguagePolicy(script)
    covered = {dominant_script(form) for form in kb_forms}
    uncovered = [text for text in sentences if dominant_script(text) not in covered]
    return LanguagePolicy(script, tuple(kb_forms), "kb", _read_forms(find_forms, uncovered))
