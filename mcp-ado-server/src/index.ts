import { createMcpApp } from './server.js';
import { loadConfig } from './config/env.js';
import { MockAdoBackend } from './backends/mockAdo.js';
import { RealAdoBackend } from './backends/realAdo.js';

const cfg = loadConfig();

const backendFactory =
  cfg.backend === 'real'
    ? (credential: import('./auth/patAuth.js').AdoCredential | undefined) => {
        // credential is guaranteed defined here — server.ts's /mcp middleware
        // already rejected the request with 401 if it were missing.
        return new RealAdoBackend(cfg, credential!);
      }
    : (() => {
        const mock = new MockAdoBackend(cfg.mockDbPath);
        return () => mock;
      })();

const app = createMcpApp(backendFactory, cfg);
app.listen(cfg.port, () => {
  // eslint-disable-next-line no-console -- startup banner, not app logging
  process.stdout.write(`req2ado mcp-ado-server listening on :${cfg.port} (backend=${cfg.backend})\n`);
});
