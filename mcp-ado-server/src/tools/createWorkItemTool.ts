import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdoBackend } from '../backends/types.js';

export function registerCreateWorkItemTool(server: McpServer, backend: AdoBackend): void {
  server.registerTool(
    'ado_create_work_item',
    {
      title: 'Create an ADO work item',
      description: 'Creates a new work item of the given type with the given fields. Does not link a parent — use ado_link_parent_child separately.',
      inputSchema: {
        type: z.enum(['Epic', 'Feature', 'Requirement']),
        fields: z.record(z.string()),
      },
    },
    async ({ type, fields }) => {
      const result = await backend.createWorkItem({ type, fields });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );
}
