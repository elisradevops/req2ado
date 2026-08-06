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
