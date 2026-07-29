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
        'Returns the field reference names available on a given work-item type. Used by callers to resolve the correct Customer ID field ref name against a runtime-verified candidate list (see docs/architecture.md "Customer ID Field Resolution"). workItemType must be the REAL ADO type name for this project (resolve via ado_discover_work_item_type_categories first, not req2ado\'s internal Epic/Feature/Requirement labels) -- process templates other than CMMI use different real names (e.g. "User Story").',
      inputSchema: { workItemType: z.string() },
    },
    async ({ workItemType }) => {
      const fields = await backend.discoverFields(workItemType);
      return { content: [{ type: 'text', text: JSON.stringify(fields) }] };
    },
  );
}
