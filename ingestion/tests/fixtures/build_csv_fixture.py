"""Run once to (re)generate sample.csv: `python build_csv_fixture.py`."""
from pathlib import Path

out_path = Path(__file__).parent / "sample.csv"
out_path.write_text("Component,Voltage,Current (A)\r\nFPGA,3.3V,2.5\r\nCPU,5V,4.0\r\n", encoding="utf-8")
print(f"wrote {out_path}")
