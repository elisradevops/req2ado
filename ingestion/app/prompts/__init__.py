# ingestion/app/prompts/__init__.py
"""Prompt-as-code (S7) -- SURVEY's LLM prompts used to be inline Python
string literals scattered across ~13 methods in
app.survey.orchestrator_llm_client, unversioned, un-diffable as a unit, with
no way to see "what did this prompt say 3 commits ago" without hunting
through git blame on unrelated code. Each is now a plain .txt file under
this directory, one prompt per file, loaded once and cached.

Versioning convention: `<name>.v<N>.txt`. A prompt CHANGE that alters model
behavior bumps N (new file, old one kept for history/rollback); a version
bump is a deliberate, reviewable diff on its own, not buried inside a larger
code change. `load_prompt` always loads the HIGHEST N present for a given
name unless a specific version is requested -- callers don't need to know
the current version number to stay current.

Dynamic prompts (a handful embed a runtime value, e.g. infer_trace_links'
catalog_lines) use a `__MARKER__`-style placeholder + str.replace(), the
SAME convention llm_leveling.py's own _section_analysis_system_prompt
already established for _SECTION_ANALYSIS_SYSTEM_PROMPT's
__ROOT_COUNT_CLAUSE__ -- deliberately NOT str.format(), because several of
these prompts instruct the model to emit JSON and therefore contain literal
`{`/`}` characters (e.g. a `{"nodes": [...]}` shape example) that
str.format() would try to parse as its own placeholder syntax and crash on.
Marker-replace has no such collision risk regardless of what a prompt's
own literal content contains.
"""
from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path

_PROMPTS_DIR = Path(__file__).parent
_VERSION_PATTERN = re.compile(r"^(?P<name>.+)\.v(?P<version>\d+)\.txt$")


@lru_cache(maxsize=None)
def _latest_version(name: str) -> int:
    versions = [
        int(m.group("version"))
        for path in _PROMPTS_DIR.glob(f"{name}.v*.txt")
        if (m := _VERSION_PATTERN.match(path.name)) and m.group("name") == name
    ]
    if not versions:
        raise FileNotFoundError(f"No prompt file found for {name!r} under {_PROMPTS_DIR}")
    return max(versions)


@lru_cache(maxsize=None)
def _read(name: str, version: int) -> str:
    path = _PROMPTS_DIR / f"{name}.v{version}.txt"
    return path.read_text(encoding="utf-8").rstrip("\n")


def load_prompt(name: str, version: int | None = None, **markers: str) -> str:
    """Loads `<name>.v<version>.txt` (highest version present if `version`
    is omitted). Each `markers` keyword `foo="bar"` replaces the literal
    `__FOO__` placeholder in the loaded text with `"bar"` -- a static
    prompt (no placeholders) is called with no kwargs and returned
    verbatim. Raises if a marker is passed but its `__NAME__` placeholder
    isn't actually present in the file (a real, catchable programming
    error -- a silently-ignored substitution would be worse)."""
    resolved_version = version if version is not None else _latest_version(name)
    text = _read(name, resolved_version)
    for key, value in markers.items():
        placeholder = f"__{key.upper()}__"
        if placeholder not in text:
            raise ValueError(f"Prompt {name!r} has no {placeholder!r} placeholder to fill with marker {key!r}")
        text = text.replace(placeholder, value)
    return text
