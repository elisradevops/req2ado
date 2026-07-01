"""Run once to (re)generate sample.xlsx: `python build_xlsx_fixture.py`."""
from pathlib import Path

from openpyxl import Workbook

wb = Workbook()
ws = wb.active
ws.title = "PowerBudget"
ws.append(["Component", "Voltage", "Current (A)"])
ws.append(["FPGA", "3.3V", "2.5"])
ws.append(["CPU", "5V", "4.0"])

ws2 = wb.create_sheet("AddressMap")
ws2.append(["Address", "Register"])
ws2.append(["0x0000", "CTRL"])

out_path = Path(__file__).parent / "sample.xlsx"
wb.save(str(out_path))
print(f"wrote {out_path}")
