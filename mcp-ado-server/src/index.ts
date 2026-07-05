import { createMcpApp } from './server.js';
import { loadConfig } from './config/env.js';
import { MockAdoBackend } from './backends/mockAdo.js';

const cfg = loadConfig();

if (cfg.backend === 'real') {
  // RealAdoBackend (Tasks 1-7) takes a per-request AdoCredential in its
  // constructor, but this bootstrap constructs ONE backend at process
  // startup for the app's whole lifetime — a shape that only fits
  // MockAdoBackend, which needs no per-user credential. Per-request
  // credential wiring (how the orchestrator forwards a user's ADO PAT
  // through to a stateless MCP tool call — e.g. a custom request header
  // read inside server.ts's per-request handler) is a real design decision
  // not yet specified precisely enough in docs/architecture.md to implement
  // without guessing. Flagging this explicitly rather than picking an
  // unreviewed guess: THIS MUST BE RESOLVED (a short design note in
  // docs/architecture.md, then wiring server.ts to construct a fresh
  // RealAdoBackend per request from that header) before ADO_BACKEND=real
  // can run in this process. Until then, real ADO integration testing
  // happens via directly instantiating RealAdoBackend in tests (Tasks 1-7),
  // not via this process's live HTTP path.
  throw new Error(
    'ADO_BACKEND=real requires per-request credential wiring not yet resolved — see the comment above this line. Set ADO_BACKEND=mock for now.',
  );
}

const backend = new MockAdoBackend(cfg.mockDbPath);
const app = createMcpApp(backend, cfg);
app.listen(cfg.port, () => {
  // eslint-disable-next-line no-console -- startup banner, not app logging
  process.stdout.write(`req2ado mcp-ado-server listening on :${cfg.port} (backend=${cfg.backend})\n`);
});
