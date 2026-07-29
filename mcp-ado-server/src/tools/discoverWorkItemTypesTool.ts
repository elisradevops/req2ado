import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdoBackend } from '../backends/types.js';

/** Registers `ado_discover_work_item_types` — lists work-item types, colors, and icon refs for the project's real process template. */
export function registerDiscoverWorkItemTypesTool(server: McpServer, backend: AdoBackend): void {
  server.registerTool(
    'ado_discover_work_item_types',
    {
      title: 'Discover ADO work-item types',
      description:
        'Returns the work-item types defined by the target project\'s actual process template (Agile/CMMI/Scrum/Basic/custom), each with its real color and icon reference. Replaces a hardcoded Epic/Feature/Requirement color assumption.',
      inputSchema: { project: z.string().optional() },
    },
    async ({ project }) => {
      const types = await backend.discoverWorkItemTypes(project);
      return { content: [{ type: 'text', text: JSON.stringify(types) }] };
    },
  );
}
