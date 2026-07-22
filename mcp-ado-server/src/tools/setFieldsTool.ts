import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdoBackend } from '../backends/types.js';
import { adoErrorMessage } from '../backends/adoErrorMessage.js';

/** Registers `ado_set_fields` — merges given fields onto an existing work item. */
export function registerSetFieldsTool(server: McpServer, backend: AdoBackend): void {
  server.registerTool(
    'ado_set_fields',
    {
      title: 'Set fields on an existing ADO work item',
      description: 'Merges the given fields onto an existing work item without changing its type or parent link.',
      inputSchema: { id: z.number(), fields: z.record(z.string()) },
    },
    async ({ id, fields }) => {
      try {
        await backend.setFields(id, fields);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
      } catch (error) {
        throw new Error(adoErrorMessage(error));
      }
    },
  );
}
