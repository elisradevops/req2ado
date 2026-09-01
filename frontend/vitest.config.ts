import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import os from 'node:os';

// vitest's default thread-pool sizing reads os.cpus().length, which inside
// a cgroup-limited container (Docker --cpus, and apparently some CI
// runners) reports the HOST's full core count, not what's actually
// schedulable -- confirmed live: 12 reported vs. 2 truly available under a
// --cpus=2 container. This repo's root `pnpm test` runs this suite
// concurrently alongside orchestrator's jest AND mcp-ado-server's own
// vitest (see the root package.json's `test` script) -- three worker/
// thread pools each oversized off the same misreported number causes
// severe contention with almost no forward progress, confirmed live as the
// actual root cause of this repo's CI hangs on "Run pnpm test" (2000+
// lines of real test output over 10+ minutes without finishing).
// os.availableParallelism() (Node 18.4+/19.4+; this repo requires >=22) is
// the cgroup-aware equivalent.
const availableCpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
    poolOptions: { threads: { maxThreads: Math.max(1, availableCpus - 1), minThreads: 1 } },
    // Default (5000ms) is tuned for a fast, uncontended local machine.
    // Reproduced live in a resource-constrained container (matching GitHub
    // Actions' shared runners): the whole suite runs 3x+ slower under real
    // contention, and a DIFFERENT test hits the 5000ms wall each run
    // (confirmed: KnowledgeBase/NewJobWizard/Settings one run,
    // JobDetail another) -- not a bug in any specific test, the fixed
    // per-test budget is just too tight once CPU is shared. 20000ms cut the
    // failure rate from ~every run to roughly 1-in-4 under a deliberately
    // oversubscribed repro container; 30000ms for real headroom. Still well
    // below "never times out" -- a genuine infinite hang still fails, just
    // not a slow-but-finite one.
    testTimeout: 30000,
  },
});
