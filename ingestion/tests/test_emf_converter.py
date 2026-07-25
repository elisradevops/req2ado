import subprocess

from app.vision.emf_converter import convert_vector_image_to_png, sniff_vector_image_extension


def _emf_bytes() -> bytes:
    # Real EMF signature (" EMF") lives at a fixed 40-byte header offset,
    # not the start of the file -- pad with arbitrary header bytes before it.
    return b"\x00" * 40 + b" EMF" + b"\x00" * 20


def _placeable_wmf_bytes() -> bytes:
    return b"\xd7\xcd\xc6\x9a" + b"\x00" * 20


def _standard_wmf_bytes() -> bytes:
    return b"\x01\x00\x09\x00" + b"\x00" * 20


def test_sniff_vector_image_extension_detects_emf() -> None:
    assert sniff_vector_image_extension(_emf_bytes()) == ".emf"


def test_sniff_vector_image_extension_detects_placeable_wmf() -> None:
    assert sniff_vector_image_extension(_placeable_wmf_bytes()) == ".wmf"


def test_sniff_vector_image_extension_detects_standard_wmf() -> None:
    assert sniff_vector_image_extension(_standard_wmf_bytes()) == ".wmf"


def test_sniff_vector_image_extension_returns_none_for_a_real_raster_image() -> None:
    assert sniff_vector_image_extension(b"\x89PNG\r\n\x1a\n" + b"\x00" * 40) is None


def test_convert_vector_image_to_png_returns_bytes_on_success(monkeypatch) -> None:
    def fake_run(cmd, capture_output, timeout, check):
        # soffice's real behavior: writes a same-stem .png into --outdir.
        outdir = cmd[cmd.index("--outdir") + 1]
        input_path = cmd[-1]
        stem = input_path.rsplit("/", 1)[-1].rsplit(".", 1)[0]
        with open(f"{outdir}/{stem}.png", "wb") as f:
            f.write(b"fake-png-bytes")
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(subprocess, "run", fake_run)
    result = convert_vector_image_to_png(_emf_bytes(), ".emf")
    assert result == b"fake-png-bytes"


def test_convert_vector_image_to_png_returns_none_when_soffice_missing(monkeypatch) -> None:
    def fake_run(*args, **kwargs):
        raise FileNotFoundError("soffice not found")

    monkeypatch.setattr(subprocess, "run", fake_run)
    assert convert_vector_image_to_png(_emf_bytes(), ".emf") is None


def test_convert_vector_image_to_png_returns_none_on_conversion_failure(monkeypatch) -> None:
    def fake_run(*args, **kwargs):
        raise subprocess.CalledProcessError(1, args)

    monkeypatch.setattr(subprocess, "run", fake_run)
    assert convert_vector_image_to_png(_emf_bytes(), ".emf") is None


def test_convert_vector_image_to_png_returns_none_on_timeout(monkeypatch) -> None:
    def fake_run(*args, **kwargs):
        raise subprocess.TimeoutExpired(cmd="soffice", timeout=60.0)

    monkeypatch.setattr(subprocess, "run", fake_run)
    assert convert_vector_image_to_png(_emf_bytes(), ".emf") is None
