const os = require('os');

// jest's default maxWorkers sizing reads os.cpus().length, which inside a
// cgroup-limited container (Docker --cpus, and apparently some CI runners)
// reports the HOST's full core count, not what's actually schedulable --
// confirmed live: 12 reported vs. 2 truly available under a --cpus=2
// container. With this run concurrently alongside two vitest processes
// (frontend, mcp-ado-server -- see the root package.json's `test` script),
// each defaulting to a similarly oversized worker/thread pool, the result
// is severe worker-vs-worker contention with almost no forward progress --
// confirmed live: this exact scenario measured 2000+ log lines of real
// test output over 10+ minutes without finishing, matching this repo's own
// CI hangs on "Run pnpm test". os.availableParallelism() (Node 18.4+/
// 19.4+; this repo requires >=22) is the cgroup-aware equivalent -- sizing
// off it keeps every environment (a real multi-core CI runner, a
// constrained container, a laptop) working with a worker pool that
// actually matches its real scheduling budget.
const availableCpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/test/**/*.e2e-spec.ts', '<rootDir>/test/**/*.spec.ts', '<rootDir>/src/**/*.spec.ts'],
  maxWorkers: Math.max(1, availableCpus - 1),
};
