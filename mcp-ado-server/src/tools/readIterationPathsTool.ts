import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdoBackend } from '../backends/types.js';

/** Registers `ado_read_iteration_paths` — returns the nested ADO classification-node iteration-path tree. */
export function registerReadIterationPathsTool(server: McpServer, backend: AdoBackend): void {
  server.registerTool(
    'ado_read_iteration_paths',
    {
      title: 'Read ADO iteration paths',
      description: 'Returns the nested iteration-path (sprint) tree for the configured project, used to populate a real iteration-path picker instead of free text.',
      inputSchema: { depth: z.number().int().min(1).max(10).default(5), project: z.string().optional() },
    },
    async ({ depth, project }) => {
      const tree = await backend.readIterationPaths(depth, project);
      return { content: [{ type: 'text', text: JSON.stringify(tree) }] };
    },
  );
}
