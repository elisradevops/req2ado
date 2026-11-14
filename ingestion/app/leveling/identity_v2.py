"""W1 content-aware identity (identity_hash_v2) and per-node content hash.

identity_hash (v1) is the node's position in the file (document_path + offsets), so a follow-up file matched by position: an edited
requirement kept its hash and was silently reused, while an unchanged one after an inserted paragraph, or in a renamed file, got a new
hash and was created again. v2 identifies a node by what it is instead:

    sha256("v2" | section path titles without numbering | node type | anchor text | ordinal)

- anchor text: the first sentence of the source block the node was built from (its own `source_ref`): the verbatim heading of a heading
  node, the first sentence of a paragraph requirement. Numbering is stripped, so a renumbered section still matches. Never the model's
  wording, so it is the same in BASELINE and SURVEY. A node with no source block of its own (a table row, a model-created node) uses its
  verbatim description (BASELINE) or the source heading it was built from (SURVEY).
- ordinal: the node's index among nodes with the same section, type and anchor, in tree order, so two byte-identical sibling
  requirements stay two distinct items (see test_two_byte_identical_requirement_lines_get_distinct_v2_identity_hashes).

No filename and no offsets are hashed. content_hash tells an edited item from an unchanged one under the same v2 identity:
fidelity_hash for BASELINE (its description is verbatim); for SURVEY, sha256 of the normalized source span (the node's source block up to
the next node's source block), since the wording is the model's and changes run to run.
"""

from __future__ import annotations

import bisect
import hashlib
import re
import unicodedata
from collections import Counter

from app.canonical.model import CanonicalDoc, SourceRef, Table
from app.workitem.model import WorkItemMode, WorkItemTree

# A leading section number: "3", "3.2", "3.2.1.", "A.1", "2)" followed by whitespace.
_NUMBERING = re.compile(r"^\s*(?:\d+(?:\.\d+)*|[A-Za-z](?:\.\d+)+)[.)]?\s+")
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")
_TAG = re.compile(r"<[^>]+>")
_ANCHOR_MAX_CHARS = 300


def _normalise(text: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", _TAG.sub(" ", text)).split()).casefold()


def _without_numbering(text: str) -> str:
    return _NUMBERING.sub("", text, count=1)


def _anchor(text: str) -> str:
    flat = " ".join(_TAG.sub(" ", text).split())
    first = _SENTENCE_END.split(flat, maxsplit=1)[0] if flat else ""
    return _normalise(_without_numbering(first))[:_ANCHOR_MAX_CHARS]


def _unit_key(ref: SourceRef) -> tuple[int, int, int | None]:
    return (ref.start_offset, ref.end_offset, ref.page)


def _table_text(table: Table) -> str:
    return " ".join(cell.text for row in table.cells for cell in row if cell is not None)


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def assign_identity_v2(tree: WorkItemTree, doc: CanonicalDoc) -> WorkItemTree:
    """Sets identity_hash_v2 and content_hash on every node of `tree`, in place (and returns it). Deterministic: the same tree and
    document always give the same values, so running it again (BASELINE structure inside a SURVEY run) changes nothing."""
    from app.leveling.tree_builder import _derive_doc_title  # tree_builder calls this module

    block_index: dict[tuple[int, int, int | None], int] = {}
    for index, block in enumerate(doc.blocks):
        block_index.setdefault(_unit_key(block.source_ref), index)
    table_text: dict[tuple[int, int, int | None], str] = {}
    for table in doc.tables:
        table_text.setdefault(_unit_key(table.source_ref), _table_text(table))
    # Where each node's own source span starts, so a SURVEY span runs up to the next node's source block.
    span_starts = sorted(
        {block_index[key] for node in tree.nodes if (key := _unit_key(node.source_ref)) in block_index}
    )
    filename_title = _derive_doc_title(doc)

    seen: Counter[str] = Counter()
    for node in tree.nodes:
        key = _unit_key(node.source_ref)
        start = block_index.get(key)
        if start is not None:
            anchor_source = doc.blocks[start].text
        elif node.mode == WorkItemMode.BASELINE:
            anchor_source = node.description
        else:
            anchor_source = node.source_title or table_text.get(key) or ""
        section = "\x1f".join(_normalise(_without_numbering(title)) for title in node.source_ref.section_path)
        base = f"v2\x00{section}\x00{node.type}\x00{_anchor(anchor_source)}"
        ordinal = seen[base]
        seen[base] += 1
        node.identity_hash_v2 = _sha256(f"{base}\x00{ordinal}")

        if node.title == filename_title and node.description == filename_title:
            # A title made from the filename (the document Epic of a document without one): nothing of the document to compare.
            node.content_hash = None
        elif node.mode == WorkItemMode.BASELINE:
            node.content_hash = node.fidelity_hash
        elif start is not None:
            following = bisect.bisect_right(span_starts, start)
            end = span_starts[following] if following < len(span_starts) else len(doc.blocks)
            node.content_hash = _sha256(_normalise("\n".join(block.text for block in doc.blocks[start:end])))
        else:
            node.content_hash = None
    return tree
