import { expect, test } from '@playwright/test';
import { login, visit, waitForHydration } from './helpers';

test('the workspace is one frame: the sidebar stays while pages change in the same tab, and inner pages link back', async ({ page }) => {
  await login(page, 'buyer_a');
  await visit(page, '/dashboard');
  const sidebar = page.getByRole('complementary', { name: 'Workspace' });
  await expect(sidebar.getByRole('link', { name: 'Overview', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('link', { name: /^Back to/ })).toHaveCount(0);

  const orders = sidebar.getByRole('link', { name: 'Orders', exact: true });
  await waitForHydration(orders);
  await Promise.all([page.waitForURL(/\/buyer\/orders$/), orders.click()]);
  await expect(sidebar).toBeVisible();
  await expect(orders).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('link', { name: 'Back to Overview', exact: true })).toBeVisible();

  await Promise.all([page.waitForURL(/\/orders\/[0-9a-f-]{36}$/), page.getByRole('main').getByRole('link', { name: 'Open ›' }).first().click()]);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(sidebar).toBeVisible();
  await expect(orders).toHaveAttribute('aria-current', 'page');
  await Promise.all([page.waitForURL(/\/buyer\/orders$/), page.getByRole('link', { name: 'Back to Orders', exact: true }).click()]);

  const campaigns = sidebar.getByRole('link', { name: 'Post a brief', exact: true });
  await Promise.all([page.waitForURL(/\/buyer\/requests\/new$/), campaigns.click()]);
  await expect(campaigns).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('link', { name: 'Back to My campaigns', exact: true })).toBeVisible();

  // The profile is its own area: not in the sidebar, reached from the header, outside the workspace frame.
  await expect(sidebar.getByRole('link', { name: 'Profile' })).toHaveCount(0);
  const profile = page.getByRole('banner').getByRole('link', { name: 'Your profile' });
  await Promise.all([page.waitForURL(/\/settings\/profile$/), profile.click()]);
  await expect(page.getByRole('heading', { level: 1, name: 'Your public profile' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Workspace' })).toHaveCount(0);
  await expect(page.getByText('Buyer account', { exact: true })).toBeVisible();
  await Promise.all([page.waitForURL(/\/dashboard$/), page.getByRole('link', { name: 'Back to workspace' }).click()]);
  await expect(page.getByRole('complementary', { name: 'Workspace' })).toBeVisible();
  expect(page.context().pages()).toHaveLength(1);
});

test('a signed-out visitor sees marketplace pages without the workspace sidebar', async ({ page }) => {
  await page.context().clearCookies();
  await visit(page, '/requests');
  await expect(page.getByRole('complementary', { name: 'Workspace' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /^Back to/ })).toHaveCount(0);
});
