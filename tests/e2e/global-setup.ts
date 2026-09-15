import { chromium, type FullConfig } from '@playwright/test';

/**
 * Next dev compiles each route the first time it is requested. Right after the dev server starts, that first compile can
 * outlast a 15-second assertion, or turn the sign-in dialog's client navigation into a full page load. Warm the routes
 * the journeys use before any test runs, so failures reflect the app rather than a cold compiler.
 */
export default async function globalSetup(config: FullConfig) {
  const baseURL = String(config.projects[0]?.use.baseURL ?? 'http://127.0.0.1:3100');
  const missing = '00000000-0000-4000-8000-000000000000';
  const paths = ['/', '/explore', '/requests', '/auctions', '/sign-in', '/sign-up', '/dashboard', '/buyer/orders', '/buyer/requests', '/buyer/requests/new',
    '/creator/services', '/creator/services/new', '/creator/requests', '/settings/profile', '/admin', '/admin/flags', `/orders/${missing}`, `/services/${missing}`, `/requests/${missing}`];
  // A route that never answers must not stall the whole run: give each warmup request 90 seconds.
  for (const path of paths) await fetch(new URL(path, baseURL), { signal: AbortSignal.timeout(90_000) }).catch(() => undefined);

  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const page = await browser.newPage({ baseURL });
    await page.goto('/explore');
    const login = page.getByRole('banner').getByRole('link', { name: 'Log in', exact: true });
    await page.waitForFunction(() => {
      const link = [...document.querySelectorAll('header a')].find((a) => a.textContent === 'Log in');
      return !!link && Object.keys(link).some((k) => k.startsWith('__reactProps'));
    }, undefined, { timeout: 60_000 });
    await login.click();
    await page.getByRole('dialog').waitFor({ timeout: 60_000 }).catch(() => undefined);
    // The join dialog is a separate intercepted route.
    await page.goto('/explore');
    const join = page.getByRole('banner').getByRole('link', { name: 'Get started', exact: true });
    await page.waitForFunction(() => {
      const link = [...document.querySelectorAll('header a')].find((a) => a.textContent === 'Get started');
      return !!link && Object.keys(link).some((k) => k.startsWith('__reactProps'));
    }, undefined, { timeout: 60_000 });
    await join.click();
    await page.getByRole('dialog').waitFor({ timeout: 60_000 }).catch(() => undefined);
  } finally {
    await browser.close();
  }
}
