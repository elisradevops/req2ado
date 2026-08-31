import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
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
