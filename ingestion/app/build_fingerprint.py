# ingestion/app/build_fingerprint.py
"""What this ingestion build is, for caches of whole results: a hash of every source and prompt file of the running `app` package.

The package version (pyproject) changes only on a release, so a result cache keyed on it alone serves the results of the old code
after any code or prompt change that was not released with a version bump (seen 2026-11-20: a SURVEY job replayed a result built
by the previous prompts). The orchestrator puts this, through /cache-scope, into its job-result key."""

from __future__ import annotations

import hashlib
from functools import cache
from pathlib import Path

_APP_DIR = Path(__file__).resolve().parent


@cache
def code_fingerprint() -> str:
    """A hash of the relative path and bytes of every file of the running app package (compiled caches excluded). Computed once per
    process: the files do not change while it runs."""
    digest = hashlib.sha256()
    for path in sorted(p for p in _APP_DIR.rglob("*") if p.is_file()):
        if "__pycache__" in path.parts or path.suffix == ".pyc":
            continue
        digest.update(
            path.relative_to(_APP_DIR).as_posix().encode() + b"\0" + path.read_bytes() + b"\0"
        )
    return digest.hexdigest()
