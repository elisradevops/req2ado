import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdoBackend } from '../backends/types.js';

export function registerLinkWorkItemsTool(server: McpServer, backend: AdoBackend): void {
  server.registerTool(
    'ado_link_work_items',
    {
      title: 'Link two work items with an arbitrary relation type',
      description:
        'Adds a relation of the given referenceName (e.g. a Covers/CoveredBy/Affects/' +
        'AffectedBy reference name from ado_discover_link_types) from fromId to toId.',
      inputSchema: { fromId: z.number(), toId: z.number(), referenceName: z.string() },
    },
    async ({ fromId, toId, referenceName }) => {
      await backend.linkWorkItems(fromId, toId, referenceName);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
    },
  );
}
