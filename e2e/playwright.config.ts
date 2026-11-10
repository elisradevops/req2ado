import { defineConfig, devices } from '@playwright/test';

// Browser matrix for the running-job screen's live view:
//   4 document types x 7 situations (tests/running-job.spec.ts)
//   x 2 widths (desktop 1440, phone 390) x reduced motion on/off (the four projects below).
// tests/review-hierarchy.spec.ts (the finished-job review screen) runs at 320, 390, 1024 and 1440.
// No backend and no model: the API is mocked per test and the event stream is a
// scripted fake (fixtures/harness.ts), so runs are deterministic and fast.

// E2E_PORT lets the suite run beside another dev server that already holds 4173.
const PORT = Number(process.env.E2E_PORT ?? 4173);

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: {
    timeout: 5_000,
    toHaveScreenshot: { animations: 'disabled', maxDiffPixelRatio: 0.02 },
  },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  // One baseline per project, named by project, so desktop and phone never share.
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{testFilePath}/{arg}{ext}',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    locale: 'en-US',
    timezoneId: 'UTC',
  },
  webServer: {
    // Builds the real production bundle, then serves it. Reuses a server already on the port.
    command: `sh -c "cd ../frontend && npx vite build && npx vite preview --port ${PORT} --strictPort"`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 240_000,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
    { name: 'phone', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 900 }, hasTouch: true } },
    {
      name: 'desktop-reduced-motion',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' },
      testIgnore: /review-hierarchy/,
    },
    {
      name: 'phone-reduced-motion',
      use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 900 }, hasTouch: true, reducedMotion: 'reduce' },
      testIgnore: /review-hierarchy/,
    },
    // The review-screen spec (tests/review-hierarchy.spec.ts) also runs at the
    // widths the other specs skip: the narrowest phone and a small laptop.
    {
      name: 'phone-320',
      use: { ...devices['Desktop Chrome'], viewport: { width: 320, height: 800 }, hasTouch: true },
      testMatch: /review-hierarchy/,
    },
    {
      name: 'laptop-1024',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1024, height: 800 } },
      testMatch: /review-hierarchy/,
    },
  ],
});
