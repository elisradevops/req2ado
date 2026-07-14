# ingestion/app/kb/ingest_service.py
from __future__ import annotations

import hashlib
import tempfile
from pathlib import Path

from pydantic import BaseModel

from app.dispatch import dispatch_by_extension
from app.kb.chunker import chunk_canonical_doc
from app.kb.kb_vector_store import KbVectorStore
from app.kb.url_security import MAX_FILE_SIZE_BYTES, validate_share_url, verify_supported_content


class IngestResult(BaseModel):
    document_name: str
    driveitem_id: str
    mime_type: str | None
    size_bytes: int
    chunks_stored: int
    skipped_unchanged: bool


def ingest_document_from_url(
    url: str,
    area_path: str,
    doc_type: str | None,
    graph_client,
    embed_client,
    vector_store: KbVectorStore,
) -> IngestResult:
    """Ingests a single document from a SharePoint/OneDrive sharing URL via
    the Microsoft Graph client: validate -> fetch metadata + bytes -> verify
    size/content-type -> skip if unchanged -> parse -> chunk -> embed ->
    store. Unlike the folder-crawl sync_kb_source, this handles exactly one
    document, so any failure (ValueError, GraphApiError) propagates to the
    caller instead of being collected into a failures list."""
    validate_share_url(url)

    item = graph_client.get_drive_item(url)
    if item.size > MAX_FILE_SIZE_BYTES:
        raise ValueError(f"file exceeds {MAX_FILE_SIZE_BYTES}-byte limit: {item.size}")

    content = graph_client.fetch_content(url)
    if len(content) > MAX_FILE_SIZE_BYTES:
        raise ValueError(f"file exceeds {MAX_FILE_SIZE_BYTES}-byte limit: {len(content)}")

    verify_supported_content(item.name, content)

    file_hash = hashlib.sha256(content).hexdigest()
    if vector_store.existing_file_hash(area_path, item.name, item.id) == file_hash:
        return IngestResult(
            document_name=item.name,
            driveitem_id=item.id,
            mime_type=item.mime_type,
            size_bytes=len(content),
            chunks_stored=0,
            skipped_unchanged=True,
        )

    suffix = Path(item.name).suffix
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(content)
        tmp_path = tmp.name
    try:
        doc = dispatch_by_extension(item.name, tmp_path)
    finally:
        Path(tmp_path).unlink(missing_ok=True)

    chunks = chunk_canonical_doc(doc)

    # Embed every chunk BEFORE deleting the file's old chunks or upserting
    # any new one: if embedding fails partway through, the old chunks stay
    # intact and the stored file_hash still reflects the last successfully
    # embedded version, so a retry re-ingests cleanly rather than leaving a
    # partially-overwritten document.
    embedded = [(chunk, embed_client.embed([chunk.text])[0]) for chunk in chunks]

    vector_store.delete_file_chunks(area_path, item.name, item.id)
    for chunk, embedding in embedded:
        vector_store.upsert_chunk(
            chunk_id=f"{item.id}:{item.name}:{chunk.chunk_index}",
            embedding=embedding,
            text=chunk.text,
            area_path=area_path,
            source_file=item.name,
            source_id=item.id,
            chunk_index=chunk.chunk_index,
            file_hash=file_hash,
            doc_type=doc_type,
        )

    return IngestResult(
        document_name=item.name,
        driveitem_id=item.id,
        mime_type=item.mime_type,
        size_bytes=len(content),
        chunks_stored=len(embedded),
        skipped_unchanged=False,
    )
