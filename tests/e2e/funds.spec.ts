import { expect, test } from '@playwright/test';
import { login, visit, waitForHydration } from './helpers';

test('the Fund button beside Account shows money at a glance and leads to the Funds page', async ({ page }) => {
  await login(page, 'buyer_a');
  await visit(page, '/requests');
  const actions = page.locator('.header-actions');
  const fund = actions.getByRole('button', { name: 'Fund', exact: true });
  const account = actions.getByRole('button', { name: 'Account', exact: true });
  // Fund sits immediately before Account.
  await expect(actions.locator('button').first()).toHaveText(/Fund/);
  await expect(account).toBeVisible();
  await waitForHydration(fund);

  await fund.click();
  const menu = page.getByRole('group', { name: 'Fund menu' });
  await expect(menu).toBeVisible();
  await expect(fund).toHaveAttribute('aria-expanded', 'true');
  // The figures load when the menu opens and show real amounts, not placeholders.
  const toPay = menu.locator('.fund-figure').filter({ hasText: 'To pay' });
  await expect(toPay.locator('strong')).toHaveText(/^\$[\d,]+\.\d{2}$/);
  await expect(menu.locator('.fund-figure').filter({ hasText: 'Held for work' }).locator('strong')).toHaveText(/^\$[\d,]+\.\d{2}$/);
  for (const name of ['Pay for orders', 'Held for work', 'Campaign reward pools', 'Money activity', 'Wallets']) {
    await expect(menu.getByRole('link', { name: new RegExp(`^${name}`) })).toBeVisible();
  }
  await expect(menu.getByText(/No real money moves/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(fund).toBeFocused();

  await fund.click();
  await Promise.all([page.waitForURL(/\/funds$/), menu.getByRole('link', { name: 'Open Funds' }).click()]);
  await expect(page.getByRole('heading', { level: 1, name: 'Your payments and campaign funds' })).toBeVisible();
  for (const name of ['Pay for orders', 'Held for work', 'Campaign reward pools', 'Money activity', 'Wallets']) {
    await expect(page.getByRole('region', { name, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('region', { name: 'Payouts on chain' })).toHaveCount(0);
  // The glance and the page read the same numbers.
  const pageToPay = page.locator('.stat').filter({ hasText: 'To pay' }).locator('strong');
  await fund.click();
  await expect(toPay.locator('strong')).toHaveText((await pageToPay.textContent())!.trim());
  await page.keyboard.press('Escape');

  // A menu link lands on its section.
  await fund.click();
  await Promise.all([page.waitForURL(/\/funds#activity$/), menu.getByRole('link', { name: /^Money activity/ }).click()]);
  await expect(page.getByRole('region', { name: 'Money activity', exact: true })).toBeInViewport();
});

test('a creator sees earnings and payouts, and a visitor has no Fund button', async ({ page }) => {
  await login(page, 'creator_d');
  await visit(page, '/funds');
  await expect(page.getByRole('heading', { level: 1, name: 'Your earnings and payouts' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Payouts on chain' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Pay for orders' })).toHaveCount(0);
  const fund = page.getByRole('button', { name: 'Fund', exact: true });
  await waitForHydration(fund);
  await fund.click();
  const menu = page.getByRole('group', { name: 'Fund menu' });
  await expect(menu.locator('.fund-figure').filter({ hasText: 'Held for your work' }).locator('strong')).toHaveText(/^\$[\d,]+\.\d{2}$/);
  await expect(menu.getByRole('link', { name: /^Payouts/ })).toBeVisible();
  await expect(menu.getByRole('link', { name: /^Pay for orders/ })).toHaveCount(0);

  await page.context().clearCookies();
  await visit(page, '/requests');
  await expect(page.getByRole('button', { name: 'Fund', exact: true })).toHaveCount(0);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test('the Fund menu fits the screen', async ({ page }) => {
    await login(page, 'buyer_a');
    await visit(page, '/requests');
    const fund = page.getByRole('button', { name: 'Fund', exact: true });
    await waitForHydration(fund);
    await fund.tap();
    const menu = page.getByRole('group', { name: 'Fund menu' });
    await expect(menu).toBeVisible();
    const box = (await menu.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(8);
    expect(box.x + box.width).toBeLessThanOrEqual(375 - 8);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  });
});
