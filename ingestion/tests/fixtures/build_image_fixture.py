"""Run once to (re)generate sample.png: `python build_image_fixture.py`."""
from pathlib import Path

from PIL import Image

out_path = Path(__file__).parent / "sample.png"
Image.new("RGB", (10, 10), color="blue").save(str(out_path), format="PNG")
print(f"wrote {out_path}")
