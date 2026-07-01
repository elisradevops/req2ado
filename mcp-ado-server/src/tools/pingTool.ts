import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdoBackend } from '../backends/types.js';

/** Registers `ado_ping` — a trivial liveness/backend-identity check for MCP clients. */
export function registerPingTool(server: McpServer, backend: AdoBackend): void {
  server.registerTool(
    'ado_ping',
    {
      title: 'Ping the ADO backend',
      description: 'Returns which backend (mock|real) is wired in and confirms it is reachable.',
      inputSchema: {},
    },
    async () => {
      const result = await backend.ping();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );
}
