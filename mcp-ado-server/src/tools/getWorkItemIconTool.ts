import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdoBackend } from '../backends/types.js';

/** Registers `ado_get_work_item_icon` — fetches icon image bytes (base64) for an icon id + color. */
export function registerGetWorkItemIconTool(server: McpServer, backend: AdoBackend): void {
  server.registerTool(
    'ado_get_work_item_icon',
    {
      title: 'Get ADO work-item icon',
      description:
        'Fetches the icon image for a work-item type (icon id + color from ado_discover_work_item_types) as base64. Server-scoped, not project-scoped.',
      inputSchema: { iconId: z.string(), color: z.string() },
    },
    async ({ iconId, color }) => {
      const icon = await backend.getWorkItemIcon(iconId, color);
      return { content: [{ type: 'text', text: JSON.stringify(icon) }] };
    },
  );
}
