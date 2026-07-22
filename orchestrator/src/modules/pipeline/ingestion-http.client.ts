import { Injectable } from '@nestjs/common';
import { Agent } from 'undici';

// undici's default headersTimeout (300s) is shorter than a real local LLM
// can take for SURVEY mode's two sequential calls (infer_hierarchy +
// generate_requirements_for_document) on CPU/GPU-constrained hardware —
// observed directly: a 12b-class Ollama model took several minutes per
// call. /level and /kb/ingest-url (Graph fetch + parse + per-chunk embedding)
// are the only calls that can run this long (BASELINE never touches an LLM;
// /ingest, /dedup/check, /dedup/upsert are all fast); scoped to a dedicated
// Agent rather than raising the timeout for every ingestion call.
//
// Raised 30min -> 60min after a live run against a large document (152
// SURVEY branches, ~2 sequential LLM calls each) hit UND_ERR_HEADERS_TIMEOUT
// at the 30min mark even on a fast, GPU-accelerated small model -- branch
// count, not model speed, dominates total /level wall time. A real fix
// (parallelizing or streaming per-branch progress) is tracked separately;
// this is the immediate unblock.
const LONG_RUNNING_AGENT = new Agent({ headersTimeout: 3_600_000, bodyTimeout: 3_600_000 });

export class IngestionHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

/**
 * Calls the Python ingestion service's real /ingest and /level endpoints
 * (Phase 1/4, already built and tested) directly over HTTP — plain
 * service-to-service calls, NOT the MCP protocol (which is reserved for
 * ADO writes via mcp-ado-server, see McpClient). CanonicalDoc/WorkItemTree
 * are passed through as loosely-typed JSON on the TS side — the
 * orchestrator's job here is orchestration, not re-validating Python's own
 * pydantic-enforced shapes.
 */
@Injectable()
export class IngestionHttpClient {
  constructor(private readonly baseUrl: string) {}

  async ingest(fileBuffer: Buffer, filename: string): Promise<Record<string, unknown>> {
    const form = new FormData();
    form.append('file', new Blob([fileBuffer]), filename);
    const response = await fetch(`${this.baseUrl}/ingest`, { method: 'POST', body: form });
    if (!response.ok) {
      throw new Error(`Ingestion /ingest request failed: ${response.status}`);
    }
    return (await response.json()) as Record<string, unknown>;
  }

  async level(
    doc: Record<string, unknown>,
    customerId: string | null,
    mode: 'baseline' | 'survey' = 'baseline',
    areaPath?: string,
    linkTypeCatalog?: { referenceName: string; name: string; semanticHint?: string }[],
    model?: string,
    jobId?: string,
  ): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({ mode });
    if (customerId) params.set('customer_id', customerId);
    if (areaPath) params.set('area_path', areaPath);
    if (model) params.set('model', model);
    if (jobId) params.set('job_id', jobId);
    if (linkTypeCatalog) {
      // ingestion (Python) expects snake_case keys (reference_name/name/
      // semantic_hint) -- AdoLinkType on this side is camelCase. Map at the
      // wire boundary rather than changing either side's native casing.
      params.set(
        'link_type_catalog',
        JSON.stringify(
          linkTypeCatalog.map((t) => ({
            reference_name: t.referenceName,
            name: t.name,
            semantic_hint: t.semanticHint ?? null,
          })),
        ),
      );
    }
    const response = await fetch(`${this.baseUrl}/level?${params.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(doc),
      dispatcher: LONG_RUNNING_AGENT,
    });
    if (!response.ok) {
      throw new Error(`Ingestion /level request failed: ${response.status}`);
    }
    return (await response.json()) as Record<string, unknown>;
  }

  async checkDuplicate(text: string, areaPath: string): Promise<{ isDuplicate: boolean; matchedItemId: string | null; similarity: number | null }> {
    const response = await fetch(`${this.baseUrl}/dedup/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, area_path: areaPath }),
    });
    if (!response.ok) {
      throw new Error(`Ingestion /dedup/check request failed: ${response.status}`);
    }
    const body = (await response.json()) as { is_duplicate: boolean; matched_item_id: string | null; similarity: number | null };
    return { isDuplicate: body.is_duplicate, matchedItemId: body.matched_item_id, similarity: body.similarity };
  }

  async upsertDedupEntry(itemId: string, text: string, areaPath: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/dedup/upsert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id: itemId, text, area_path: areaPath }),
    });
    if (!response.ok) {
      throw new Error(`Ingestion /dedup/upsert request failed: ${response.status}`);
    }
  }

  /**
   * Batches multiple items into a single /dedup/upsert-batch call -- one
   * embed() round-trip for all of them, instead of confirm()'s previous
   * per-node loop triggering one /dedup/upsert (and one embed() call) per
   * item. A no-op for an empty list (never makes the HTTP call at all).
   */
  async upsertDedupEntriesBatch(items: { itemId: string; text: string; areaPath: string }[]): Promise<void> {
    if (items.length === 0) return;
    const response = await fetch(`${this.baseUrl}/dedup/upsert-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: items.map((item) => ({ item_id: item.itemId, text: item.text, area_path: item.areaPath })),
      }),
    });
    if (!response.ok) {
      throw new Error(`Ingestion /dedup/upsert-batch request failed: ${response.status}`);
    }
  }

  async ingestUrl(
    url: string,
    areaPath: string,
    docType: string | null,
  ): Promise<{
    documentName: string;
    driveitemId: string;
    mimeType: string | null;
    sizeBytes: number;
    chunksStored: number;
    skippedUnchanged: boolean;
  }> {
    const response = await fetch(`${this.baseUrl}/kb/ingest-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, area_path: areaPath, doc_type: docType }),
      dispatcher: LONG_RUNNING_AGENT,
    });
    if (!response.ok) {
      throw new IngestionHttpError(response.status, `Ingestion /kb/ingest-url request failed: ${response.status}`);
    }
    const body = (await response.json()) as {
      document_name: string;
      driveitem_id: string;
      mime_type: string | null;
      size_bytes: number;
      chunks_stored: number;
      skipped_unchanged: boolean;
    };
    return {
      documentName: body.document_name,
      driveitemId: body.driveitem_id,
      mimeType: body.mime_type,
      sizeBytes: body.size_bytes,
      chunksStored: body.chunks_stored,
      skippedUnchanged: body.skipped_unchanged,
    };
  }

  async ingestFolderUrl(
    url: string,
    areaPath: string,
    docType: string | null,
    recursive = false,
  ): Promise<{
    files: {
      file: string;
      status: string;
      chunksStored: number;
      driveitemId: string | null;
      mimeType: string | null;
      sizeBytes: number | null;
      reason: string | null;
      relativePath: string | null;
    }[];
  }> {
    const response = await fetch(`${this.baseUrl}/kb/ingest-folder-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, area_path: areaPath, doc_type: docType, recursive }),
      dispatcher: LONG_RUNNING_AGENT,
    });
    if (!response.ok) {
      throw new IngestionHttpError(response.status, `Ingestion /kb/ingest-folder-url request failed: ${response.status}`);
    }
    const body = (await response.json()) as {
      files: {
        file: string;
        status: string;
        chunks_stored: number;
        driveitem_id: string | null;
        mime_type: string | null;
        size_bytes: number | null;
        reason: string | null;
        relative_path: string | null;
      }[];
    };
    return {
      files: body.files.map((f) => ({
        file: f.file,
        status: f.status,
        chunksStored: f.chunks_stored,
        driveitemId: f.driveitem_id,
        mimeType: f.mime_type,
        sizeBytes: f.size_bytes,
        reason: f.reason,
        relativePath: f.relative_path,
      })),
    };
  }
}
