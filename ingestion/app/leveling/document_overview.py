"""The facts of the document overview, taken from the document study and nothing else.

The study is extractive: every entry is copied from the document and checked against the text it came from. So an overview built from these
facts (the purpose sentences it quotes, how many terms it defines, which standards it cites, which values it leaves unresolved) can state only
what the document itself states. No model writes any of this text."""
from __future__ import annotations

from app.leveling.document_study import DocumentStudy

_MAX_LISTED = 8  # standards and markers shown by name; the totals stay true however long the lists are
_MAX_TABLE_ROLES = 5


def overview_facts(study: DocumentStudy | None) -> dict | None:
    """None when the study read nothing (the caller then shows no overview rather than an invented one)."""
    if study is None:
        return None
    return {
        "purpose_statements": list(study.purpose_statements),
        "glossary_terms": len(study.glossary),
        "standards": list(study.standards_cited[:_MAX_LISTED]),
        "standards_total": len(study.standards_cited),
        "verification_statements": len(study.verification_statements),
        "placeholder_tokens": list(study.placeholder_tokens[:_MAX_LISTED]),
        "placeholder_tokens_total": len(study.placeholder_tokens),
        "table_roles": [r["role"] for r in study.table_roles[:_MAX_TABLE_ROLES]],
        "windows_studied": study.windows_studied,
        "windows_total": study.windows_total,
    }
