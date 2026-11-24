"""Counts how a requirements document is structured into items, without printing any of its text: for checking real (sensitive)
documents against the structure rules locally, and sharing only the numbers.

    .venv/bin/python scripts/pdf_structure_counts.py spec.pdf [other.pdf ...] [--json]
    docker compose exec ingestion python scripts/pdf_structure_counts.py /tmp/spec.pdf    # the image ships it at /app/scripts

Runs offline, on this machine: the loader and the BASELINE structure (the same items SURVEY gets; SURVEY only rewrites wording). No model
is called and nothing leaves the machine. The output holds numbers and the document's file name only (pass --no-name to drop the name).

Per file:
  items                      items per type (Epic, Feature, Requirement)
  front_matter_left_out      parts left out as front matter (cover, revision history, contents, ...) and their pages
  informational_kept         descriptive sections (Scope, Purpose, ...) kept as context in their parent, not made Requirements
  requirements_with_id       Requirements that carry a Customer ID
  requirements_with_several_ids
                             Requirements whose text holds more than one distinct requirement code at line starts (a merge)
  numbered_sections          headings that print a section number
  numbered_sections_without_item
                             of those, how many have no item (a lost section)
  contents_like_items        items whose title ends in dot leaders and a page number (a table-of-contents line that became an item)
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.dispatch import dispatch_by_extension  # noqa: E402
from app.leveling.customer_id import leading_requirement_code  # noqa: E402
from app.leveling.document_layout import is_contents_entry  # noqa: E402
from app.leveling.numbering import parse_numbering  # noqa: E402
from app.leveling.tree_builder import build_baseline_tree  # noqa: E402

_CODE_ANYWHERE = re.compile(
    r"(?:^|\n)\s*([A-Z][A-Z0-9]*(?:[-_][A-Z0-9]+)*[-_]?\d{2,8})\s*(?:[:.)\]]|\s[-–—])"
)


def counts_for(path: Path) -> dict:
    doc = dispatch_by_extension(path.name, str(path), languages="eng+heb")
    tree = build_baseline_tree(doc)
    nodes = tree.nodes
    by_type: dict[str, int] = {}
    for node in nodes:
        by_type[node.type.value] = by_type.get(node.type.value, 0) + 1
    requirements = [n for n in nodes if n.type.value == "Requirement"]

    def ids_in(text: str) -> set[str]:
        found = {m for m in _CODE_ANYWHERE.findall(text)}
        code, _rest = leading_requirement_code(text)
        return found | ({code} if code else set())

    left_out = next((w for w in tree.warnings if w.kind.value == "front_matter_left_out"), None)
    kept = next((w for w in tree.warnings if w.kind.value == "informational_section_folded"), None)
    numbered = [
        b
        for b in doc.blocks
        if b.kind.value == "heading"
        and parse_numbering(b.text)[0] is not None
        and not is_contents_entry(b.text)
    ]
    item_titles = [" ".join(n.title.split()).casefold() for n in nodes]
    descriptions = [" ".join(n.description.split()).casefold() for n in nodes]
    without_item = 0
    for heading in numbered:
        text = " ".join(heading.text.split()).casefold()
        if not any(
            title.endswith(text) or text.endswith(title) for title in item_titles if title
        ) and not any(text in d for d in descriptions):
            without_item += 1
    return {
        "items": by_type,
        "front_matter_left_out": {
            "parts": len(left_out.detail.get("parts", [])) if left_out else 0,
            "pages": left_out.detail.get("pages", []) if left_out else [],
            "blocks": len(left_out.detail.get("blockIds", [])) if left_out else 0,
            "tables": len(left_out.detail.get("tableIds", [])) if left_out else 0,
        },
        "informational_kept": len(kept.detail.get("sections", [])) if kept else 0,
        "requirements_with_id": sum(1 for n in requirements if n.customer_id),
        "requirements_with_several_ids": sum(
            1 for n in requirements if len(ids_in(n.description)) > 1
        ),
        "numbered_sections": len(numbered),
        "numbered_sections_without_item": without_item,
        "contents_like_items": sum(1 for n in nodes if is_contents_entry(n.title)),
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("files", nargs="+", type=Path)
    parser.add_argument("--json", action="store_true", help="one JSON object per file")
    parser.add_argument(
        "--no-name", action="store_true", help="label files 1, 2, ... instead of by name"
    )
    args = parser.parse_args()
    for index, path in enumerate(args.files, 1):
        label = str(index) if args.no_name else path.name
        result = {"file": label, **counts_for(path)}
        if args.json:
            print(json.dumps(result, ensure_ascii=False))
            continue
        print(f"== {label}")
        for key, value in result.items():
            if key != "file":
                print(f"  {key}: {value}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
