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

/**
 * The dev server compiles routes on demand and drops ones idle for a while. Recompiling one pushes a hot update to the
 * page already open, which reloads it and aborts a navigation started at that moment (net::ERR_ABORTED). That abort
 * says nothing about the app, so the navigation is retried; any other failure is not.
 */
async function gotoAllowingDevReload(page: Page, path: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await page.goto(path);
    } catch (error) {
      if (attempt >= 3 || !String(error).includes('net::ERR_ABORTED')) throw error;
      await page.waitForLoadState('load').catch(() => {});
    }
  }
}

export async function visit(page: Page, path: string) {
  const response = await gotoAllowingDevReload(page, path);
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
 * The shared dev database keeps every account earlier runs linked, and a creator may link only ten. Before linking a new
 * one, remove accounts that browser tests linked (handles e2e… or perf…) until there is room; an account a published
 * service still posts from cannot be removed, so those are skipped.
 */
export async function freeLinkedAccountSlot(page: Page) {
  const accounts = page.getByRole('region', { name: 'Linked accounts' });
  const handles = (await accounts.getByRole('link').allInnerTexts()).map((text) => text.trim()).filter((text) => /^@(e2e|perf)\d/.test(text));
  for (const handle of handles) {
    if ((await accounts.locator('.record').count()) < 10) return;
    const record = accounts.locator('.record').filter({ has: page.getByRole('link', { name: handle, exact: true }) });
    await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), record.getByRole('button', { name: 'Remove', exact: true }).click()]);
  }
  expect(await accounts.locator('.record').count(), 'no removable test account left to free a slot').toBeLessThan(10);
}

/** Picks the kind of service (Create, Publish, Access, Digital) in the new-service form; its terms appear under it. */
export async function chooseServiceType(scope: Page | Locator, type: 'Create' | 'Publish' | 'Access' | 'Digital') {
  const radio = scope.getByRole('radio', { name: new RegExp(`^${type}\\b`) });
  await waitForHydration(radio);
  await radio.check();
  await expect(radio).toBeChecked();
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
/**
 * Moves the brief form on to its next step (src/components/campaign/brief-steps.tsx). The button only appears once
 * the page is interactive, and it refuses to move while a field on the step is unanswered.
 */
export async function nextBriefStep(page: Page) {
  const next = page.getByRole('button', { name: 'Next', exact: true });
  await waitForHydration(next);
  await next.click();
}

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
  await chooseServiceType(page, 'Create');
  await page.getByLabel('Price (USD)', { exact: true }).fill('100');
  await page.getByLabel('Delivery time (hours)').fill('24');
  await page.getByLabel('Scope and deliverables').fill(`A complete launch narrative with one revision for ${title}.`);
  // One link sample is enough to publish. Uploaded samples cost an upload intent, and creator_c has a budget of 30 an
  // hour across the whole suite, so only the work-sample tests upload files.
  await page.getByLabel('Link to work online (optional)', { exact: true }).fill(`${baseURL}/?sample=${encodeURIComponent(title)}`);
  await page.getByLabel('What that work is', { exact: true }).fill(`${title} sample link`);
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

// 1×1 PNG, for profile photos and logos.
export const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==', 'base64');

/**
 * Create an account in the open "Create your account" dialog: the account type first, then email and password.
 * New accounts land on account setup (/welcome).
 */
/** A sandbox X username unique to this run (X usernames are at most 15 characters). */
export const xUsername = () => `e2e${Date.now().toString(36).slice(-7)}${randomUUID().slice(0, 4)}`;

/** Authorizes on the local stand-in for X's consent screen as `username`, and waits for spaca to take over again. */
export async function authorizeSandboxX(page: Page, username: string, destination: RegExp) {
  await page.waitForURL(/\/dev\/x-authorize\?/);
  await page.getByLabel('Sandbox X username').fill(username);
  await Promise.all([page.waitForURL(destination), page.getByRole('button', { name: 'Authorize app' }).click()]);
}

/** Sign-up is X only (drizzle/0035): choose the type, Continue with X, authorize on sandbox X, land on setup. */
export async function signUpInDialog(page: Page, type: 'Buyer' | 'Creator', username = xUsername()) {
  // The dialog over a page, or the same card on a direct visit to /sign-up.
  const dialog = page.locator('.auth-dialog').filter({ has: page.getByRole('heading', { level: 1, name: 'Create your account' }) });
  const choice = dialog.getByRole('radio', { name: new RegExp(`^${type}`) });
  await waitForHydration(choice);
  await choice.check();
  const x = dialog.getByRole('button', { name: 'Continue with X' });
  await expect(x).toBeEnabled();
  await x.click();
  await authorizeSandboxX(page, username, /\/welcome(\?|$)/);
  return username;
}

/** Finish account setup on /welcome: photo or logo, name, one line, introduction (and a handle for creators). */
export async function completeSetup(page: Page, fields: { name: string; headline: string; intro: string; handle?: string }, destination: RegExp = /\/dashboard$/) {
  const upload = page.getByLabel(/^Upload (photo|logo)$/);
  await waitForHydration(upload);
  await upload.setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: TINY_PNG });
  await expect(page.getByText('Ready', { exact: true })).toBeVisible();
  await page.getByLabel(/^(Creator|Project) name$/).fill(fields.name);
  if (fields.handle) await page.getByLabel('Public handle').fill(fields.handle);
  await page.getByLabel(/^What you (do|are building)$/).fill(fields.headline);
  await page.getByLabel(/^(Introduce yourself|About the project)$/).fill(fields.intro);
  await Promise.all([page.waitForURL(destination), page.getByRole('button', { name: 'Finish setup' }).click()]);
}
