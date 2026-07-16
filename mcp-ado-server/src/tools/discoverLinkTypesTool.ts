import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdoBackend } from '../backends/types.js';

/** Registers `ado_discover_link_types` — lists work-item link types available on this project. */
export function registerDiscoverLinkTypesTool(server: McpServer, backend: AdoBackend): void {
  server.registerTool(
    'ado_discover_link_types',
    {
      title: 'Discover ADO work-item link types',
      description:
        'Returns the work-item link types (referenceName/name/semanticHint) available on the ' +
        "target project's process template. Used to resolve trace/coverage link types " +
        '(Covers/CoveredBy/Affects/AffectedBy/etc.) at runtime instead of hardcoding them.',
      inputSchema: {},
    },
    async () => {
      const linkTypes = await backend.discoverLinkTypes();
      return { content: [{ type: 'text', text: JSON.stringify(linkTypes) }] };
    },
  );
}
