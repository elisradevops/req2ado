from io import BytesIO
from pathlib import Path

from PIL import Image

from app.canonical.model import BlockKind
from app.loaders.image_loader import load_image


def _write_png(tmp_path: Path, name: str = "sample.png") -> str:
    path = tmp_path / name
    Image.new("RGB", (10, 10), color="blue").save(str(path), format="PNG")
    return str(path)


def test_load_image_produces_one_figure_block(tmp_path: Path) -> None:
    doc = load_image(_write_png(tmp_path))
    assert len(doc.blocks) == 1
    assert doc.blocks[0].kind == BlockKind.FIGURE
    assert doc.blocks[0].text == "[FIGURE: none]"
    assert len(doc.figures) == 1
    assert doc.figures[0].caption is None


def test_load_image_format_is_image(tmp_path: Path) -> None:
    doc = load_image(_write_png(tmp_path))
    assert doc.document.format.value == "image"


def test_load_image_calls_describe_figure_and_uses_its_caption(tmp_path: Path) -> None:
    calls = []

    def fake_describe_figure(image_bytes: bytes) -> str:
        calls.append(image_bytes)
        return "a blue square"

    doc = load_image(_write_png(tmp_path), describe_figure=fake_describe_figure)
    assert doc.blocks[0].text == "[FIGURE: a blue square]"
    assert doc.figures[0].caption == "a blue square"
    assert len(calls) == 1


def test_load_image_degrades_to_placeholder_when_describe_figure_raises(tmp_path: Path) -> None:
    def failing_describe_figure(image_bytes: bytes) -> str:
        raise RuntimeError("vision endpoint unreachable")

    doc = load_image(_write_png(tmp_path), describe_figure=failing_describe_figure)
    assert doc.blocks[0].text == "[FIGURE: none]"
    assert doc.figures[0].caption is None
