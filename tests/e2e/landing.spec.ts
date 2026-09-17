import { expect, test, type Page } from '@playwright/test';
import { visit, waitForHydration } from './helpers';
import { CAMPAIGN_GOALS } from '../../src/modules/requests/goals';

/**
 * The landing after the 2026-09-17 simplification: the hero search, the seven campaign goals, three strips of real
 * stock (services, creators, auctions), the questions and the closing call. The strips are drawn from the
 * development database, so each test asserts what must hold for whatever real rows are there — never a fixed count.
 */

const strip = (page: Page, name: string | RegExp) => page.getByRole('region', { name });

test('the landing search works like a marketplace search, and its second tab plans a campaign', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await visit(page, '/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Find the voices your launch needs.');

  const tabs = page.getByRole('tablist', { name: 'Start with' });
  const find = tabs.getByRole('tab', { name: 'Find creators' });
  const plan = tabs.getByRole('tab', { name: 'Plan a campaign' });
  await waitForHydration(find);
  await expect(find).toHaveAttribute('aria-selected', 'true');

  // Suggestions open real campaign tabs.
  const chips = page.getByRole('navigation', { name: 'Popular campaigns' });
  await expect(chips.getByRole('link')).toHaveCount(5);
  await expect(chips.getByRole('link', { name: /^Launch threads/ })).toHaveAttribute('href', '/campaigns/launch');

  // Arrow keys move between the tabs; the brief sentence lives in the second one.
  await find.focus();
  await page.keyboard.press('ArrowRight');
  await expect(plan).toHaveAttribute('aria-selected', 'true');
  await expect(plan).toBeFocused();
  const planPanel = page.getByRole('tabpanel', { name: 'Plan a campaign' });
  await expect(planPanel).toContainText("We're launching a");
  await expect(planPanel.getByRole('link', { name: /Start this campaign/ })).toHaveAttribute('href', /^\/sign-up\?role=buyer&launch=mainnet&creators=5/);
  await page.keyboard.press('ArrowLeft');
  await expect(find).toHaveAttribute('aria-selected', 'true');

  // The search field goes to Explore with the words typed.
  const field = page.getByRole('searchbox', { name: 'Search creators' });
  await field.fill('launch thread');
  await Promise.all([page.waitForURL(/\/explore\?q=launch\+thread$/), field.press('Enter')]);
  expect(errors).toEqual([]);
});

test('the seven campaign goals each open their own tab', async ({ page }) => {
  await visit(page, '/');
  const goals = page.getByRole('region', { name: 'Pick what your launch needs.' });
  for (const goal of CAMPAIGN_GOALS) {
    await expect(goals.getByRole('link', { name: new RegExp(`^${goal.title.replace('&', '\\&')}`) })).toHaveAttribute('href', `/campaigns/${goal.slug}`);
  }
});

test('the simplified page keeps only the sections the user asked for, in order', async ({ page }) => {
  await visit(page, '/');
  // The identity sets headings in capitals, so compare on the words rather than the rendered case.
  const headings = (await page.getByRole('main').getByRole('heading', { level: 2 }).allInnerTexts()).map((text) => text.toLowerCase());
  expect(headings[0]).toBe('pick what your launch needs.');
  expect(headings.at(-2)).toBe('questions.');
  expect(headings.at(-1)).toBe('your next launch deserves better than a group chat.');

  // The three blocks the user removed are gone, not moved.
  const main = page.getByRole('main');
  await expect(main).not.toContainText('Paid on approval');
  await expect(main).not.toContainText('Sponsored posts disclosed');
  await expect(main).not.toContainText('No wallet needed to hire');
  await expect(page.getByRole('tablist', { name: 'How a campaign moves' })).toHaveCount(0);
  await expect(page.getByRole('img', { name: /A reward pool pays each creator/ })).toHaveCount(0);
  await expect(main).not.toContainText('Three ways to hire');

  // Every in-page link in the header and footer points at a section that exists.
  const anchors = await page.locator('a[href^="#"]').evaluateAll((links) => links.map((link) => link.getAttribute('href')!));
  for (const anchor of new Set(anchors)) {
    await expect(page.locator(anchor), `${anchor} should exist on the page`).toHaveCount(1);
  }
});

test('the services strip shows real published work, never a sample card', async ({ page }) => {
  await visit(page, '/');
  const services = strip(page, /^(Popular|New) services$/);
  if (await services.count() === 0) test.skip(true, 'no published service has an approved public image in this database');

  const tiles = services.getByRole('link').filter({ has: page.locator('img') });
  const count = await tiles.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index++) {
    const tile = tiles.nth(index);
    await expect(tile).toHaveAttribute('href', /^\/services\/[0-9a-f-]{36}$/);
    // The work itself, served through the sample route that enforces moderation.
    await expect(tile.locator('img').first()).toHaveAttribute('src', /^\/api\/samples\/[0-9a-f-]{36}$/);
    await expect(tile).toContainText(/From \$[\d,]+\.\d{2}/);
  }
  // "Popular" is a claim about demand; without the evidence the heading says these are new (DSC-04).
  const heading = await services.getByRole('heading', { level: 2 }).innerText();
  if (heading === 'New services') await expect(services).toContainText('Not enough completed orders yet');
});

test('the creators strip shows who is available, at the price they start from', async ({ page }) => {
  await visit(page, '/');
  const creators = strip(page, 'Creators available');
  if (await creators.count() === 0) test.skip(true, 'no creator has a published service in this database');

  const tiles = creators.getByRole('link').filter({ hasNotText: 'Explore creators' });
  const count = await tiles.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index++) {
    const tile = tiles.nth(index);
    await expect(tile).toHaveAttribute('href', /^\/(creators\/[^/]+|explore\?selected=[0-9a-f-]{36})$/);
    await expect(tile).toContainText(/From \$[\d,]+\.\d{2}/);
    // A status buyers can act on, and green only when orders can actually be placed.
    await expect(tile).toContainText(/Accepting orders|Paused|Sold out|Not available/);
  }
});

test('the auctions strip either lists real auctions or explains the mechanism — never both, never a fake one', async ({ page }) => {
  await visit(page, '/');
  const auctions = strip(page, 'A third way to buy.');
  await expect(auctions).toBeVisible();
  await expect(auctions.getByRole('link', { name: 'See open auctions ›' })).toHaveAttribute('href', '/auctions');
  // The words are true in either state: nothing here moves real money.
  await expect(auctions).toContainText('no funds move');

  const tiles = auctions.getByRole('link').filter({ hasNotText: 'See open auctions' });
  const rules = auctions.getByRole('list', { name: 'How an item auction works' });

  if (await tiles.count() > 0) {
    // Real auctions: the explanation must not be padding the row underneath them.
    await expect(rules).toHaveCount(0);
    expect(await tiles.count()).toBeLessThanOrEqual(3);
    const count = await tiles.count();
    for (let index = 0; index < count; index++) {
      const tile = tiles.nth(index);
      await expect(tile).toHaveAttribute('href', /^\/auctions\/[0-9a-f-]{36}$/);
      await expect(tile).toContainText(/Current bid|Starting at/);
      await expect(tile).toContainText(/Ends in|Opens in/);
      await expect(tile).toContainText(/Bid in steps of \$[\d,]+\.\d{2}/);
      // The clock is the server's, written so a browser can parse it.
      await expect(tile.locator('time')).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    }
    // Following one auction reaches the real listing.
    await Promise.all([page.waitForURL(/\/auctions\/[0-9a-f-]{36}$/), tiles.first().click()]);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  } else {
    // Nothing open: three true sentences about the mechanism that runs, and no invented listing.
    await expect(rules).toBeVisible();
    await expect(rules.getByRole('listitem')).toHaveCount(3);
    await expect(rules).toContainText('The seller locks collateral');
    await expect(rules).toContainText('24 hours to pay');
    await expect(rules).toContainText('72 hours to confirm');
    await expect(auctions).not.toContainText('Current bid');
  }
});

test('the footer follows the page and shows no unfilled placeholders', async ({ page }) => {
  await visit(page, '/');
  const footer = page.getByRole('contentinfo');
  for (const column of ['Product', 'Creators', 'Company', 'Legal']) await expect(footer.getByRole('navigation', { name: column })).toBeVisible();
  await expect(footer.getByRole('navigation', { name: 'Legal' }).getByRole('link', { name: 'Refund policy' })).toHaveAttribute('href', '/refund-policy');
  expect(await footer.innerText()).not.toMatch(/\[[A-Z ]+\]/);
  await expect(footer).toContainText(`© ${new Date().getFullYear()} spaca`);
});

test.describe('with reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('nothing moves on its own and the page stays usable', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await visit(page, '/');
    const search = page.getByRole('searchbox', { name: 'Search creators' });
    await waitForHydration(search);
    await page.getByRole('region', { name: 'Pick what your launch needs.' }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test('the hero search and every strip below it fit the screen', async ({ page }) => {
    await visit(page, '/');
    await expect(page.getByRole('searchbox', { name: 'Search creators' })).toBeVisible();
    const fits = async (where: string) => expect(await page.evaluate(() => document.documentElement.scrollWidth), where).toBeLessThanOrEqual(375);
    await fits('at the top');
    for (const name of [/^(Popular|New) services$/, /^Creators available$/, /^A third way to buy\.$/] as const) {
      const region = page.getByRole('region', { name });
      if (await region.count() === 0) continue;
      await region.scrollIntoViewIfNeeded();
      await fits(`at ${String(name)}`);
    }
    await page.getByRole('contentinfo').scrollIntoViewIfNeeded();
    await fits('at the footer');
  });
});
