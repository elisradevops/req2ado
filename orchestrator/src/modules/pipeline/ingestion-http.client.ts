import { Injectable } from '@nestjs/common';

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
    });
    if (!response.ok) {
      throw new Error(`Ingestion /level request failed: ${response.status}`);
    }
    return (await response.json()) as Record<string, unknown>;
  }
}
