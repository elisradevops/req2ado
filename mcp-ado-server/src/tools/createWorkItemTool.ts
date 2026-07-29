import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdoBackend } from '../backends/types.js';
import { adoErrorMessage } from '../backends/adoErrorMessage.js';

export function registerCreateWorkItemTool(server: McpServer, backend: AdoBackend): void {
  server.registerTool(
    'ado_create_work_item',
    {
      title: 'Create an ADO work item',
      description: 'Creates a new work item of the given type with the given fields. Does not link a parent — use ado_link_parent_child separately. `type` must be the REAL ADO type name for this project (resolve via ado_discover_work_item_type_categories first, not req2ado\'s internal Epic/Feature/Requirement labels) -- process templates other than CMMI use different real names (e.g. "User Story").',
      inputSchema: {
        type: z.string(),
        fields: z.record(z.string()),
      },
    },
    async ({ type, fields }) => {
      try {
        const result = await backend.createWorkItem({ type, fields });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        throw new Error(adoErrorMessage(error));
      }
    },
  );
}
