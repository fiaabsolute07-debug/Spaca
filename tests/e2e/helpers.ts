import { randomUUID } from 'node:crypto';
import { expect, type Locator, type Page } from '@playwright/test';
import { FIXTURE_PERSONAS, type FixturePersonaKey } from '../../src/lib/fixtures';

export const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3100';
export const uniqueSuffix = () => `${Date.now()}-${randomUUID().slice(0, 8)}`;
export const creatorName = FIXTURE_PERSONAS.creator_c.displayName;

export async function login(page: Page, persona: FixturePersonaKey) {
  const response = await page.request.post('/api/dev/session', {
    data: { persona },
    headers: { Origin: new URL(baseURL).origin, Accept: 'application/json' },
  });
  expect(response.status(), `Fixture login for ${persona}`).toBe(200);
  expect(await response.json()).toMatchObject({ persona, userId: FIXTURE_PERSONAS[persona].id });
}

export async function runJobs(page: Page) {
  const response = await page.request.post('/api/dev/jobs', {
    headers: { Origin: new URL(baseURL).origin, Accept: 'application/json' },
  });
  expect(response.status(), 'Local jobs hook').toBe(200);
  const body = await response.json() as {
    reports: { job: string; examined: number; outcomes: Record<string, number> }[];
  };
  expect(Array.isArray(body.reports)).toBe(true);
  expect(body.reports.map(report => report.job)).toContain('release_ready_settlements');
  for (const report of body.reports) {
    expect(report.examined, report.job).toBeGreaterThanOrEqual(0);
    expect(report.outcomes.ERROR ?? 0, `${report.job}: ${JSON.stringify(report.outcomes)}`).toBe(0);
  }
  return body.reports;
}

export async function expectNoHorizontalOverflow(page: Page, soft = false) {
  await page.evaluate(() => document.fonts.ready);
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
  }));
  const check = soft ? expect.soft : expect;
  check(dimensions.content, `${page.url()}: ${JSON.stringify(dimensions)}`)
    .toBeLessThanOrEqual(dimensions.viewport + 1);
}

export async function visit(page: Page, path: string) {
  const response = await page.goto(path);
  expect(response?.status(), path).toBe(200);
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  // Next.js renders an empty route-announcer alert outside <main>; app errors render inside it.
  await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
}

// Current CommandForm and local checkout are native POST forms, with 303 navigation.
export async function submit(page: Page, button: Locator) {
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    button.click(),
  ]);
  expect(new URL(page.url()).searchParams.has('error'), page.url()).toBe(false);
  // Next.js renders an empty route-announcer alert outside <main>; app errors render inside it.
  await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
}

/**
 * Picks an option in a spaca select (Radix UI): opens the combobox named by its label and clicks the option by its
 * visible text. Retries the open until the client component has hydrated.
 */
export async function chooseOption(page: Page, scope: Page | Locator, label: string, option: string | RegExp) {
  const trigger = scope.getByRole('combobox', { name: label, exact: true });
  const listbox = page.getByRole('listbox');
  await expect(async () => {
    if (!(await listbox.isVisible())) await trigger.click({ timeout: 2_000 });
    await expect(listbox).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await listbox.getByRole('option', { name: option, exact: typeof option === 'string' }).click();
  await expect(listbox).toHaveCount(0);
  await expect(trigger).toHaveText(option);
}

/** Client components ignore input until React hydrates them; wait for React's props on the element. */
export async function waitForHydration(locator: Locator) {
  await expect.poll(() => locator.evaluate((el) => Object.keys(el).some((k) => k.startsWith('__reactProps')))).toBe(true);
}

export function orderPath(page: Page) {
  const path = new URL(page.url()).pathname;
  expect(path).toMatch(/^\/orders\/[0-9a-f-]{36}$/);
  return path;
}

/** The order eyebrow shows humanized labels, e.g. `Book order · Awaiting payment` for AWAITING_PAYMENT. */
export async function expectOrderState(page: Page, state: string) {
  const label = state.replaceAll('_', ' ').toLowerCase();
  await expect(page.getByText(new RegExp(`^(Book|Request|Auction) order · ${label.charAt(0).toUpperCase()}${label.slice(1)}$`))).toBeVisible();
}

/** Each journey owns a newly published service, created through the UI as creator_c. */
export async function createPublishedService(page: Page, purpose: string) {
  const title = `E2E ${purpose} ${uniqueSuffix()}`;
  await login(page, 'creator_c');
  await visit(page, '/creator/services/new');
  await page.getByLabel('Service title', { exact: true }).fill(title);
  await chooseOption(page, page, 'What are you offering?', 'Create · content you deliver');
  await page.getByLabel('Price (USD)', { exact: true }).fill('100');
  await page.getByLabel('Delivery time (hours)').fill('24');
  await page.getByLabel('Scope and deliverables').fill(`A complete launch narrative with one revision for ${title}.`);
  for (let n = 1; n <= 3; n++) {
    // These local sample references are stored only; the test never navigates to them.
    await page.getByLabel(`Sample URL ${n}`, { exact: true }).fill(`${baseURL}/?sample=${encodeURIComponent(title)}-${n}`);
    await page.getByLabel(`Sample title ${n}`, { exact: true }).fill(`${title} sample ${n}`);
  }
  await submit(page, page.getByRole('button', { name: 'Save draft service', exact: true }));
  // Service panels have no semantic container role; scope by their unique h3.
  const card = page.locator('div.panel').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  await expect(card.getByText('Draft', { exact: true })).toBeVisible();
  await submit(page, card.getByRole('button', { name: 'Publish', exact: true }));
  await expect(card.getByText('Published', { exact: true })).toBeVisible();
  const path = await card.getByRole('link', { name: 'Open public page ›', exact: true }).getAttribute('href');
  expect(path).toMatch(/^\/services\/[0-9a-f-]{36}$/);
  return { title, path: path! };
}

export async function bookFromExplore(page: Page, title: string) {
  await login(page, 'buyer_a');
  await visit(page, '/explore');
  // Published services are newest first; each test just created creator_c's first entry.
  const first = page.getByRole('main').getByRole('link').filter({
    has: page.getByRole('heading', { level: 3 }),
    hasText: creatorName,
  }).first();
  await expect(first.getByRole('heading', { name: title, exact: true })).toBeVisible();
  // Wide screens (≥1024px) select the card and show its details beside the list; narrow screens open the service page.
  await waitForHydration(first);
  if ((page.viewportSize()?.width ?? 1280) >= 1024) {
    await first.click();
    await expect(page.getByRole('article', { name: `Details: ${title}` })).toBeVisible();
    await submit(page, page.getByRole('article', { name: `Details: ${title}` }).getByRole('link', { name: 'View full page ›' }));
  } else {
    await submit(page, first);
  }
  await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: `By ${creatorName} ›` })).toBeVisible();
  await page.getByLabel('Tell the creator about your project').fill(`Project brief ${uniqueSuffix()}: Write a launch narrative for a developer tool with a clear audience and CTA.`);
  await page.getByRole('checkbox', { name: /I agree that version/ }).check();
  await submit(page, page.getByRole('button', { name: 'Reserve this service', exact: true }));
  const path = orderPath(page);
  await expectOrderState(page, 'AWAITING_PAYMENT');
  return path;
}

export async function payOrder(page: Page) {
  await expectOrderState(page, 'AWAITING_PAYMENT');
  await submit(page, page.getByRole('button', { name: 'Pay with local test provider', exact: true }));
  await expectOrderState(page, 'FUNDED');
  await expect(page.getByRole('status')).toContainText('Payment confirmed by the provider');
}

export async function startOrder(page: Page, path: string) {
  await login(page, 'creator_c');
  await visit(page, path);
  await submit(page, page.getByRole('button', { name: 'Start work', exact: true }));
  await expectOrderState(page, 'IN_PROGRESS');
}

export async function deliverText(page: Page, body: string) {
  await page.getByLabel('Delivery note', { exact: true }).fill(body);
  await submit(page, page.getByRole('button', { name: 'Submit delivery', exact: true }));
  await expectOrderState(page, 'DELIVERED');
  await expect(page.getByText(body, { exact: true })).toBeVisible();
}

// datetime-local strings are parsed by the Next server; ask Claude to match its TZ to E2E.
export function dateTimeLocal(date: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Opens the header Account menu (workspace navigation) and returns its navigation landmark. */
export async function openAccountMenu(page: Page) {
  const button = page.getByRole('banner').getByRole('button', { name: 'Account', exact: true });
  await waitForHydration(button);
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
  const menu = page.getByRole('navigation', { name: 'Account menu' });
  await expect(menu).toBeVisible();
  return menu;
}

/** The operator card for one feature flag on /admin/flags. Signs in as the admin persona. */
export async function flagCard(page: Page, key: string) {
  await login(page, 'admin');
  await visit(page, '/admin/flags');
  return page.locator('section.panel').filter({ has: page.getByRole('heading', { name: key, exact: true }) });
}

export async function flagEnabled(page: Page, key: string): Promise<boolean> {
  return (await flagCard(page, key)).getByText('Enabled', { exact: true }).isVisible();
}

/** Changes a flag through the console, which requires an audit reason. */
export async function setFlag(page: Page, key: string, enabled: boolean, reason: string) {
  const card = await flagCard(page, key);
  await chooseOption(page, card, 'Enabled (admin only)', enabled ? 'true' : 'false');
  await card.getByLabel(/Reason for the audit log/).fill(reason);
  await submit(page, card.getByRole('button', { name: 'Save flag', exact: true }));
}
