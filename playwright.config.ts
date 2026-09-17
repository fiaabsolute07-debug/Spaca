import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: 'test-results/e2e',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3100',
    channel: 'chrome',
    // `dateTimeLocal` builds its wall clock in this process, so the browser must read it on the same clock. Tests that
    // care about zones set their own with `test.use({ timezoneId })`.
    timezoneId: 'UTC',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // Claude starts Next against the seeded dev DB; no webServer or browser install.
});
