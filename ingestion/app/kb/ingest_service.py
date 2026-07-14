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


# Recursive folder-crawl depth cap: bounds worst-case Graph API calls
# against a huge/misconfigured folder tree. A folder found at this depth is
# listed but not descended into (silently — the user can re-run against
# that subfolder's own share link if they need it).
MAX_FOLDER_DEPTH = 5


class FolderIngestFileResult(BaseModel):
    file: str
    status: str  # "ingested" | "skipped_unchanged" | "failed"
    chunks_stored: int
    driveitem_id: str | None = None
    mime_type: str | None = None
    size_bytes: int | None = None
    reason: str | None = None
    # Path relative to the ingested root, e.g. "sub/child.pdf". Equal to
    # `file` for top-level entries. Distinguishes same-named files across
    # different subfolders in a recursive ingest.
    relative_path: str | None = None


class FolderIngestResult(BaseModel):
    files: list[FolderIngestFileResult]


def _store_document(
    name: str,
    item_id: str,
    content: bytes,
    area_path: str,
    doc_type: str | None,
    embed_client,
    vector_store: KbVectorStore,
) -> IngestResult:
    """Shared core once a document's bytes are in hand, regardless of
    whether they came from a single-document share link or a folder
    child's pre-signed download URL: verify content-type -> hash ->
    skip-if-unchanged -> parse -> chunk -> embed -> store."""
    verify_supported_content(name, content)

    file_hash = hashlib.sha256(content).hexdigest()
    if vector_store.existing_file_hash(area_path, name, item_id) == file_hash:
        return IngestResult(
            document_name=name,
            driveitem_id=item_id,
            mime_type=None,
            size_bytes=len(content),
            chunks_stored=0,
            skipped_unchanged=True,
        )

    suffix = Path(name).suffix
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(content)
        tmp_path = tmp.name
    try:
        doc = dispatch_by_extension(name, tmp_path)
    finally:
        Path(tmp_path).unlink(missing_ok=True)

    chunks = chunk_canonical_doc(doc)

    # Embed every chunk BEFORE deleting the file's old chunks or upserting
    # any new one: if embedding fails partway through, the old chunks stay
    # intact and the stored file_hash still reflects the last successfully
    # embedded version, so a retry re-ingests cleanly rather than leaving a
    # partially-overwritten document.
    embedded = [(chunk, embed_client.embed([chunk.text])[0]) for chunk in chunks]

    vector_store.delete_file_chunks(area_path, name, item_id)
    for chunk, embedding in embedded:
        vector_store.upsert_chunk(
            chunk_id=f"{item_id}:{name}:{chunk.chunk_index}",
            embedding=embedding,
            text=chunk.text,
            area_path=area_path,
            source_file=name,
            source_id=item_id,
            chunk_index=chunk.chunk_index,
            file_hash=file_hash,
            doc_type=doc_type,
        )

    return IngestResult(
        document_name=name,
        driveitem_id=item_id,
        mime_type=None,
        size_bytes=len(content),
        chunks_stored=len(embedded),
        skipped_unchanged=False,
    )


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
    store. This handles exactly one document, so any failure (ValueError,
    GraphApiError) propagates to the caller instead of being collected into
    a failures list."""
    validate_share_url(url)

    item = graph_client.get_drive_item(url)
    if item.size > MAX_FILE_SIZE_BYTES:
        raise ValueError(f"file exceeds {MAX_FILE_SIZE_BYTES}-byte limit: {item.size}")

    content = graph_client.fetch_content(url)
    if len(content) > MAX_FILE_SIZE_BYTES:
        raise ValueError(f"file exceeds {MAX_FILE_SIZE_BYTES}-byte limit: {len(content)}")

    result = _store_document(item.name, item.id, content, area_path, doc_type, embed_client, vector_store)
    return result.model_copy(update={"mime_type": item.mime_type})


def _ingest_folder_children(
    children: list,
    prefix: str,
    depth: int,
    area_path: str,
    doc_type: str | None,
    graph_client,
    embed_client,
    vector_store: KbVectorStore,
    recursive: bool,
    results: list[FolderIngestFileResult],
) -> None:
    """Processes one folder level's children in place, appending to
    `results`. Files are stored via `_store_document`; folders are
    recursed into (sequential, depth-first) only when `recursive` is set
    and the depth cap hasn't been reached. One file's failure or one
    subfolder's listing failure is caught and recorded as a single failed
    entry — never aborts siblings or the rest of the batch."""
    for child in children:
        relative_path = f"{prefix}{child.name}"
        if child.is_folder:
            if not recursive or depth >= MAX_FOLDER_DEPTH or not child.drive_id:
                continue  # not descended into; see MAX_FOLDER_DEPTH docstring
            try:
                grandchildren = graph_client.list_children_by_id(child.drive_id, child.id)
            except Exception as exc:  # noqa: BLE001 - one subtree's failure must not abort siblings
                results.append(
                    FolderIngestFileResult(file=child.name, status="failed", chunks_stored=0, reason=str(exc), relative_path=relative_path)
                )
                continue
            _ingest_folder_children(
                grandchildren, f"{relative_path}/", depth + 1, area_path, doc_type, graph_client, embed_client, vector_store, recursive, results
            )
            continue

        try:
            if child.size > MAX_FILE_SIZE_BYTES:
                raise ValueError(f"file exceeds {MAX_FILE_SIZE_BYTES}-byte limit: {child.size}")
            if not child.download_url:
                raise ValueError("no download URL available for this file")

            content = graph_client.fetch_child_content(child.download_url)
            if len(content) > MAX_FILE_SIZE_BYTES:
                raise ValueError(f"file exceeds {MAX_FILE_SIZE_BYTES}-byte limit: {len(content)}")

            result = _store_document(child.name, child.id, content, area_path, doc_type, embed_client, vector_store)
            results.append(
                FolderIngestFileResult(
                    file=child.name,
                    status="skipped_unchanged" if result.skipped_unchanged else "ingested",
                    chunks_stored=result.chunks_stored,
                    driveitem_id=child.id,
                    mime_type=child.mime_type,
                    size_bytes=len(content),
                    relative_path=relative_path,
                )
            )
        except Exception as exc:  # noqa: BLE001 - one file's failure must not abort the batch
            results.append(FolderIngestFileResult(file=child.name, status="failed", chunks_stored=0, reason=str(exc), relative_path=relative_path))


def ingest_folder_from_url(
    url: str,
    area_path: str,
    doc_type: str | None,
    graph_client,
    embed_client,
    vector_store: KbVectorStore,
    recursive: bool = False,
) -> FolderIngestResult:
    """Ingests every file inside a shared SharePoint/OneDrive folder.
    Single-level by default; when `recursive` is set, descends into
    subfolders up to MAX_FOLDER_DEPTH (sequential, depth-first — matches
    the non-recursive path's simple per-file isolation, just applied
    per-subtree too). One file's or one subfolder's failure never aborts
    the rest of the batch; each outcome is collected and returned."""
    validate_share_url(url)
    children = graph_client.list_folder_children(url)

    results: list[FolderIngestFileResult] = []
    # depth starts at 1 for the root's own children: MAX_FOLDER_DEPTH=5 means
    # a folder found 5 levels down from the root is listed but not descended
    # into (its own children, at depth 6, are never fetched).
    _ingest_folder_children(children, "", 1, area_path, doc_type, graph_client, embed_client, vector_store, recursive, results)
    return FolderIngestResult(files=results)
