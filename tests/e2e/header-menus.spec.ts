import { expect, test } from '@playwright/test';
import { baseURL, nextBriefStep, dateTimeLocal, login, submit, uniqueSuffix, visit, waitForHydration } from './helpers';

test('the header opens Explore and Campaigns as menus, and a campaign goal filters the campaign list', async ({ page }) => {
  await login(page, 'buyer_a');
  const title = `E2E airdrop campaign ${uniqueSuffix()}`;
  await visit(page, '/buyer/requests/new?goal=airdrop');
  // Arriving from a goal preselects it, and the kind of work it usually needs.
  const goals = page.getByRole('group', { name: 'What is the campaign for?' });
  await expect(goals.getByRole('radio', { name: /^Airdrop/ })).toBeChecked();
  await nextBriefStep(page);
  await page.getByLabel('Brief title', { exact: true }).fill(title);
  await page.getByLabel('Brief', { exact: true }).fill(`Explain who is eligible for our testnet airdrop and how to join, with the disclosure (${title}).`);
  await nextBriefStep(page);
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
  await Promise.all([page.waitForURL(/\/campaigns\/airdrop$/), menu.getByRole('link', { name: /^Airdrop/ }).click()]);
  await expect(menu).toBeHidden();
  await waitForHydration(campaigns);
  await expect(page.getByRole('heading', { level: 1, name: 'Explain the airdrop to the people who actually qualify.' })).toBeVisible();
  await expect(campaigns).toHaveAttribute('aria-current', 'page');
  const tabs = page.getByRole('navigation', { name: 'Campaign goals' });
  await expect(tabs.getByRole('link', { name: /^Airdrop/ })).toHaveAttribute('aria-current', 'page');
  const openSection = page.getByRole('region', { name: /^Open Airdrop campaigns/ });
  await expect(openSection.getByRole('link', { name: new RegExp(title) })).toBeVisible();
  // Every open campaign on a tab carries that goal.
  const cards = openSection.locator('.board-row');
  expect(await cards.count()).toBeGreaterThan(0);
  for (const card of await cards.all()) await expect(card.locator('.badge-goal')).toHaveText('Airdrop');

  await Promise.all([page.waitForURL(/\/campaigns\/shiller$/), tabs.getByRole('link', { name: /^Shiller/ }).click()]);
  await expect(page.getByRole('link', { name: new RegExp(title) })).toHaveCount(0);
  // Older links that filtered the list land on the tab.
  await visit(page, '/requests?goal=airdrop');
  expect(new URL(page.url()).pathname).toBe('/campaigns/airdrop');

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

test('menu icons act out what they stand for on hover, once, and stay still with reduced motion', async ({ page, browser }) => {
  await visit(page, '/requests');
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  const campaigns = nav.getByRole('button', { name: 'Campaigns', exact: true });
  await waitForHydration(campaigns);
  await campaigns.hover();
  const menu = nav.getByRole('group', { name: 'Campaigns menu' });
  const part = (name: RegExp, selector: string) => menu.getByRole('link', { name }).locator(`.nav-item-icon ${selector}`);
  const motion = (name: RegExp, selector: string) => part(name, selector).evaluate((node) => {
    const style = getComputedStyle(node);
    return { name: style.animationName, iterations: style.animationIterationCount };
  });
  // At rest the rocket is a still drawing and its flame is out.
  expect((await motion(/^Launch/, '.mi-rocket')).name).toBe('none');
  expect(await part(/^Launch/, '.mi-flame').evaluate((node) => getComputedStyle(node).opacity)).toBe('0');
  // Each icon moves the part that tells its story, a fixed number of times, never in a loop.
  for (const [name, selector, keyframes, iterations] of [
    [/^Launch/, '.mi-rocket', 'mi-launch', '1'],
    [/^Launch/, '.mi-flame', 'mi-flame', '1'],
    [/^Shiller/, '.mi-wave-3', 'mi-wave', '2'],
    [/^Airdrop/, '.mi-chute', 'mi-drop', '1'],
    [/^Testnet/, '.mi-bubble-1', 'mi-bubble', '1'],
    [/^Education/, '.mi-tassel', 'mi-swing', '1'],
  ] as const) {
    await menu.getByRole('link', { name }).hover();
    expect(await motion(name, selector)).toEqual({ name: keyframes, iterations });
  }
  // The rocket really leaves: partway through its run it sits outside its frame, which clips it.
  await menu.getByRole('link', { name: /^Launch/ }).hover();
  const icon = menu.getByRole('link', { name: /^Launch/ }).locator('.nav-item-icon');
  const away = await icon.evaluate((frame) => {
    const rocket = frame.querySelector('.mi-rocket')!;
    for (const animation of frame.getAnimations({ subtree: true })) { animation.pause(); animation.currentTime = 600; }
    const outer = frame.getBoundingClientRect();
    const inner = rocket.getBoundingClientRect();
    return { overflow: getComputedStyle(frame).overflow, outside: inner.left >= outer.right || inner.bottom <= outer.top || inner.right <= outer.left || inner.top >= outer.bottom };
  });
  expect(away).toEqual({ overflow: 'hidden', outside: true });

  // The same address the config gives every other context: hard-coding the port failed the run whenever the dev
  // server was started somewhere else (E2E_BASE_URL).
  const reduced = await browser.newContext({ reducedMotion: 'reduce', baseURL });
  const still = await reduced.newPage();
  await visit(still, '/requests');
  const stillNav = still.getByRole('navigation', { name: 'Main navigation' });
  const stillCampaigns = stillNav.getByRole('button', { name: 'Campaigns', exact: true });
  await waitForHydration(stillCampaigns);
  await stillCampaigns.hover();
  const launch = stillNav.getByRole('group', { name: 'Campaigns menu' }).getByRole('link', { name: /^Launch/ });
  await launch.hover();
  expect(await launch.locator('.nav-item-icon svg').evaluate((svg) => [...svg.querySelectorAll('[class]')].map((node) => getComputedStyle(node).animationName))).toEqual(expect.not.arrayContaining([expect.stringMatching(/^mi-/)]));
  await reduced.close();
});
