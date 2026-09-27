import { expect, test, type Page } from '@playwright/test';
import { completeSetup, openAccountMenu, visit, waitForHydration, xUsername, authorizeSandboxX } from './helpers';
import { HIDDEN_SECTIONS } from '../../src/lib/scope';
import type { FixturePersonaKey } from '../../src/lib/fixtures';

/**
 * spaca while only auctions are shown (src/lib/scope.ts, the default): the `auctions-only` project runs this file
 * against a dev server started without MARKETPLACE_SCOPE; everything else runs against one started with it set to
 * `full`. Services, campaigns, orders and funds are still in the code — nothing here may lead to them.
 */

const origin = () => new URL(String(test.info().project.use.baseURL)).origin;

async function login(page: Page, persona: FixturePersonaKey) {
  const response = await page.request.post('/api/dev/session', { data: { persona }, headers: { Origin: origin(), Accept: 'application/json' } });
  expect(response.status(), `Fixture login for ${persona}`).toBe(200);
}

/** Every link on the page stays inside what is shown: no address in a hidden section. */
async function expectNoHiddenLinks(page: Page) {
  const hrefs = await page.locator('a[href]').evaluateAll((links) => links.map((link) => new URL((link as HTMLAnchorElement).href).pathname));
  const hidden = hrefs.filter((path) => HIDDEN_SECTIONS.some((section) => path === section || path.startsWith(`${section}/`)));
  expect(hidden, page.url()).toEqual([]);
}

test('the landing is about auctions: the hero, open listings, auction questions and a call to list', async ({ page }) => {
  await visit(page, '/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Web3 items, bid in the open.');
  const sections = page.getByRole('navigation', { name: 'Landing sections' });
  await expect(sections.getByRole('link')).toHaveText(['Auctions', 'FAQ']);
  await expect(page.getByRole('region', { name: 'On the block now.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Pick what your launch needs.' })).toHaveCount(0);
  await expect(page.locator('#faq summary')).toHaveText([
    'What can I bid on?', 'What keeps the seller honest?', 'When do I pay, and when is the seller paid?', 'What if something goes wrong?', 'Who can list an item?', 'What are the fees?',
  ]);
  // A visitor who wants to list signs in first and comes back to the listing form.
  await expect(page.getByRole('main').getByRole('link', { name: 'List an item' }).first()).toHaveAttribute('href', '/sign-in?return_to=%2Fauctions%2Fnew');
  await expectNoHiddenLinks(page);
});

test('the app header holds Auctions and nothing else, and no page links into the hidden sections', async ({ page }) => {
  await visit(page, '/auctions');
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(nav.getByRole('link')).toHaveText(['Auctions Beta']);
  await expect(nav.getByRole('button')).toHaveCount(0);
  await expect(nav.getByRole('link', { name: /Auctions/ })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('search')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Footer' }).getByRole('link')).toHaveText(['Auctions', 'Support', 'Terms', 'Privacy', 'Refund policy']);
  await expectNoHiddenLinks(page);

  await visit(page, '/support');
  await expect(page.getByRole('heading', { name: 'Get help with an auction' })).toBeVisible();
  await expectNoHiddenLinks(page);

  const missing = await page.goto('/no-such-page');
  expect(missing?.status()).toBe(404);
  await expect(page.getByRole('main').getByRole('link')).toHaveText(['See auctions']);
});

test('every hidden section leads to the auction board, and the sitemap lists only auctions', async ({ page }) => {
  for (const path of [...HIDDEN_SECTIONS, '/services/00000000-0000-4000-8000-000000000000', '/buyer/requests/new', '/campaigns/launch']) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/auctions$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Web3 items, bid in the open.');
  }
  const sitemap = await (await page.request.get('/sitemap.xml')).text();
  expect(sitemap).toContain('/auctions</loc>');
  expect(sitemap).not.toMatch(/\/(explore|services|creators|requests)[/<]/);
});

test('a new account signs up without choosing a type, is set up as a seller of items, and can list as a project', async ({ page }) => {
  await visit(page, '/sign-up?role=creator');
  const dialog = page.locator('.auth-dialog');
  // The art beside the form is decorative (aria-hidden), so it is read as markup, not by role.
  await expect(dialog.locator('.auth-art h2')).toHaveText('Web3 items, bid in the open');
  // No account type to pick, even when the link asks for a creator: every new account is a buyer account.
  await expect(dialog.getByRole('group', { name: 'Choose your account type' })).toHaveCount(0);
  await expect(dialog.locator('form[action="/api/auth/x"] input[name="role"]')).toHaveValue('buyer');
  const x = dialog.getByRole('button', { name: 'Continue with X' });
  await waitForHydration(x);
  await expect(x).toBeEnabled();
  await x.click();
  await authorizeSandboxX(page, xUsername(), /\/welcome(\?|$)/);

  await expect(page.getByText('Bidders look at who is selling before anything else.')).toBeVisible();
  await expect(page.getByText('Until setup is done you can look around and bid, but listing an item waits.')).toBeVisible();
  await expect(page.getByText('Listed by', { exact: true })).toBeVisible();
  // Setup goes on to the auction board, where the account now lands.
  await completeSetup(page, { name: 'Nebula Labs', headline: 'A mint launchpad on Base', intro: 'Nebula Labs runs genesis mints for small NFT teams on Base and sells its own allowlist spots.' }, /\/auctions$/);

  const menu = await openAccountMenu(page);
  await expect(page.getByRole('region', { name: 'Signed in as' })).toContainText('Buyer');
  await expect(menu.getByRole('link')).toHaveText(['My auctions', 'WalletConnect', 'Profile']);
  await expect(page.getByRole('banner').getByRole('button', { name: 'Fund' })).toHaveCount(0);

  await visit(page, '/auctions/new');
  await expect(page.getByRole('radio', { name: /I’m the project/ })).toBeEnabled();
});

test('a signed-in account starts on the board, and every page leads back to it', async ({ page }) => {
  await login(page, 'buyer_a');
  await visit(page, '/');
  await expect(page.getByRole('link', { name: 'spaca home' }).first()).toHaveAttribute('href', '/auctions');
  await visit(page, '/auctions');
  await expect(page.getByRole('banner').getByRole('link', { name: 'spaca home' })).toHaveAttribute('href', '/auctions');
  const menu = await openAccountMenu(page);
  await expect(menu.getByRole('link', { name: 'My auctions' })).toHaveAttribute('aria-current', 'page');
  await expectNoHiddenLinks(page);

  for (const path of ['/settings/profile', '/notifications']) {
    await visit(page, path);
    await expect(page.getByRole('link', { name: 'Back to Auctions' })).toHaveAttribute('href', '/auctions');
    await expectNoHiddenLinks(page);
  }
});
