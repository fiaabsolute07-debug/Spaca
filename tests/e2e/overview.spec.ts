import { expect, test } from '@playwright/test';
import { login, visit, waitForHydration } from './helpers';

test('the overview answers what needs me, how things stand, what happened and where to go; notifications live in the header bell', async ({ page }) => {
  await login(page, 'buyer_a');
  await visit(page, '/dashboard');
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { level: 1, name: 'Keep good work moving.' })).toBeVisible();
  await expect(main.getByText('Overview · Buyer account')).toBeVisible();
  await expect(main.getByRole('link', { name: 'Post a brief', exact: true }).first()).toBeVisible();
  const glance = main.getByLabel('At a glance');
  for (const label of ['Needs your action', 'Active orders', 'Completed', 'Funded']) await expect(glance.getByText(label, { exact: true })).toBeVisible();
  await expect(main.getByRole('heading', { level: 2, name: 'Needs your action' })).toBeVisible();
  await expect(main.getByRole('navigation', { name: 'Shortcuts' }).getByRole('link')).toHaveCount(4);
  await expect(main.getByRole('heading', { level: 2, name: 'Recent orders' })).toBeVisible();
  // Notifications are no longer a section of the page.
  await expect(main.getByRole('heading', { name: 'Notifications' })).toHaveCount(0);
  // Each to-do leads to the page where it is done.
  const firstAction = main.getByRole('region', { name: 'Needs your action' }).getByRole('link').first();
  if (await firstAction.count()) await expect(firstAction).toHaveAttribute('href', /^\/(orders|requests|auctions)\//);

  const bell = page.getByRole('banner').getByRole('button', { name: /^Notifications/ });
  await waitForHydration(bell);
  await bell.click();
  const panel = page.getByRole('group', { name: 'Notifications' });
  await expect(panel).toBeVisible();
  await expect(panel.getByText('Loading…')).toHaveCount(0);
  const markAll = panel.getByRole('button', { name: 'Mark all read' });
  if (await markAll.count()) {
    await markAll.click();
    await expect(bell).toHaveAccessibleName('Notifications');
  }
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(bell).toBeFocused();

  await bell.click();
  await Promise.all([page.waitForURL(/\/notifications$/), panel.getByRole('link', { name: 'View all notifications ›' }).click()]);
  await expect(page.getByRole('heading', { level: 1, name: 'What changed' })).toBeVisible();
});

test('a creator’s overview offers creator shortcuts and the bell fits a phone', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await login(page, 'creator_c');
  await visit(page, '/dashboard');
  await expect(page.getByRole('main').getByText('Overview · Creator account')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Shortcuts' }).getByRole('link', { name: /^New service/ })).toBeVisible();
  const bell = page.getByRole('banner').getByRole('button', { name: /^Notifications/ });
  await waitForHydration(bell);
  await bell.click();
  const box = await page.getByRole('group', { name: 'Notifications' }).boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  await context.close();
});
