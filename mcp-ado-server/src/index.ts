import './tracing.js';
import { createMcpApp } from './server.js';
import { loadConfig } from './config/env.js';
import { MockAdoBackend } from './backends/mockAdo.js';
import { RealAdoBackend } from './backends/realAdo.js';

const cfg = loadConfig();

const backendFactory =
  cfg.backend === 'real'
    ? (credential: import('./auth/patAuth.js').AdoCredential | undefined) => {
        // credential is guaranteed defined here — server.ts's /api/ado auth
        // middleware already rejected the request with 401 if it were missing.
        return new RealAdoBackend(cfg, credential!);
      }
    : (() => {
        const mock = new MockAdoBackend(cfg.mockDbPath);
        return () => mock;
      })();

const app = createMcpApp(backendFactory, cfg);
const httpServer = app.listen(cfg.port, () => {
  // eslint-disable-next-line no-console -- startup banner, not app logging
  process.stdout.write(`req2ado mcp-ado-server listening on :${cfg.port} (backend=${cfg.backend})\n`);
});

// Previously no SIGTERM/SIGINT handling at all -- a k8s pod termination
// killed this process immediately, mid in-flight ADO write, with no chance
// to finish. server.close() stops accepting new connections and waits for
// in-flight requests to complete before its callback fires.
function shutdown(signal: string): void {
  // eslint-disable-next-line no-console -- process logging, not app logging
  console.error(`${signal} received, closing mcp-ado-server gracefully...`);
  httpServer.close(() => process.exit(0));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
