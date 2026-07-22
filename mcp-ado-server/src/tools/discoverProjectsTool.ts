import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdoBackend } from '../backends/types.js';

/** Registers `ado_discover_projects` — lists ADO team projects in the org. */
export function registerDiscoverProjectsTool(server: McpServer, backend: AdoBackend): void {
  server.registerTool(
    'ado_discover_projects',
    {
      title: 'Discover ADO team projects',
      description: 'Returns the list of ADO team projects in the org, used to populate a project picker before area-path/field selection.',
      inputSchema: {},
    },
    async () => {
      const projects = await backend.discoverProjects();
      return { content: [{ type: 'text', text: JSON.stringify(projects) }] };
    },
  );
}
