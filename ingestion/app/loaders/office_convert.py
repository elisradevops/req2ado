# ingestion/app/loaders/office_convert.py
"""A Word 97-2003 file (.doc) read through its .docx equivalent.

.doc is an OLE container nothing here parses, and no Python library reads one with its tables and figures. Rather than a second loader (and
a second set of bugs), the file is converted once by headless LibreOffice, the same way .docx pagination and EMF figures already are
(docx_pagination.py, vision/emf_converter.py), and the converted .docx goes through the loader that already exists. LibreOffice Writer is
already installed for pagination (ingestion/Dockerfile). Excel 97-2003 (.xls) is read by xlrd instead (xls_loader.py): no Calc needed.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

_DEFAULT_TIMEOUT_SECONDS = 180.0
_TIMEOUT_SECONDS = float(os.environ.get("LEGACY_OFFICE_CONVERT_TIMEOUT_SECONDS", _DEFAULT_TIMEOUT_SECONDS))

# A real converted .docx/.xlsx is a ZIP of several parts and never this small: guards against soffice exiting 0 with an empty file.
_MIN_OUTPUT_FILE_BYTES = 512

# Extension to read -> (extension to convert to, LibreOffice export filter). The filter is named so the result does not depend on which
# default LibreOffice picks for the target extension.
LEGACY_CONVERSIONS: dict[str, tuple[str, str]] = {
    ".doc": ("docx", "MS Word 2007 XML"),
}


def convert_legacy_office(src_path: str, extension: str, out_dir: str) -> str | None:
    """Converts `src_path` (a .doc on disk) into `out_dir` and returns the converted file's path, or None on ANY failure (no
    soffice binary, a timeout, a non-zero exit, no or a too-small output). Never raises: the caller decides what a failed conversion means.

    Each call gets its own LibreOffice profile directory: concurrent conversions would otherwise contend on one shared profile lock."""
    target, export_filter = LEGACY_CONVERSIONS[extension]
    try:
        subprocess.run(
            [
                "soffice",
                "--headless",
                f"-env:UserInstallation=file://{Path(out_dir) / 'lo_profile'}",
                "--convert-to",
                f"{target}:{export_filter}",
                "--outdir",
                out_dir,
                src_path,
            ],
            capture_output=True,
            timeout=_TIMEOUT_SECONDS,
            check=True,
        )
    except (subprocess.SubprocessError, OSError):
        return None
    output = Path(out_dir) / f"{Path(src_path).stem}.{target}"
    if not output.exists() or output.stat().st_size < _MIN_OUTPUT_FILE_BYTES:
        return None
    return str(output)
