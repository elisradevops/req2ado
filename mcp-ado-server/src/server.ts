import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AdoBackend } from './backends/types.js';
import type { AdoCredential } from './auth/patAuth.js';
import type { AdoMcpConfig } from './config/env.js';
import { registerPingTool } from './tools/pingTool.js';
import { registerDiscoverFieldsTool } from './tools/discoverFieldsTool.js';
import { registerReadAreaPathsTool } from './tools/readAreaPathsTool.js';
import { registerDiscoverProjectsTool } from './tools/discoverProjectsTool.js';
import { registerCreateWorkItemTool } from './tools/createWorkItemTool.js';
import { registerLinkParentChildTool } from './tools/linkParentChildTool.js';
import { registerSetFieldsTool } from './tools/setFieldsTool.js';
import { registerQueryIdsTool } from './tools/queryIdsTool.js';
import { registerGetWorkItemsBatchTool } from './tools/getWorkItemsBatchTool.js';
import { registerDiscoverLinkTypesTool } from './tools/discoverLinkTypesTool.js';
import { registerLinkWorkItemsTool } from './tools/linkWorkItemsTool.js';
import { timingSafeEqualBearer } from './auth/timingSafeEqualBearer.js';

/**
 * `backendFactory` is called once per /mcp request, given the request's
 * per-user AdoCredential (undefined when backend===mock, which needs none).
 * Real backend: a fresh RealAdoBackend per request, scoped to that user's
 * own PAT — never a shared, process-lifetime credential. Mock backend: the
 * SAME shared MockAdoBackend instance every time (it's a stateful SQLite
 * store meant to simulate ADO's persistence across requests/tests, not a
 * per-user resource).
 */
export type BackendFactory = (credential: AdoCredential | undefined) => AdoBackend;

function readCredential(req: express.Request): AdoCredential | undefined {
  const orgUrl = req.header('x-ado-org-url');
  const pat = req.header('x-ado-pat');
  if (!orgUrl || !pat) return undefined;
  return { orgUrl, pat };
}

/**
 * Builds the Express app hosting the MCP Streamable HTTP transport.
 * `/health` is unauthenticated (container/orchestrator health checks).
 * `/mcp` requires `Authorization: Bearer <cfg.mcpBearer>` on every request.
 */
export function createMcpApp(backendFactory: BackendFactory, cfg: AdoMcpConfig): express.Express {
  const app = express();
  app.use(express.json());

  app.get('/health', async (_req, res) => {
    // Liveness check must never depend on a credentialed downstream call —
    // when backend===real, backendFactory(undefined) would construct a
    // RealAdoBackend with no credential and its ping() would dereference
    // credential.orgUrl, throwing on every single health check. Only the
    // mock backend (credential-less by design) is safe to actually ping;
    // for real, report liveness without touching the backend at all.
    if (cfg.backend === 'real') {
      res.json({ ok: true, backend: 'real' });
      return;
    }
    res.json(await backendFactory(undefined).ping());
  });

  // Separate from /health for k8s readiness-probe semantics parity with
  // orchestrator/ingestion (a readiness failure removes the pod from
  // load-balancing without restarting it, unlike a liveness failure).
  // Real-ADO reachability genuinely cannot be checked here: this
  // architecture deliberately has no server-level ADO credential (only
  // per-request X-Ado-Org-Url/X-Ado-Pat headers) -- backendFactory(undefined)
  // for backend==='real' has no credential.orgUrl to call. This is the same
  // structural limitation /health's own comment above documents, not a new
  // gap -- /ready is honest about it rather than faking a check that can't
  // exist for this backend.
  app.get('/ready', async (_req, res) => {
    if (cfg.backend === 'real') {
      res.json({ ok: true, backend: 'real', note: 'real-ADO reachability requires a per-request credential, not checkable here' });
      return;
    }
    const pingResult = await backendFactory(undefined).ping();
    res.status(pingResult.ok ? 200 : 503).json(pingResult);
  });

  app.use('/mcp', (req, res, next) => {
    const header = req.header('authorization') ?? '';
    if (!timingSafeEqualBearer(header, `Bearer ${cfg.mcpBearer}`)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    if (cfg.backend === 'real' && !readCredential(req)) {
      res.status(401).json({ error: 'missing X-Ado-Org-Url / X-Ado-Pat headers for real backend' });
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
    const backend = backendFactory(readCredential(req));
    const mcpServer = new McpServer({ name: 'req2ado-ado-mcp-server', version: '0.1.0' });
    registerPingTool(mcpServer, backend);
    registerDiscoverFieldsTool(mcpServer, backend);
    registerReadAreaPathsTool(mcpServer, backend);
    registerDiscoverProjectsTool(mcpServer, backend);
    registerCreateWorkItemTool(mcpServer, backend);
    registerLinkParentChildTool(mcpServer, backend);
    registerSetFieldsTool(mcpServer, backend);
    registerQueryIdsTool(mcpServer, backend);
    registerGetWorkItemsBatchTool(mcpServer, backend);
    registerDiscoverLinkTypesTool(mcpServer, backend);
    registerLinkWorkItemsTool(mcpServer, backend);
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
