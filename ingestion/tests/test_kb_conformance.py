"""Do generated items follow the rules of the user's knowledge base? A repeatable report: rules a program can check are
checked by a program, the rest by a small, deterministic sample judged by a model."""
from __future__ import annotations

import json

import pytest

from app.kb.conformance import compare_reports, conformance_report, format_markdown, main, rule_check_for
from app.kb.profile import KbProfile, Rule

GOOD = {"localId": "n1", "type": "Requirement", "title": "Lock", "description": "The receiver shall acquire a lock within 5 ms."}
TWO = {"localId": "n2", "type": "Requirement", "title": "Two", "description": "The receiver shall lock and the receiver shall report status."}
VAGUE = {"localId": "n3", "type": "Requirement", "title": "Fast", "description": "The receiver shall lock as fast as appropriate and be user-friendly."}
EPIC = {"localId": "e1", "type": "Epic", "title": "Receiver", "description": "Everything about the receiver."}


def _profile(*rules: str) -> KbProfile:
    return KbProfile(version="v", built_with="m", rules=[Rule(text=r, sources=["HowTo.pptx"]) for r in rules])


class _Judge:
    def __init__(self, passes: bool = True) -> None:
        self.calls: list[tuple[str, list[str]]] = []
        self._passes = passes

    def judge_rule_conformance(self, rule: str, items: dict[str, str], user_id: str | None = None) -> dict[str, bool]:
        self.calls.append((rule, sorted(items)))
        return {item_id: self._passes for item_id in items}


@pytest.mark.parametrize(
    "rule,expected",
    [
        ("One requirement per statement", "single_statement"),
        ("Each requirement must be a single sentence with one shall", "single_statement"),
        ("Avoid vague terms such as 'appropriate' and 'user-friendly'", "no_vague_terms"),
        ("Requirements are written with the word shall", "uses_shall"),
        ("A requirement states a measurable value with a unit", "has_measurable_value"),
        ("Use the customer's own vocabulary", None),
    ],
)
def test_rules_a_program_can_check_are_recognised_and_the_rest_are_not(rule: str, expected: str | None) -> None:
    check = rule_check_for(rule)
    assert (check.name if check else None) == expected


def test_each_checker_judges_a_requirement_the_way_its_rule_says() -> None:
    single = rule_check_for("One requirement per statement")
    assert single.passes(GOOD["description"]) and not single.passes(TWO["description"])
    vague = rule_check_for("Avoid vague terms")
    assert vague.passes(GOOD["description"]) and not vague.passes(VAGUE["description"])
    shall = rule_check_for("Use shall")
    assert shall.passes(GOOD["description"]) and not shall.passes("The receiver locks.")
    measurable = rule_check_for("State a measurable value with a unit")
    assert measurable.passes(GOOD["description"]) and not measurable.passes("The receiver shall lock quickly.")


def test_the_report_counts_per_rule_over_requirements_only_and_lists_the_failures() -> None:
    report = conformance_report([GOOD, TWO, VAGUE, EPIC], _profile("One requirement per statement", "Avoid vague terms"), judge=None)

    assert report["items_checked"] == 3  # the Epic is not a requirement
    single, vague = report["rules"]
    assert (single["checked"], single["passed"], single["method"]) == (3, 2, "program")
    assert single["failed_ids"] == ["n2"]
    assert (vague["checked"], vague["passed"]) == (3, 2) and vague["failed_ids"] == ["n3"]
    assert 0 < report["overall_rate"] < 1


def test_rules_no_program_can_check_go_to_a_small_deterministic_sample_for_the_model() -> None:
    items = [{"localId": f"n{i}", "type": "Requirement", "title": "t", "description": f"The receiver shall do thing {i} within 5 ms."} for i in range(40)]
    judge = _Judge(passes=False)
    first = conformance_report(items, _profile("Use the customer's own vocabulary"), judge=judge, sample_size=8)
    second = conformance_report(items, _profile("Use the customer's own vocabulary"), judge=_Judge(), sample_size=8)

    rule = first["rules"][0]
    assert rule["method"] == "model sample" and rule["checked"] == 8 and rule["passed"] == 0
    assert len(judge.calls) == 1 and len(judge.calls[0][1]) == 8
    assert first["rules"][0]["sampled_ids"] == second["rules"][0]["sampled_ids"]  # the same items every run


def test_without_a_judge_the_model_rules_are_reported_as_not_checked_never_as_passed() -> None:
    report = conformance_report([GOOD], _profile("Use the customer's own vocabulary"), judge=None)
    rule = report["rules"][0]
    assert rule["method"] == "not checked" and rule["checked"] == 0 and rule["passed"] is None


def test_a_failing_judge_is_reported_not_raised() -> None:
    class Broken:
        def judge_rule_conformance(self, rule, items, user_id=None):
            raise RuntimeError("model down")

    rule = conformance_report([GOOD], _profile("Use the customer's own vocabulary"), judge=Broken())["rules"][0]
    assert rule["method"] == "not checked" and "model down" in rule["note"]


def test_comparing_a_kb_job_with_a_job_without_one_shows_the_gain_per_rule() -> None:
    profile = _profile("One requirement per statement", "Avoid vague terms")
    with_kb = conformance_report([GOOD, GOOD | {"localId": "n9"}], profile, judge=None)
    without = conformance_report([GOOD, TWO, VAGUE], profile, judge=None)
    comparison = compare_reports(with_kb, without)
    single = next(r for r in comparison["rules"] if r["rule"].startswith("One requirement"))
    assert single["with_kb"] == 1.0 and single["without_kb"] == pytest.approx(2 / 3) and single["gain"] > 0
    assert comparison["overall_gain"] > 0
    assert "One requirement per statement" in format_markdown(comparison)


def test_the_command_line_tool_reads_job_exports_and_a_profile_and_prints_the_comparison(tmp_path, capsys) -> None:
    (tmp_path / "with.json").write_text(json.dumps([GOOD, EPIC]))
    (tmp_path / "without.json").write_text(json.dumps([TWO, VAGUE]))
    profile = _profile("One requirement per statement")
    (tmp_path / "profile.json").write_text(profile.model_dump_json())

    code = main(["--profile", str(tmp_path / "profile.json"), "--with-kb", str(tmp_path / "with.json"), "--without-kb", str(tmp_path / "without.json")])

    assert code == 0
    out = capsys.readouterr().out
    assert "One requirement per statement" in out and "gain" in out.lower()
