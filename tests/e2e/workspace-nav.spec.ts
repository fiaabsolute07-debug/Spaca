import { expect, test } from '@playwright/test';
import { login, openAccountMenu, visit } from './helpers';

test('workspace navigation lives in the header Account menu; pages change in the same tab and inner pages link back', async ({ page }) => {
  await login(page, 'buyer_a');
  await visit(page, '/dashboard');
  await expect(page.getByRole('complementary', { name: 'Workspace' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /^Back to/ })).toHaveCount(0);
  const accountButton = page.getByRole('banner').getByRole('button', { name: 'Account', exact: true });

  let menu = await openAccountMenu(page);
  await expect(menu.getByRole('link', { name: 'Overview', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(menu.getByRole('link', { name: 'Post a brief', exact: true })).toBeVisible();
  await expect(menu.getByRole('link', { name: 'My services', exact: true })).toHaveCount(0);
  await expect(page.getByRole('banner').getByRole('button', { name: 'Log out', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(accountButton).toBeFocused();

  menu = await openAccountMenu(page);
  await Promise.all([page.waitForURL(/\/buyer\/orders$/), menu.getByRole('link', { name: 'Orders', exact: true }).click()]);
  await expect(menu).toBeHidden();
  await expect(page.getByRole('link', { name: 'Back to Overview', exact: true })).toBeVisible();

  await Promise.all([page.waitForURL(/\/orders\/[0-9a-f-]{36}$/), page.getByRole('main').getByRole('link', { name: 'Open ›' }).first().click()]);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  menu = await openAccountMenu(page);
  await expect(menu.getByRole('link', { name: 'Orders', exact: true })).toHaveAttribute('aria-current', 'page');
  // A click outside the menu closes it.
  await page.mouse.click(5, 400);
  await expect(menu).toBeHidden();
  await Promise.all([page.waitForURL(/\/buyer\/orders$/), page.getByRole('link', { name: 'Back to Orders', exact: true }).click()]);

  menu = await openAccountMenu(page);
  await Promise.all([page.waitForURL(/\/settings\/profile$/), menu.getByRole('link', { name: 'Profile', exact: true }).click()]);
  await expect(page.getByRole('heading', { level: 1, name: 'Your public profile' })).toBeVisible();
  await expect(page.getByRole('main').getByText('Buyer account', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to Overview', exact: true })).toBeVisible();
  expect(page.context().pages()).toHaveLength(1);
});

test('a signed-out visitor has no Account menu or back links on marketplace pages', async ({ page }) => {
  await page.context().clearCookies();
  await visit(page, '/requests');
  await expect(page.getByRole('banner').getByRole('button', { name: 'Account', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /^Back to/ })).toHaveCount(0);
});

test('the spaca logo leads a signed-in account to the product and a visitor to the landing', async ({ page }) => {
  await visit(page, '/explore');
  await expect(page.getByRole('banner').getByRole('link', { name: 'spaca home' })).toHaveAttribute('href', '/');

  await login(page, 'buyer_a');
  await visit(page, '/explore');
  const logo = page.getByRole('banner').getByRole('link', { name: 'spaca home' });
  await expect(logo).toHaveAttribute('href', '/dashboard');
  await expect(page.getByRole('contentinfo').getByRole('link', { name: 'spaca home' })).toHaveAttribute('href', '/dashboard');
  await Promise.all([page.waitForURL(/\/dashboard$/), logo.click()]);
  await expect(page.getByRole('heading', { level: 1, name: 'Keep good work moving.' })).toBeVisible();

  // A signed-in account that opens the landing anyway gets back to the product from its logos too.
  await visit(page, '/');
  for (const link of await page.getByRole('link', { name: 'spaca home' }).all()) await expect(link).toHaveAttribute('href', '/dashboard');
});

