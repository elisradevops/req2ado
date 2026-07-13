# ingestion/app/kb/sync_service.py
from __future__ import annotations

import hashlib
import tempfile
from pathlib import Path

from pydantic import BaseModel

from app.dispatch import dispatch_by_extension
from app.kb.chunker import chunk_canonical_doc
from app.kb.kb_vector_store import KbVectorStore
from app.kb.sharepoint_client import SharePointClient


class KbSyncFileFailure(BaseModel):
    file: str
    reason: str


class KbSyncResult(BaseModel):
    files_processed: int
    files_skipped: int
    files_failed: list[KbSyncFileFailure]
    chunks_stored: int


def sync_kb_source(
    site_url: str,
    library: str,
    folder: str,
    area_path: str,
    source_id: str,
    bearer_token: str,
    embed_client,
    vector_store: KbVectorStore,
) -> KbSyncResult:
    """Fetches every file in a SharePoint folder, skips files whose content
    hash already matches what's stored (skip-unchanged), and re-ingests
    everything else: parse -> chunk -> embed -> upsert. A single file's
    fetch/parse/embed failure is recorded and skipped, never aborts the
    whole sync (RAG-first 'never blocks' principle, docs/req2ado-roadmap.md)."""
    sharepoint = SharePointClient(site_url, bearer_token)
    files = sharepoint.list_files(library, folder)

    files_processed = 0
    files_skipped = 0
    chunks_stored = 0
    failures: list[KbSyncFileFailure] = []

    for file in files:
        try:
            content = sharepoint.fetch_file_bytes(file.server_relative_url)
            file_hash = hashlib.sha256(content).hexdigest()

            if vector_store.existing_file_hash(area_path, file.name, source_id) == file_hash:
                files_skipped += 1
                continue

            suffix = Path(file.name).suffix
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
                tmp.write(content)
                tmp_path = tmp.name
            try:
                doc = dispatch_by_extension(file.name, tmp_path)
            finally:
                Path(tmp_path).unlink(missing_ok=True)

            # Embed every chunk BEFORE deleting the file's old chunks or
            # upserting any new one: if embedding fails partway through
            # (e.g. chunk 3 of 5), the old chunks must stay intact so the
            # next sync attempt still sees the OLD file_hash and retries the
            # whole file — never a partially-replaced set of chunks tagged
            # with the NEW hash, which would make existing_file_hash's
            # first-match lookup wrongly report this file as fully synced.
            chunks = chunk_canonical_doc(doc)
            embedded_chunks = [(chunk, embed_client.embed([chunk.text])[0]) for chunk in chunks]

            vector_store.delete_file_chunks(area_path, file.name, source_id)
            for chunk, embedding in embedded_chunks:
                vector_store.upsert_chunk(
                    chunk_id=f"{source_id}:{file.name}:{chunk.chunk_index}",
                    embedding=embedding,
                    text=chunk.text,
                    area_path=area_path,
                    source_file=file.name,
                    source_id=source_id,
                    chunk_index=chunk.chunk_index,
                    file_hash=file_hash,
                )
                chunks_stored += 1
            files_processed += 1
        except Exception as exc:  # noqa: BLE001 - any single file's failure must not abort the sync
            failures.append(KbSyncFileFailure(file=file.name, reason=str(exc)))

    return KbSyncResult(
        files_processed=files_processed,
        files_skipped=files_skipped,
        files_failed=failures,
        chunks_stored=chunks_stored,
    )
