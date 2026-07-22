import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdoBackend } from '../backends/types.js';
import { adoErrorMessage } from '../backends/adoErrorMessage.js';

/** Registers `ado_get_work_items_batch` — bulk-reads work items by id, chunked/concurrency-bounded by the backend. */
export function registerGetWorkItemsBatchTool(server: McpServer, backend: AdoBackend): void {
  server.registerTool(
    'ado_get_work_items_batch',
    {
      title: 'Bulk-read ADO work items by id',
      description:
        'Reads multiple work items by id in one call, chunked at the backend\'s configured batch size with bounded concurrency. Unknown ids are simply omitted from the result.',
      inputSchema: { ids: z.array(z.number()) },
    },
    async ({ ids }) => {
      try {
        const items = await backend.getWorkItemsBatch(ids);
        return { content: [{ type: 'text', text: JSON.stringify(items) }] };
      } catch (error) {
        throw new Error(adoErrorMessage(error));
      }
    },
  );
}
