import { expect, test } from '@playwright/test';
import { login, visit } from './helpers';
import { CAMPAIGN_GOALS } from '../../src/modules/requests/goals';
import { GOAL_PAGES } from '../../src/modules/requests/goal-pages';

test('each of the seven campaign tabs is its own page with its own idea, and none of them reads as empty', async ({ page }) => {
  await login(page, 'buyer_a');
  await visit(page, '/campaigns');
  expect(new URL(page.url()).pathname).toBe(`/campaigns/${CAMPAIGN_GOALS[0]!.slug}`);
  const tabs = page.getByRole('navigation', { name: 'Campaign goals' });
  await expect(tabs.getByRole('link')).toHaveCount(7);

  for (const goal of CAMPAIGN_GOALS) {
    const content = GOAL_PAGES[goal.value];
    await visit(page, `/campaigns/${goal.slug}`);
    await expect(tabs.getByRole('link', { name: new RegExp(`^${goal.title.replace('&', '\\&')}`) })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { level: 1, name: content.headline })).toBeVisible();
    await expect(page.getByText(content.pitch)).toBeVisible();
    // The idea, how it works and what creators deliver are always there.
    const steps = page.getByRole('list', { name: `How ${goal.title} campaigns work` });
    await expect(steps.getByRole('listitem')).toHaveCount(3);
    for (const item of content.delivers) await expect(page.getByRole('region', { name: 'What creators deliver' }).getByText(item, { exact: true })).toBeVisible();

    const open = page.getByRole('region', { name: new RegExp(`^Open ${goal.title.replace('&', '\\&')} campaigns`) });
    // Open campaigns are cards on a tab; `/requests` keeps the board for the long list.
    const count = await open.locator('.campaign-card').count();
    if (count === 0) {
      // No open campaign: the space invites the first brief, set up for this goal, instead of sitting blank.
      await expect(open.getByRole('heading', { name: `No ${goal.title} campaign is taking applications yet` })).toBeVisible();
      await expect(open.getByRole('link', { name: `Post the first ${goal.title} brief` })).toHaveAttribute('href', `/buyer/requests/new?goal=${goal.slug}`);
    } else {
      for (const card of await open.locator('.campaign-card').all()) await expect(card.locator('.badge-goal')).toHaveText(goal.title);
    }
  }

  // The brief form opened from a tab has the goal chosen and examples written for it.
  const launch = GOAL_PAGES.LAUNCH;
  await visit(page, '/campaigns/launch');
  await Promise.all([page.waitForURL(/\/buyer\/requests\/new\?goal=launch$/), page.getByRole('link', { name: /^Post (your|the first) Launch brief$/ }).first().click()]);
  await expect(page.getByRole('group', { name: 'What is the campaign for?' }).getByRole('radio', { name: /^Launch/ })).toBeChecked();
  await expect(page.getByLabel('Brief title', { exact: true })).toHaveAttribute('placeholder', launch.briefTitle);
  await expect(page.getByLabel('Brief', { exact: true })).toHaveAttribute('placeholder', launch.briefText);

  expect((await page.goto('/campaigns/not-a-goal'))?.status()).toBe(404);
});

test('a creator sees open work on a tab instead of a prompt to post a brief', async ({ page }) => {
  await login(page, 'creator_c');
  await visit(page, '/campaigns/shiller');
  await expect(page.getByRole('link', { name: /^Post (your|the first) Shiller brief$/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'See open Shiller campaigns' })).toBeVisible();
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test('the tabs scroll sideways inside themselves and the page does not', async ({ page }) => {
    await visit(page, '/campaigns/ama');
    const tabs = page.getByRole('navigation', { name: 'Campaign goals' });
    await expect(tabs.getByRole('link', { name: /^AMA/ })).toHaveAttribute('aria-current', 'page');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    expect(await tabs.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  });
});
