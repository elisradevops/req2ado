import type express from 'express';
import type { AdoCredential } from './patAuth.js';
import type { AdoMcpConfig } from '../config/env.js';
import { timingSafeEqualBearer } from './timingSafeEqualBearer.js';

/** Reads the per-request ADO credential forwarded by the orchestrator, if present. */
export function readCredential(req: express.Request): AdoCredential | undefined {
  const orgUrl = req.header('x-ado-org-url');
  const pat = req.header('x-ado-pat');
  if (!orgUrl || !pat) return undefined;
  return { orgUrl, pat };
}

/**
 * Shared by both the /mcp and /api/ado route groups (S9's REST cutover adds
 * the latter): rejects requests missing `Authorization: Bearer <cfg.mcpBearer>`,
 * and, when backend==='real', requests missing the X-Ado-Org-Url/X-Ado-Pat
 * credential headers. Extracted out of server.ts's /mcp-only middleware so
 * both transports enforce the identical check instead of two copies drifting.
 */
export function createAdoAuthMiddleware(cfg: AdoMcpConfig): express.RequestHandler {
  return (req, res, next) => {
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
  };
}
