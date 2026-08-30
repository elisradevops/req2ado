# ingestion/tests/test_dispatch.py
import shutil
from pathlib import Path

from app.dispatch import dispatch_by_extension

FIXTURES = Path(__file__).parent / "fixtures"


def test_document_path_is_the_original_filename_not_the_tmp_path(tmp_path) -> None:
    # Regression: every loader is handed a random tempfile.NamedTemporaryFile
    # path to actually read from -- that path used to leak straight into
    # SourceRef.document_path/Document.path, breaking identity_hash's
    # stability across two uploads of the same file (see tree_builder.py's
    # _hash_identity, confirmed live via golden-e2e's job #2 100%-reuse
    # assertion failing on an identical re-upload).
    scratch = tmp_path / "some-random-scratch-name-abc123.docx"
    shutil.copy(FIXTURES / "sample.docx", scratch)

    doc = dispatch_by_extension("real-uploaded-name.docx", str(scratch))

    assert doc.document.path == "real-uploaded-name.docx"
    assert all(block.source_ref.document_path == "real-uploaded-name.docx" for block in doc.blocks)
    assert all(table.source_ref.document_path == "real-uploaded-name.docx" for table in doc.tables)
    assert all(figure.source_ref.document_path == "real-uploaded-name.docx" for figure in doc.figures)


def test_identical_uploads_produce_the_same_document_path_even_via_different_tmp_paths(tmp_path) -> None:
    # The actual end-to-end proof: two "uploads" of the byte-identical file,
    # each landing at its own random tmp path (exactly what tempfile.
    # NamedTemporaryFile produces per request), must normalize to the SAME
    # document_path -- the precondition identity_hash needs to be stable.
    scratch_a = tmp_path / "upload-attempt-1-xyz.docx"
    scratch_b = tmp_path / "totally-different-random-name-987.docx"
    shutil.copy(FIXTURES / "sample.docx", scratch_a)
    shutil.copy(FIXTURES / "sample.docx", scratch_b)

    doc_a = dispatch_by_extension("sample.docx", str(scratch_a))
    doc_b = dispatch_by_extension("sample.docx", str(scratch_b))

    assert doc_a.document.path == doc_b.document.path
    assert doc_a.blocks[0].source_ref.document_path == doc_b.blocks[0].source_ref.document_path


def test_open_tbd_classification_applies_to_a_txt_paragraph_not_just_ocr(tmp_path) -> None:
    # Real gap this closes: OPEN_TBD classification previously only ever
    # ran inside ocr.py (scanned PDFs), even though its pattern match has
    # nothing OCR-specific about it -- a plain .txt paragraph with the exact
    # same marker silently never got flagged.
    from app.canonical.model import BlockKind

    path = tmp_path / "notes.txt"
    path.write_text("TBD: finalize the thermal budget before release.\n\nA normal paragraph.", encoding="utf-8")

    doc = dispatch_by_extension("notes.txt", str(path))

    kinds_by_text = {b.text: b.kind for b in doc.blocks}
    assert kinds_by_text["TBD: finalize the thermal budget before release."] == BlockKind.OPEN_TBD
    assert kinds_by_text["A normal paragraph."] == BlockKind.PARAGRAPH


def test_open_tbd_classification_applies_to_any_loaders_paragraph_blocks() -> None:
    # Same gap, format-agnostic: dispatch_by_extension's post-load pass
    # (not ocr.py's own copy) is what every non-scanned format actually
    # goes through -- native-text PDF, docx, pptx, markdown, rtf all
    # produce plain PARAGRAPH blocks the same way txt does, and none of
    # them had this classification before this fix.
    from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef
    from app.dispatch import _classify_open_tbd_paragraphs

    doc = CanonicalDoc(
        document=Document(path="x.pdf", format=DocumentFormat.PDF, sha256="0" * 64),
        blocks=[
            Block(
                id="b0", kind=BlockKind.PARAGRAPH, text="OPEN: confirm the vendor part number.",
                source_ref=SourceRef(document_path="x.pdf", start_offset=0, end_offset=0),
            ),
            Block(
                id="b1", kind=BlockKind.HEADING, text="Open Items", heading_level=1,
                source_ref=SourceRef(document_path="x.pdf", start_offset=1, end_offset=1),
            ),
        ],
    )
    result = _classify_open_tbd_paragraphs(doc)
    assert result.blocks[0].kind == BlockKind.OPEN_TBD
    # A HEADING matching the same text pattern is never reclassified --
    # only PARAGRAPH blocks are in scope, matching ocr.py's own rule.
    assert result.blocks[1].kind == BlockKind.HEADING
