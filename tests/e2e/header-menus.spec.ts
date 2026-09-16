import { expect, test } from '@playwright/test';
import { dateTimeLocal, login, submit, uniqueSuffix, visit, waitForHydration } from './helpers';

test('the header opens Explore and Campaigns as menus, and a campaign goal filters the campaign list', async ({ page }) => {
  await login(page, 'buyer_a');
  const title = `E2E airdrop campaign ${uniqueSuffix()}`;
  await visit(page, '/buyer/requests/new?goal=airdrop');
  // Arriving from a goal preselects it, and the kind of work it usually needs.
  const goals = page.getByRole('group', { name: 'What is the campaign for?' });
  await expect(goals.getByRole('radio', { name: /^Airdrop/ })).toBeChecked();
  await expect(page.getByRole('group', { name: 'What do you need?' }).getByRole('radio', { name: /^Publish/ })).toBeChecked();
  await page.getByLabel('Brief title', { exact: true }).fill(title);
  await page.getByLabel('Brief', { exact: true }).fill(`Explain who is eligible for our testnet airdrop and how to join, with the disclosure (${title}).`);
  await page.getByLabel('Total budget (USD, optional if you set a cap)', { exact: true }).fill('300');
  await page.getByLabel('Creators needed', { exact: true }).fill('1');
  await page.getByLabel('Delivery deadline', { exact: true }).fill(dateTimeLocal(new Date(Date.now() + 14 * 86400_000)));
  await submit(page, page.getByRole('button', { name: 'Publish brief', exact: true }));
  await expect(page.getByRole('listitem').filter({ hasText: /^Campaign goal/ })).toContainText('Airdrop');

  await visit(page, '/auctions');
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  const campaigns = nav.getByRole('button', { name: 'Campaigns', exact: true });
  await waitForHydration(campaigns);
  await expect(campaigns).not.toHaveAttribute('aria-current', 'page');
  const menu = nav.getByRole('group', { name: 'Campaigns menu' });
  await expect(menu).toBeHidden();
  // Hovering opens the menu; leaving it closes it again.
  await campaigns.hover();
  await expect(menu).toBeVisible();
  await expect(campaigns).toHaveAttribute('aria-expanded', 'true');
  await expect(nav.getByRole('group', { name: 'Explore menu' })).toBeHidden();
  await expect(menu.getByRole('link', { name: /^Post a brief/ })).toHaveAttribute('href', '/buyer/requests/new');
  await page.mouse.move(640, 700);
  await expect(menu).toBeHidden();

  // Keyboard: the trigger toggles, Escape closes and returns focus to it.
  await campaigns.focus();
  await page.keyboard.press('Enter');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(campaigns).toBeFocused();

  await campaigns.hover();
  await Promise.all([page.waitForURL(/\/requests\?goal=airdrop$/), menu.getByRole('link', { name: /^Airdrop/ }).click()]);
  await expect(menu).toBeHidden();
  await waitForHydration(campaigns);
  await expect(page.getByRole('heading', { level: 1, name: 'Airdrop campaigns' })).toBeVisible();
  await expect(campaigns).toHaveAttribute('aria-current', 'page');
  const filter = page.getByRole('navigation', { name: 'Campaign goals' });
  await expect(filter.getByRole('link', { name: /^Airdrop/ })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('link', { name: new RegExp(title) })).toBeVisible();
  // Every card on a goal page carries that goal.
  const cards = page.locator('.campaign-card');
  expect(await cards.count()).toBeGreaterThan(0);
  for (const card of await cards.all()) await expect(card.locator('.badge-goal')).toHaveText('Airdrop');

  await Promise.all([page.waitForURL(/\/requests\?goal=shiller$/), filter.getByRole('link', { name: /^Shiller/ }).click()]);
  await expect(page.getByRole('link', { name: new RegExp(title) })).toHaveCount(0);

  // Explore lists the four kinds of work.
  const explore = nav.getByRole('button', { name: 'Explore', exact: true });
  await waitForHydration(explore);
  await explore.hover();
  const exploreMenu = nav.getByRole('group', { name: 'Explore menu' });
  await Promise.all([page.waitForURL(/\/explore\?category=ACCESS$/), exploreMenu.getByRole('link', { name: /^Access/ }).click()]);
  await expect(explore).toHaveAttribute('aria-current', 'page');
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test('the menus open and close by tap and fit the screen', async ({ page }) => {
    await visit(page, '/requests');
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    const campaigns = nav.getByRole('button', { name: 'Campaigns', exact: true });
    await waitForHydration(campaigns);
    await campaigns.tap();
    const menu = nav.getByRole('group', { name: 'Campaigns menu' });
    await expect(menu).toBeVisible();
    const box = (await menu.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(8);
    expect(box.x + box.width).toBeLessThanOrEqual(375 - 8);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await campaigns.tap();
    await expect(menu).toBeHidden();
  });
});
