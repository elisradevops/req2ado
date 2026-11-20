"""A scripted stand-in for the model that studies a file's conventions: it recognises each accuracy variant by its heading row (or its labels) and answers
with the rulebook a good model would give. `noisy` makes it vary everything that does not change the meaning (key order, spacing and case of copied
headings, evidence, a value mapped "unknown" where "not_imported" says the same), the way production samples differ from run to run."""

from __future__ import annotations

import random

TABLE_ANSWERS: dict[tuple[str, ...], dict] = {
    ("מזהה", "סוג פריט", "כותרת", "תיאור", "עדיפות"): {
        "sheet_kind": "work_items",
        "header_row": 0,
        "columns": [
            {"column": 0, "header": "מזהה", "role": "customer_id", "level": None},
            {"column": 1, "header": "סוג פריט", "role": "type", "level": None},
            {"column": 2, "header": "כותרת", "role": "title", "level": None},
            {"column": 3, "header": "תיאור", "role": "description", "level": None},
            {"column": 4, "header": "עדיפות", "role": "metadata", "level": None},
        ],
        "nesting": "row_order",
        "type_values": [
            {"value": "אפיק", "maps_to": "Epic", "basis": "translation"},
            {"value": "פיצ'ר", "maps_to": "Feature", "basis": "translation"},
            {"value": "דרישה", "maps_to": "Requirement", "basis": "translation"},
            {"value": "באג", "maps_to": "not_imported", "basis": "none"},
        ],
        "level_types": [],
        "evidence_rows": [1, 2, 3],
    },
    ("Level", "Name", "Details"): {
        "sheet_kind": "work_items",
        "header_row": 0,
        "columns": [
            {"column": 0, "header": "Level", "role": "level_number", "level": None},
            {"column": 1, "header": "Name", "role": "title", "level": None},
            {"column": 2, "header": "Details", "role": "description", "level": None},
        ],
        "nesting": "level_number",
        "type_values": [],
        "level_types": [
            {"level": 1, "maps_to": "Epic"},
            {"level": 2, "maps_to": "Feature"},
            {"level": 3, "maps_to": "Requirement"},
        ],
        "evidence_rows": [1, 2, 3],
    },
    ("Key", "Parent", "Summary", "Kind", "Text"): {
        "sheet_kind": "work_items",
        "header_row": 0,
        "columns": [
            {"column": 0, "header": "Key", "role": "id", "level": None},
            {"column": 1, "header": "Parent", "role": "parent_id", "level": None},
            {"column": 2, "header": "Summary", "role": "title", "level": None},
            {"column": 3, "header": "Kind", "role": "type", "level": None},
            {"column": 4, "header": "Text", "role": "description", "level": None},
        ],
        "nesting": "id_parent",
        "type_values": [
            {"value": "Area", "maps_to": "Epic", "basis": "hierarchy_position"},
            {"value": "Group", "maps_to": "Feature", "basis": "hierarchy_position"},
            {"value": "Item", "maps_to": "Requirement", "basis": "hierarchy_position"},
            {"value": "Check", "maps_to": "not_imported", "basis": "none"},
        ],
        "level_types": [],
        "evidence_rows": [1, 2, 7],
    },
    ("Outline", "Name", "Details"): {
        "sheet_kind": "work_items",
        "header_row": 0,
        "columns": [
            {"column": 0, "header": "Outline", "role": "outline_number", "level": None},
            {"column": 1, "header": "Name", "role": "title", "level": None},
            {"column": 2, "header": "Details", "role": "description", "level": None},
        ],
        "nesting": "outline_number",
        "type_values": [],
        "level_types": [
            {"level": 1, "maps_to": "Epic"},
            {"level": 2, "maps_to": "Feature"},
            {"level": 3, "maps_to": "Requirement"},
        ],
        "evidence_rows": [1, 2, 3],
    },
}

DOCUMENT_ANSWER = {
    "type_source": "labels",
    "labels": [
        {"label": "אפיק", "separator": ":", "maps_to": "Epic", "basis": "translation", "example_headings": [0]},
        {"label": "יכולת", "separator": ":", "maps_to": "Feature", "basis": "hierarchy_position", "example_headings": [1]},
        {"label": "דרישה", "separator": ":", "maps_to": "Requirement", "basis": "translation", "example_headings": [2]},
    ],
    "depth_types": [],
    "evidence_headings": [0, 1, 2],
}


class FakeStudyClient:
    """Answers like a good model; `noisy` varies what does not matter; `dissent` lets chosen votes answer differently."""

    def __init__(self, noisy: bool = False, seed: int = 0, dissent: dict[int, callable] | None = None, fail: Exception | None = None) -> None:
        self.noisy, self.random, self.dissent, self.fail = noisy, random.Random(seed), dissent or {}, fail
        self.calls: list[tuple[str, int]] = []

    def _vary(self, answer: dict) -> dict:
        import copy

        answer = copy.deepcopy(answer)
        self.random.shuffle(answer.get("columns", []))
        self.random.shuffle(answer.get("type_values", []))
        self.random.shuffle(answer.get("labels", []))
        for column in answer.get("columns", []):
            column["header"] = self.random.choice([column["header"], f"  {column['header']} ", column["header"].upper()])
        for item in answer.get("type_values", []):
            item["value"] = self.random.choice([item["value"], f" {item['value']}", item["value"].upper()])
            if item["maps_to"] == "not_imported":
                item["maps_to"] = self.random.choice(["not_imported", "unknown"])
            item["basis"] = self.random.choice(["same_name", "translation", "hierarchy_position", "none"])
        answer["evidence_rows"] = self.random.sample(answer.get("evidence_rows", []), len(answer.get("evidence_rows", [])))
        return dict(reversed(list(answer.items())))

    def study_file_rules_table(self, sample: dict, user_id: str | None = None, vote: int = 0, accept=None) -> dict:  # noqa: ANN001
        self.calls.append(("table", vote))
        if self.fail:
            raise self.fail
        headings = tuple(sample["rows"][0]["cells"])
        answer = TABLE_ANSWERS[headings]
        if vote in self.dissent:
            answer = self.dissent[vote](answer)
        return self._vary(answer) if self.noisy else answer

    def study_file_rules_document(self, sample: dict, user_id: str | None = None, vote: int = 0, accept=None) -> dict:  # noqa: ANN001
        self.calls.append(("document", vote))
        if self.fail:
            raise self.fail
        return self._vary(DOCUMENT_ANSWER) if self.noisy else DOCUMENT_ANSWER
