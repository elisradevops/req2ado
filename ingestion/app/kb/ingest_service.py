# ingestion/app/kb/ingest_service.py
from __future__ import annotations

import hashlib
import logging
import tempfile
from pathlib import Path
from typing import Callable

from pydantic import BaseModel

from app.dispatch import dispatch_by_extension
from app.kb.chunker import chunk_canonical_doc
from app.kb.kb_vector_store import KbVectorStore
from app.kb.url_security import MAX_FILE_SIZE_BYTES, validate_share_url, verify_supported_content

logger = logging.getLogger(__name__)


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
    user_id: str,
    doc_type: str | None,
    embed_client,
    vector_store: KbVectorStore,
    describe_figure: Callable[[bytes], str] | None = None,
    checklist_client: object | None = None,
    retrieval_mode: str | None = None,
) -> IngestResult:
    """Shared core once a document's bytes are in hand, regardless of
    whether they came from a single-document share link or a folder
    child's pre-signed download URL: verify content-type -> hash ->
    skip-if-unchanged -> parse -> chunk -> embed -> store.

    `describe_figure`, when supplied, is forwarded into dispatch_by_extension
    so an embedded docx/pptx/pdf image gets a real vision caption instead of
    the bare '[FIGURE: none]' placeholder -- mirrors app.main's /ingest route
    (see _describe_figure there), which this KB path previously never
    received. None (the pre-existing default, and every existing caller
    before this change) preserves the placeholder-only behavior exactly.

    `checklist_client`, when supplied, runs quality-checklist extraction
    (see app.survey.orchestrator_llm_client.OrchestratorLlmClient.
    extract_quality_checklist) ONCE for this document -- the real fix for a
    confirmed determinism gap (see that method's own docstring): asking the
    scoring LLM to derive categoryScores names live, per job run, is not a
    cross-run guarantee. Extracting once here and storing the result on
    every chunk makes the checklist a property of the ingested document
    itself. None (the default) skips extraction entirely -- e.g. for a
    caller with no LLM client wired up, or a re-ingest that intentionally
    doesn't need to re-run it. A failure here is an enhancement failing,
    never a reason to fail the whole ingest -- caught and logged, falling
    back to `None` (extraction never happened), same tolerant philosophy as
    every other best-effort KB enhancement in this codebase.

    `retrieval_mode`: "retrieve" (default, None also means this) similarity-
    gates this file exactly as before; "always_include" tags it for
    app.kb.retrieval.fetch_always_include_context's unconditional-injection
    path instead -- see KbVectorStore.upsert_chunk's own docstring."""
    verify_supported_content(name, content)

    file_hash = hashlib.sha256(content).hexdigest()
    if vector_store.existing_file_hash(user_id, name, item_id) == file_hash:
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
        doc = dispatch_by_extension(name, tmp_path, describe_figure=describe_figure)
    finally:
        Path(tmp_path).unlink(missing_ok=True)

    chunks = chunk_canonical_doc(doc)

    # Extracted ONCE per document, here at ingestion time -- not per
    # scoring call (see this function's own docstring + extract_quality_
    # checklist's docstring for the determinism problem this fixes). Reuses
    # the already-chunked text rather than re-rendering the document a
    # second time. `None` (extraction skipped or failed) is stored
    # as-is -- distinguishable from `[]` (extraction ran, found nothing),
    # see KbVectorStore.get_quality_checklist's own docstring.
    quality_checklist: list[str] | None = None
    if checklist_client is not None:
        try:
            full_text = "\n\n".join(chunk.text for chunk in chunks)
            quality_checklist = checklist_client.extract_quality_checklist(full_text)
        except Exception as exc:  # noqa: BLE001 - checklist extraction must never fail an ingest
            logger.warning("Quality-checklist extraction failed for %s: %s", name, exc)
            quality_checklist = None

    # Embed every chunk BEFORE deleting the file's old chunks or upserting
    # any new one: if embedding fails partway through, the old chunks stay
    # intact and the stored file_hash still reflects the last successfully
    # embedded version, so a retry re-ingests cleanly rather than leaving a
    # partially-overwritten document.
    embedded = [(chunk, embed_client.embed([chunk.text])[0]) for chunk in chunks]

    vector_store.delete_file_chunks(user_id, name, item_id)
    for chunk, embedding in embedded:
        vector_store.upsert_chunk(
            chunk_id=f"{item_id}:{name}:{chunk.chunk_index}",
            embedding=embedding,
            text=chunk.text,
            user_id=user_id,
            source_file=name,
            source_id=item_id,
            chunk_index=chunk.chunk_index,
            file_hash=file_hash,
            doc_type=doc_type,
            quality_checklist=quality_checklist,
            retrieval_mode=retrieval_mode,
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
    user_id: str,
    doc_type: str | None,
    graph_client,
    embed_client,
    vector_store: KbVectorStore,
    describe_figure: Callable[[bytes], str] | None = None,
    checklist_client: object | None = None,
    retrieval_mode: str | None = None,
) -> IngestResult:
    """Ingests a single document from a SharePoint/OneDrive sharing URL via
    the Microsoft Graph client: validate -> fetch metadata + bytes -> verify
    size/content-type -> skip if unchanged -> parse -> chunk -> embed ->
    store. This handles exactly one document, so any failure (ValueError,
    GraphApiError) propagates to the caller instead of being collected into
    a failures list. `describe_figure`/`checklist_client`/`retrieval_mode`
    -- see _store_document's docstring."""
    validate_share_url(url)

    item = graph_client.get_drive_item(url)
    if item.size > MAX_FILE_SIZE_BYTES:
        raise ValueError(f"file exceeds {MAX_FILE_SIZE_BYTES}-byte limit: {item.size}")

    content = graph_client.fetch_content(url)
    if len(content) > MAX_FILE_SIZE_BYTES:
        raise ValueError(f"file exceeds {MAX_FILE_SIZE_BYTES}-byte limit: {len(content)}")

    result = _store_document(
        item.name, item.id, content, user_id, doc_type, embed_client, vector_store,
        describe_figure=describe_figure, checklist_client=checklist_client, retrieval_mode=retrieval_mode,
    )
    return result.model_copy(update={"mime_type": item.mime_type})


def ingest_folder_child(
    name: str,
    item_id: str,
    download_url: str,
    doc_type: str | None,
    user_id: str,
    graph_client,
    embed_client,
    vector_store: KbVectorStore,
    describe_figure: Callable[[bytes], str] | None = None,
    checklist_client: object | None = None,
    retrieval_mode: str | None = None,
) -> IngestResult:
    """Ingests exactly one file the caller already saw via
    browse_shared_folder/browse_subfolder, addressed by its pre-signed Graph
    download URL rather than a sharing URL -- lets a reviewer ingest a
    single file straight from the tree view without that file's own share
    link (browsing alone never produces one). Same fetch -> verify -> store
    pipeline as ingest_folder_from_url's per-child path, for one
    caller-chosen file instead of every child in a folder."""
    content = graph_client.fetch_child_content(download_url)
    if len(content) > MAX_FILE_SIZE_BYTES:
        raise ValueError(f"file exceeds {MAX_FILE_SIZE_BYTES}-byte limit: {len(content)}")
    return _store_document(
        name, item_id, content, user_id, doc_type, embed_client, vector_store,
        describe_figure=describe_figure, checklist_client=checklist_client, retrieval_mode=retrieval_mode,
    )


def _ingest_folder_children(
    children: list,
    prefix: str,
    depth: int,
    user_id: str,
    doc_type: str | None,
    graph_client,
    embed_client,
    vector_store: KbVectorStore,
    recursive: bool,
    results: list[FolderIngestFileResult],
    describe_figure: Callable[[bytes], str] | None = None,
    checklist_client: object | None = None,
) -> None:
    """Processes one folder level's children in place, appending to
    `results`. Files are stored via `_store_document`; folders are
    recursed into (sequential, depth-first) only when `recursive` is set
    and the depth cap hasn't been reached. One file's failure or one
    subfolder's listing failure is caught and recorded as a single failed
    entry — never aborts siblings or the rest of the batch. `describe_figure`
    -- see _store_document's docstring."""
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
                grandchildren,
                f"{relative_path}/",
                depth + 1,
                user_id,
                doc_type,
                graph_client,
                embed_client,
                vector_store,
                recursive,
                results,
                describe_figure=describe_figure,
                checklist_client=checklist_client,
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

            result = _store_document(
                child.name, child.id, content, user_id, doc_type, embed_client, vector_store,
                describe_figure=describe_figure, checklist_client=checklist_client,
            )
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
    user_id: str,
    doc_type: str | None,
    graph_client,
    embed_client,
    vector_store: KbVectorStore,
    recursive: bool = False,
    describe_figure: Callable[[bytes], str] | None = None,
    checklist_client: object | None = None,
) -> FolderIngestResult:
    """Ingests every file inside a shared SharePoint/OneDrive folder.
    Single-level by default; when `recursive` is set, descends into
    subfolders up to MAX_FOLDER_DEPTH (sequential, depth-first — matches
    the non-recursive path's simple per-file isolation, just applied
    per-subtree too). One file's or one subfolder's failure never aborts
    the rest of the batch; each outcome is collected and returned.
    `describe_figure`/`checklist_client` -- see _store_document's docstring."""
    validate_share_url(url)
    children = graph_client.list_folder_children(url)

    results: list[FolderIngestFileResult] = []
    # depth starts at 1 for the root's own children: MAX_FOLDER_DEPTH=5 means
    # a folder found 5 levels down from the root is listed but not descended
    # into (its own children, at depth 6, are never fetched).
    _ingest_folder_children(
        children, "", 1, user_id, doc_type, graph_client, embed_client, vector_store, recursive,
        results, describe_figure=describe_figure, checklist_client=checklist_client,
    )
    return FolderIngestResult(files=results)
