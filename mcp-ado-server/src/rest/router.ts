import express from 'express';
import { z } from 'zod';
import type { AdoBackend } from '../backends/types.js';
import { adoOperations, getOperation } from '../operations/registry.js';
import { readCredential } from '../auth/authMiddleware.js';

/**
 * mcp-ado-server's ADO operations, exposed as plain REST (S9's MCP → REST
 * cutover — this server used to also speak the MCP protocol over a
 * Streamable HTTP transport at /mcp; that transport was removed once the
 * orchestrator's McpClient was cut over to this router and live-verified
 * end-to-end via scripts/run-golden-e2e.sh). Built off
 * src/operations/registry.ts — the same operation names (used as the
 * :operation path segment), zod input validation, backend calls, and
 * adoErrorMessage-wrapped error detail that used to also back the MCP
 * tools. `POST /api/ado/:operation` with a JSON body is the whole contract.
 */
export function createAdoRestRouter(backendFactory: (credential: ReturnType<typeof readCredential>) => AdoBackend): express.Router {
  const router = express.Router();

  router.post('/:operation', async (req, res) => {
    const op = getOperation(req.params.operation);
    if (!op) {
      res.status(404).json({ error: `unknown operation: ${req.params.operation}` });
      return;
    }

    const parsed = z.object(op.inputSchema).safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid input', details: parsed.error.flatten() });
      return;
    }

    try {
      const backend = backendFactory(readCredential(req));
      const result = await op.handler(backend, parsed.data);
      res.json(result);
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Not strictly needed by any caller yet, but a REST-shaped service without
  // a way to discover its own operations is a worse REST citizen than the
  // MCP transport it replaces (MCP has tools/list built into the protocol) —
  // cheap to add now, from the same registry, rather than backfilling later.
  router.get('/', (_req, res) => {
    res.json(adoOperations.map((op) => ({ name: op.name, title: op.title, description: op.description })));
  });

  return router;
}
