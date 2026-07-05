import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdoBackend } from '../backends/types.js';

/** Registers `ado_query_ids` — exact-field-match id lookup for dedup/idempotency checks. */
export function registerQueryIdsTool(server: McpServer, backend: AdoBackend): void {
  server.registerTool(
    'ado_query_ids',
    {
      title: 'Query work item ids by exact field match',
      description: 'Returns ids of work items whose fields exactly match every key/value pair given. Used for dedup/idempotency lookups.',
      inputSchema: { fieldMatch: z.record(z.string()) },
    },
    async ({ fieldMatch }) => {
      const ids = await backend.queryIds(fieldMatch);
      return { content: [{ type: 'text', text: JSON.stringify(ids) }] };
    },
  );
}
