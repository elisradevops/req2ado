import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AdoBackend } from './backends/types.js';
import type { AdoMcpConfig } from './config/env.js';
import { registerPingTool } from './tools/pingTool.js';

/**
 * Builds the Express app hosting the MCP Streamable HTTP transport.
 * `/health` is unauthenticated (container/orchestrator health checks).
 * `/mcp` requires `Authorization: Bearer <cfg.mcpBearer>` on every request.
 */
export function createMcpApp(backend: AdoBackend, cfg: AdoMcpConfig): express.Express {
  const app = express();
  app.use(express.json());

  app.get('/health', async (_req, res) => {
    res.json(await backend.ping());
  });

  app.use('/mcp', (req, res, next) => {
    const header = req.header('authorization') ?? '';
    if (header !== `Bearer ${cfg.mcpBearer}`) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });

  const mcpServer = new McpServer({ name: 'req2ado-ado-mcp-server', version: '0.1.0' });
  registerPingTool(mcpServer, backend);

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  app.post('/mcp', async (req, res) => {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  return app;
}
