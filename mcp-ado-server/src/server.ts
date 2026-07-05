import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AdoBackend } from './backends/types.js';
import type { AdoMcpConfig } from './config/env.js';
import { registerPingTool } from './tools/pingTool.js';
import { registerDiscoverFieldsTool } from './tools/discoverFieldsTool.js';
import { registerCreateWorkItemTool } from './tools/createWorkItemTool.js';
import { registerLinkParentChildTool } from './tools/linkParentChildTool.js';

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
    // Plain string equality is acceptable for a Phase 0 shared infra secret over HTTP;
    // move to a constant-time compare (e.g. Node's crypto.timingSafeEqual) during
    // Phase 8 security hardening.
    if (header !== `Bearer ${cfg.mcpBearer}`) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });

  // Stateless mode (`sessionIdGenerator: undefined`): per the MCP SDK, a
  // StreamableHTTPServerTransport in stateless mode can only ever handle a
  // single request — reusing one across requests throws internally. The SDK's
  // own stateless example (examples/server/simpleStatelessStreamableHttp.ts)
  // creates a fresh McpServer + transport per request; we follow that pattern
  // here instead of connecting once for the app's lifetime.
  app.post('/mcp', async (req, res) => {
    const mcpServer = new McpServer({ name: 'req2ado-ado-mcp-server', version: '0.1.0' });
    registerPingTool(mcpServer, backend);
    registerDiscoverFieldsTool(mcpServer, backend);
    registerCreateWorkItemTool(mcpServer, backend);
    registerLinkParentChildTool(mcpServer, backend);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on('close', () => {
      void transport.close();
      void mcpServer.close();
    });

    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  return app;
}
