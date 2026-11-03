from app.leveling.document_overview import overview_facts
from app.leveling.document_study import DocumentStudy


def _study(**kw) -> DocumentStudy:
    return DocumentStudy(windows_studied=2, windows_total=2, **kw)


def test_nothing_read_gives_no_facts() -> None:
    assert overview_facts(None) is None


def test_facts_come_from_the_study_and_nothing_else() -> None:
    study = _study(
        purpose_statements=["This document specifies the tracker interface."],
        glossary=[{"term": "SRU", "definition": "shop replaceable unit"}, {"term": "LRU", "definition": "line unit"}],
        standards_cited=["MIL-STD-704", "VITA 65"],
        verification_statements=["Verified by test.", "Measured at 25 C."],
        placeholder_tokens=["TBD", "N"],
        table_roles=[{"table": "t1", "role": "fan configuration values"}],
    )
    assert overview_facts(study) == {
        "purpose_statements": ["This document specifies the tracker interface."],
        "glossary_terms": 2,
        "standards": ["MIL-STD-704", "VITA 65"],
        "standards_total": 2,
        "verification_statements": 2,
        "placeholder_tokens": ["TBD", "N"],
        "placeholder_tokens_total": 2,
        "table_roles": ["fan configuration values"],
        "windows_studied": 2,
        "windows_total": 2,
    }


def test_long_lists_are_cut_to_a_readable_size_but_counts_stay_true() -> None:
    study = _study(standards_cited=[f"STD-{i}" for i in range(30)], placeholder_tokens=[f"T{i}" for i in range(30)], verification_statements=["x"] * 40)
    facts = overview_facts(study)
    assert len(facts["standards"]) == 8 and len(facts["placeholder_tokens"]) == 8
    assert facts["verification_statements"] == 40
    assert facts["standards_total"] == 30 and facts["placeholder_tokens_total"] == 30


def test_an_empty_study_still_reports_what_it_read() -> None:
    facts = overview_facts(_study())
    assert facts["purpose_statements"] == [] and facts["glossary_terms"] == 0 and facts["windows_studied"] == 2
