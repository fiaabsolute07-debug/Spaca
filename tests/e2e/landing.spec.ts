import { expect, test } from '@playwright/test';
import { visit, waitForHydration } from './helpers';
import { CAMPAIGN_GOALS } from '../../src/modules/requests/goals';

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

test('below the hero: seven campaign tiles, a 3D walk-through of a campaign, and the reward pool flow', async ({ page }) => {
  await visit(page, '/');
  const goals = page.getByRole('region', { name: 'Pick what your launch needs.' });
  for (const goal of CAMPAIGN_GOALS) {
    await expect(goals.getByRole('link', { name: new RegExp(`^${goal.title.replace('&', '\\&')}`) })).toHaveAttribute('href', `/campaigns/${goal.slug}`);
  }

  const steps = page.getByRole('tablist', { name: 'How a campaign moves' });
  const deliver = steps.getByRole('tab', { name: /Creators deliver/ });
  await waitForHydration(deliver);
  await deliver.click();
  await expect(deliver).toHaveAttribute('aria-selected', 'true');
  await expect(deliver).toContainText('Drafts, files and post links arrive');
  await expect(page.getByRole('tabpanel', { name: /Creators deliver/ })).toContainText('One revision included');
  // Choosing a step stops the automatic walk-through.
  await page.waitForTimeout(4600);
  await expect(deliver).toHaveAttribute('aria-selected', 'true');

  await expect(page.getByRole('img', { name: /A reward pool pays each creator when their work is approved/ })).toBeVisible();

  // The footer uses the same system as the page and shows no unfilled placeholders.
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
    const first = page.getByRole('tab', { name: /Post one brief/ });
    await waitForHydration(first);
    await page.getByRole('tablist', { name: 'How a campaign moves' }).scrollIntoViewIfNeeded();
    await page.waitForTimeout(4600);
    await expect(first).toHaveAttribute('aria-selected', 'true');
    expect(errors).toEqual([]);
  });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test('the hero search and the sections below fit the screen', async ({ page }) => {
    await visit(page, '/');
    await expect(page.getByRole('searchbox', { name: 'Search creators' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await page.getByRole('tablist', { name: 'How a campaign moves' }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  });
});
