import { createMcpApp } from './server.js';
import { loadConfig } from './config/env.js';
import { MockAdoBackend } from './backends/mockAdo.js';

const cfg = loadConfig();
const backend = cfg.backend === 'mock' ? new MockAdoBackend(cfg.mockDbPath) : undefined;
if (!backend) {
  throw new Error('Real ADO backend is not implemented until Phase 7 — set ADO_BACKEND=mock for now.');
}

const app = createMcpApp(backend, cfg);
app.listen(cfg.port, () => {
  // eslint-disable-next-line no-console -- startup banner, not app logging
  process.stdout.write(`req2ado mcp-ado-server listening on :${cfg.port} (backend=${cfg.backend})\n`);
});
