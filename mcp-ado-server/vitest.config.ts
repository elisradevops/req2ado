import { defineConfig } from 'vitest/config';
import os from 'node:os';

// See frontend/vitest.config.ts's own comment for the full story: vitest's
// default thread-pool sizing reads os.cpus().length, which misreports a
// container's real schedulable core count -- this repo's root `pnpm test`
// runs this suite concurrently alongside frontend's vitest AND
// orchestrator's jest, and three oversized pools fighting for the same few
// real cores is the confirmed root cause of this repo's CI hangs on
// "Run pnpm test". os.availableParallelism() is cgroup-aware.
const availableCpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: { reporter: ['text', 'lcov'] },
    poolOptions: { threads: { maxThreads: Math.max(1, availableCpus - 1), minThreads: 1 } },
  },
});
