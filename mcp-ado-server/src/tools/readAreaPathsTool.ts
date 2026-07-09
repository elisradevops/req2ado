import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdoBackend } from '../backends/types.js';

/** Registers `ado_read_area_paths` — returns the nested ADO classification-node area-path tree. */
export function registerReadAreaPathsTool(server: McpServer, backend: AdoBackend): void {
  server.registerTool(
    'ado_read_area_paths',
    {
      title: 'Read ADO area paths',
      description: 'Returns the nested area-path tree for the configured project, used to populate a real area-path picker instead of free text.',
      inputSchema: { depth: z.number().int().min(1).max(10).default(5) },
    },
    async ({ depth }) => {
      const tree = await backend.readAreaPaths(depth);
      return { content: [{ type: 'text', text: JSON.stringify(tree) }] };
    },
  );
}
