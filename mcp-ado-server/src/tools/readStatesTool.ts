import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdoBackend } from '../backends/types.js';

/** Registers `ado_read_states` — lists the workflow states defined for a work-item type. */
export function registerReadStatesTool(server: McpServer, backend: AdoBackend): void {
  server.registerTool(
    'ado_read_states',
    {
      title: 'Read ADO work-item states',
      description: 'Returns the workflow states defined for a work-item type on the process template, used to populate a real initial-state picker instead of a hardcoded default. workItemType must be the REAL ADO type name for this project (resolve via ado_discover_work_item_type_categories first, not req2ado\'s internal Epic/Feature/Requirement labels).',
      inputSchema: { workItemType: z.string(), project: z.string().optional() },
    },
    async ({ workItemType, project }) => {
      const states = await backend.readStates(workItemType, project);
      return { content: [{ type: 'text', text: JSON.stringify(states) }] };
    },
  );
}
