import { Injectable } from '@nestjs/common';
import { Agent } from 'undici';

// undici's default headersTimeout (300s) is shorter than a real local LLM
// can take for SURVEY mode's two sequential calls (infer_hierarchy +
// generate_requirements_for_document) on CPU/GPU-constrained hardware —
// observed directly: a 12b-class Ollama model took several minutes per
// call. Only /level can run this long (BASELINE never touches an LLM;
// /ingest, /dedup/check, /dedup/upsert are all fast); scoped to a dedicated
// Agent rather than raising the timeout for every ingestion call.
const LONG_RUNNING_AGENT = new Agent({ headersTimeout: 1_800_000, bodyTimeout: 1_800_000 });

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
  ): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({ mode });
    if (customerId) params.set('customer_id', customerId);
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
}
