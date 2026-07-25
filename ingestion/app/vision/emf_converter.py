from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

_CONVERT_TIMEOUT_SECONDS = 60.0

# EMF's format signature: a fixed 4-byte ASCII marker at a fixed header
# offset (not the very start of the file, unlike most formats).
_EMF_SIGNATURE_OFFSET = 40
_EMF_SIGNATURE = b" EMF"
# WMF has two variants: an optional 22-byte "placeable" wrapper with its own
# magic number, or the bare header starting directly with mtType (1 or 2)
# followed by mtHeaderSize (always 9 for a valid WMF).
_WMF_PLACEABLE_SIGNATURE = b"\xd7\xcd\xc6\x9a"
_WMF_STANDARD_SIGNATURES = (b"\x01\x00\x09\x00", b"\x02\x00\x09\x00")


def sniff_vector_image_extension(image_bytes: bytes) -> str | None:
    """Detects the two vector-metafile formats Word commonly embeds when a
    diagram is pasted in from Visio/PowerPoint/Draw -- these are NOT raster
    images (see main.py's _sniff_image_mime_type docstring for why that sniff
    can't identify them), so the vision endpoint can never describe them
    as-is regardless of what mimeType label is sent. Returns a real file
    EXTENSION, not a mime type, because soffice's headless conversion picks
    its import filter from the input file's extension, not its content -- an
    accurate extension here is what makes conversion actually work. None for
    any other/unrecognized format (nothing to convert)."""
    if (
        len(image_bytes) >= _EMF_SIGNATURE_OFFSET + 4
        and image_bytes[_EMF_SIGNATURE_OFFSET : _EMF_SIGNATURE_OFFSET + 4] == _EMF_SIGNATURE
    ):
        return ".emf"
    if image_bytes.startswith(_WMF_PLACEABLE_SIGNATURE) or image_bytes.startswith(_WMF_STANDARD_SIGNATURES):
        return ".wmf"
    return None


def convert_vector_image_to_png(image_bytes: bytes, extension: str) -> bytes | None:
    """Converts an EMF/WMF vector metafile to PNG via headless LibreOffice
    (see Dockerfile's libreoffice-draw comment for why -- Pillow has no
    built-in EMF/WMF support). Returns None on any failure (missing soffice
    binary, corrupt input, conversion timeout) -- a vision-description
    failure for one figure must never abort the whole document, same
    graceful-degradation contract as every other describe_figure caller."""
    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            input_path = Path(tmpdir) / f"figure{extension}"
            input_path.write_bytes(image_bytes)
            subprocess.run(
                ["soffice", "--headless", "--convert-to", "png", "--outdir", tmpdir, str(input_path)],
                capture_output=True,
                timeout=_CONVERT_TIMEOUT_SECONDS,
                check=True,
            )
            output_path = input_path.with_suffix(".png")
            return output_path.read_bytes() if output_path.exists() else None
    except (subprocess.SubprocessError, OSError):
        return None
