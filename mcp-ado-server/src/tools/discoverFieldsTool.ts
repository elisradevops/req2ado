import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdoBackend } from '../backends/types.js';

/** Registers `ado_discover_fields` — lists field reference names for a work-item type. */
export function registerDiscoverFieldsTool(server: McpServer, backend: AdoBackend): void {
  server.registerTool(
    'ado_discover_fields',
    {
      title: 'Discover ADO work-item type fields',
      description:
        'Returns the field reference names available on a given work-item type. Used by callers to resolve the correct Customer ID field ref name against a runtime-verified candidate list (see docs/architecture.md "Customer ID Field Resolution").',
      inputSchema: { workItemType: z.enum(['Epic', 'Feature', 'Requirement']) },
    },
    async ({ workItemType }) => {
      const fields = await backend.discoverFields(workItemType);
      return { content: [{ type: 'text', text: JSON.stringify(fields) }] };
    },
  );
}
