import express from 'express';
import type { AdoBackend } from './backends/types.js';
import type { AdoCredential } from './auth/patAuth.js';
import type { AdoMcpConfig } from './config/env.js';
import { createAdoAuthMiddleware } from './auth/authMiddleware.js';
import { createAdoRestRouter } from './rest/router.js';

/**
 * `backendFactory` is called once per /api/ado request, given the request's
 * per-user AdoCredential (undefined when backend===mock, which needs none).
 * Real backend: a fresh RealAdoBackend per request, scoped to that user's
 * own PAT — never a shared, process-lifetime credential. Mock backend: the
 * SAME shared MockAdoBackend instance every time (it's a stateful SQLite
 * store meant to simulate ADO's persistence across requests/tests, not a
 * per-user resource).
 */
export type BackendFactory = (credential: AdoCredential | undefined) => AdoBackend;

/**
 * Builds the Express app hosting the ADO REST API (S9's MCP → REST cutover
 * — this used to also host an MCP Streamable HTTP transport at /mcp; that
 * transport, the 16 src/tools/*.ts MCP tool registrations, and the
 * @modelcontextprotocol/sdk dependency were removed once the orchestrator's
 * McpClient was cut over to /api/ado and live-verified end-to-end via
 * scripts/run-golden-e2e.sh — nothing calls MCP here anymore. Operation
 * definitions now live once, in src/operations/registry.ts.
 * `/health` is unauthenticated (container/orchestrator health checks).
 * `/api/ado` requires `Authorization: Bearer <cfg.mcpBearer>` on every request.
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

  app.use('/api/ado', createAdoAuthMiddleware(cfg), createAdoRestRouter(backendFactory));

  return app;
}
