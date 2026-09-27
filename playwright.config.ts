import { defineConfig } from '@playwright/test';

// The machine this runs on decides the browser: Chrome by default, or another channel / an explicit binary
// (E2E_BROWSER_EXECUTABLE) where Chrome is not installed, such as a container with only Chromium.
const executablePath = process.env.E2E_BROWSER_EXECUTABLE;
const browser = executablePath ? { launchOptions: { executablePath } } : { channel: process.env.E2E_BROWSER_CHANNEL ?? 'chrome' };

export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: 'test-results/e2e',
  use: {
    // The whole marketplace: a dev server started with MARKETPLACE_SCOPE=full (src/lib/scope.ts).
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3100',
    ...browser,
    // `dateTimeLocal` builds its wall clock in this process, so the browser must read it on the same clock. Tests that
    // care about zones set their own with `test.use({ timezoneId })`.
    timezoneId: 'UTC',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // Only auctions are shown unless MARKETPLACE_SCOPE=full, and one server runs one scope. The journeys through the whole
  // marketplace need a server with it set to full; auctions-only.spec.ts checks the default on a second server.
  projects: [
    { name: 'marketplace', testIgnore: /auctions-only\.spec\.ts$/ },
    { name: 'auctions-only', testMatch: /auctions-only\.spec\.ts$/, use: { baseURL: process.env.E2E_AUCTIONS_BASE_URL ?? 'http://127.0.0.1:3101' } },
  ],
  // Claude starts Next against the seeded dev DB; no webServer or browser install.
});
