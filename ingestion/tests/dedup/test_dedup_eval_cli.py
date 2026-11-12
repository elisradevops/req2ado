import json
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "dedup_eval.py"


def run(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True, check=False)


def test_the_script_prints_where_the_current_threshold_stands_and_the_best_one(tmp_path) -> None:
    path = tmp_path / "pairs.jsonl"
    rows = [{"score": 0.97, "label": 1, "lang": "en"}, {"score": 0.85, "label": 0, "lang": "en"}, {"score": 0.6, "label": 1, "lang": "he"}, {"score": 0.3, "label": 0, "lang": "he"}]
    path.write_text("\n".join(json.dumps(row) for row in rows), encoding="utf-8")

    result = run(str(path), "--threshold", "0.90")

    assert result.returncode == 0
    assert "In use today" in result.stdout and "Best by F0.5" in result.stdout
    assert "he (in use)" in result.stdout


def test_the_script_says_what_is_wrong_with_the_file_and_exits_non_zero(tmp_path) -> None:
    path = tmp_path / "pairs.jsonl"
    path.write_text(json.dumps({"label": 1}) + "\n", encoding="utf-8")

    result = run(str(path))

    assert result.returncode == 2
    assert "line 1" in result.stderr
