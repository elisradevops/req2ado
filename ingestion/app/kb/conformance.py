"""Do the items of a job follow the writing rules of the user's knowledge base?

A repeatable report over the Requirements of a job against the rules in the user's KB profile. A rule a program can check
(one statement, no vague terms, the word shall, a measurable value with a unit) is checked by a program on every
Requirement; any other rule is judged by a model on a small sample chosen by a fixed hash order, so the same items are
judged every run. A rule that cannot be checked is reported as not checked, never as passed. Two reports (a job made with
the KB and one without) are compared per rule. The checks are English-language heuristics and say so in the report; they
measure conformance to the stated rules, not the quality of the text.

    python -m app.kb.conformance --profile profile.json --with-kb job-with-kb.json --without-kb job-without-kb.json
where each job file is the job's `dryRunDiff` array and the profile is the JSON of `GET /kb/profile` (its `profile` object)."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from dataclasses import dataclass
from typing import Callable, Protocol

from app.kb.profile import KbProfile

_MODAL = re.compile(r"\b(shall|must|should|will)\b", re.IGNORECASE)
_VAGUE = re.compile(
    r"\b(appropriate|adequate|sufficient|user[- ]friendly|easy|easily|fast|quickly|flexible|robust|as needed|as required|"
    r"if possible|where possible|etc|and/or|tbd|tbc|approximately|about|several|some|many|few|reasonable)\b",
    re.IGNORECASE,
)
_NUMBER_WITH_UNIT = re.compile(r"\d+(?:[.,]\d+)?\s*(?:%|[a-zµΩ°]+\b)", re.IGNORECASE)


@dataclass(frozen=True)
class RuleCheck:
    name: str
    passes: Callable[[str], bool]


_CHECKS: list[tuple[re.Pattern[str], RuleCheck]] = [
    (re.compile(r"\b(one|single|1)\b.*\b(requirement|statement|sentence|shall)\b|\b(requirement|statement)\b.*\bper\b", re.I),
     RuleCheck("single_statement", lambda text: len(_MODAL.findall(text)) <= 1)),
    (re.compile(r"\b(vague|ambigu\w*|subjective|weak words?|unclear terms?)\b", re.I),
     RuleCheck("no_vague_terms", lambda text: _VAGUE.search(text) is None)),
    (re.compile(r"\bshall\b", re.I), RuleCheck("uses_shall", lambda text: re.search(r"\bshall\b", text, re.I) is not None)),
    (re.compile(r"\b(measurable|quantif\w*|numeric\w*|unit)\b", re.I),
     RuleCheck("has_measurable_value", lambda text: _NUMBER_WITH_UNIT.search(text) is not None)),
]


def rule_check_for(rule_text: str) -> RuleCheck | None:
    """The program check for a rule, or None when no program can check it (a model judges a sample instead)."""
    for pattern, check in _CHECKS:
        if pattern.search(rule_text):
            return check
    return None


class ConformanceJudge(Protocol):
    def judge_rule_conformance(self, rule: str, items: dict[str, str], user_id: str | None = None) -> dict[str, bool]: ...


def _sample(items: list[dict], size: int) -> list[dict]:
    """A fixed sample: the items ordered by the hash of their id, so every run judges the same ones."""
    ordered = sorted(items, key=lambda item: hashlib.sha256(str(item["localId"]).encode()).hexdigest())
    return sorted(ordered[:size], key=lambda item: str(item["localId"]))


def conformance_report(items: list[dict], profile: KbProfile, *, judge: ConformanceJudge | None, sample_size: int = 12) -> dict:
    requirements = [i for i in items if str(i.get("type", "")).lower() == "requirement"]
    rules: list[dict] = []
    for rule in profile.rules:
        check = rule_check_for(rule.text)
        entry: dict = {"rule": rule.text, "sources": rule.sources}
        if check is not None:
            failed = [str(i["localId"]) for i in requirements if not check.passes(str(i.get("description", "")))]
            entry |= {"method": "program", "check": check.name, "checked": len(requirements), "passed": len(requirements) - len(failed), "failed_ids": failed}
        elif judge is None or not requirements:
            entry |= {"method": "not checked", "checked": 0, "passed": None, "failed_ids": [], "note": "no program check and no model judge"}
        else:
            sample = _sample(requirements, sample_size)
            try:
                verdicts = judge.judge_rule_conformance(rule.text, {str(i["localId"]): str(i.get("description", "")) for i in sample})
                failed = [item_id for item_id, ok in verdicts.items() if not ok]
                entry |= {"method": "model sample", "checked": len(verdicts), "passed": len(verdicts) - len(failed), "failed_ids": sorted(failed), "sampled_ids": sorted(verdicts)}
            except Exception as exc:  # noqa: BLE001 -- a judge that fails leaves the rule unchecked, never "passed"
                entry |= {"method": "not checked", "checked": 0, "passed": None, "failed_ids": [], "note": f"model judge failed: {' '.join(str(exc).split())[:120]}"}
        rules.append(entry)
    checked = [r for r in rules if r["checked"]]
    total = sum(r["checked"] for r in checked)
    overall = sum(r["passed"] for r in checked) / total if total else None
    return {"items_checked": len(requirements), "rules": rules, "overall_rate": overall}


def _rate(rule: dict) -> float | None:
    return rule["passed"] / rule["checked"] if rule["checked"] else None


def compare_reports(with_kb: dict, without_kb: dict) -> dict:
    """Per rule: the conformance rate of the KB job, of the job without a KB, and the difference."""
    by_rule = {r["rule"]: r for r in without_kb["rules"]}
    rows = []
    for rule in with_kb["rules"]:
        a, b = _rate(rule), _rate(by_rule[rule["rule"]]) if rule["rule"] in by_rule else None
        rows.append({"rule": rule["rule"], "method": rule["method"], "with_kb": a, "without_kb": b, "gain": a - b if a is not None and b is not None else None})
    a, b = with_kb["overall_rate"], without_kb["overall_rate"]
    return {"rules": rows, "overall_with_kb": a, "overall_without_kb": b, "overall_gain": a - b if a is not None and b is not None else None}


def format_markdown(comparison: dict) -> str:
    def pct(value: float | None) -> str:
        return "n/a" if value is None else f"{value * 100:.0f}%"

    lines = ["| Rule | Checked by | With KB | Without KB | Gain |", "|---|---|---:|---:|---:|"]
    for row in comparison["rules"]:
        gain = "n/a" if row["gain"] is None else f"{row['gain'] * 100:+.0f} pts"
        lines.append(f"| {row['rule']} | {row['method']} | {pct(row['with_kb'])} | {pct(row['without_kb'])} | {gain} |")
    overall = "n/a" if comparison["overall_gain"] is None else f"{comparison['overall_gain'] * 100:+.0f} pts"
    lines.append(f"| **All checked rules** | | {pct(comparison['overall_with_kb'])} | {pct(comparison['overall_without_kb'])} | {overall} |")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--profile", required=True)
    parser.add_argument("--with-kb", required=True)
    parser.add_argument("--without-kb", required=True)
    args = parser.parse_args(argv)
    raw = json.load(open(args.profile))
    profile = KbProfile.model_validate(raw.get("profile", raw))
    with_kb = conformance_report(json.load(open(args.with_kb)), profile, judge=None)
    without_kb = conformance_report(json.load(open(args.without_kb)), profile, judge=None)
    print(format_markdown(compare_reports(with_kb, without_kb)))
    print("\nRules no program can check are listed as 'not checked' here; pass a model judge in code to sample them.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
