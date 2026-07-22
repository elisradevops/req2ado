import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdoBackend } from '../backends/types.js';
import { adoErrorMessage } from '../backends/adoErrorMessage.js';

export function registerLinkParentChildTool(server: McpServer, backend: AdoBackend): void {
  server.registerTool(
    'ado_link_parent_child',
    {
      title: 'Link a child work item to its parent',
      description: 'Adds a System.LinkTypes.Hierarchy-Reverse relation from childId to parentId.',
      inputSchema: { childId: z.number(), parentId: z.number() },
    },
    async ({ childId, parentId }) => {
      try {
        await backend.linkParentChild(childId, parentId);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
      } catch (error) {
        throw new Error(adoErrorMessage(error));
      }
    },
  );
}
