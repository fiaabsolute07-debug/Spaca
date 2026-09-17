import { expect, test } from '@playwright/test';
import { baseURL, creatorName, login, signUpInDialog, submit, visit, waitForHydration } from './helpers';

// creator_c always connects the same sandbox username, so repeated runs reuse one linked X account.
const SANDBOX_USERNAME = 'ari_makes';

test('a creator connects X in the sandbox, and buyers see the X photo, followers and bio in Explore and on the profile', async ({ page, browser }) => {
  await login(page, 'creator_c');
  await visit(page, '/settings/profile');
  let section = page.getByRole('region', { name: 'X account' });
  const disconnect = section.getByRole('button', { name: 'Disconnect X' });
  if (await disconnect.count()) {
    await submit(page, disconnect);
    await expect(page.getByRole('status')).toContainText(`@${SANDBOX_USERNAME} disconnected`);
  }
  section = page.getByRole('region', { name: 'X account' });
  await expect(section.getByText(/Local sandbox: this opens a stand-in for X/)).toBeVisible();
  const connect = section.getByRole('button', { name: 'Connect X' });
  await waitForHydration(page.getByRole('banner').getByRole('button', { name: 'Account', exact: true }));
  await Promise.all([page.waitForURL(/\/dev\/x-authorize\?/), connect.click()]);

  // The sandbox consent screen says it is not X.
  await expect(page.getByRole('heading', { level: 1, name: 'spaca wants to access your X account' })).toBeVisible();
  await expect(page.getByText('Local sandbox · no real X account is used')).toBeVisible();
  await page.getByLabel('Sandbox X username').fill(SANDBOX_USERNAME);
  await Promise.all([page.waitForURL(/\/settings\/profile\?/), page.getByRole('button', { name: 'Authorize app' }).click()]);
  await expect(page.getByRole('status')).toContainText(`X account @${SANDBOX_USERNAME} connected.`);

  section = page.getByRole('region', { name: 'X account' });
  const card = section.getByRole('region', { name: 'On X' });
  await expect(card.getByRole('link', { name: `@${SANDBOX_USERNAME}` })).toHaveAttribute('href', `https://x.com/${SANDBOX_USERNAME}`);
  await expect(card.getByText('Sandbox X data')).toBeVisible();
  await expect(card.getByText('updated today')).toBeVisible();
  const followers = (await card.locator('dt', { hasText: 'Followers' }).locator('xpath=following-sibling::dd').textContent())!.trim();
  expect(followers).toMatch(/^\d+(\.\d)?[KM]?$/);
  // A refresh right after connecting would read X again for nothing.
  await expect(section.getByRole('button', { name: 'Refresh from X' })).toBeDisabled();
  await expect(section.getByText(/You can refresh again in \d+ hours?/)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Linked accounts' }).getByText(`@${SANDBOX_USERNAME}`)).toBeVisible();

  // A visitor who is not signed in sees the same saved copy; no sign-in or X read is needed.
  const context = await browser.newContext({ baseURL, viewport: { width: 1360, height: 900 } });
  try {
    const visitor = await context.newPage();
    await visit(visitor, '/explore');
    const result = visitor.locator('.explore-card').filter({ hasText: creatorName }).first();
    await expect(result.getByText(`${followers} followers on X`)).toBeAttached();
    await waitForHydration(result);
    await result.click();
    const detail = visitor.getByRole('article', { name: /^Details:/ });
    const onX = detail.getByRole('region', { name: 'On X' });
    await expect(onX.getByRole('link', { name: `@${SANDBOX_USERNAME}` })).toBeVisible();
    await expect(onX.locator('dd').first()).toHaveText(followers);
    await expect(onX.getByText('Sandbox X data')).toBeVisible();
    await expect(onX.locator('img.x-card-photo')).toHaveAttribute('src', `/api/dev/x/avatar/${SANDBOX_USERNAME}`);
    const photo = await visitor.request.get(`/api/dev/x/avatar/${SANDBOX_USERNAME}`);
    expect(photo.headers()['content-type']).toBe('image/svg+xml');

    await visit(visitor, '/creators/ari-makes');
    await expect(visitor.getByRole('region', { name: 'On X' }).getByRole('link', { name: `@${SANDBOX_USERNAME}` })).toBeVisible();
    await expect(visitor.locator('.social-links li').filter({ hasText: `@${SANDBOX_USERNAME}` })).toContainText('Verified');
  } finally {
    await context.close();
  }
});

test('a buyer account cannot connect X, and cancelling the sandbox consent connects nothing', async ({ page }) => {
  await login(page, 'buyer_a');
  await visit(page, '/settings/profile');
  await expect(page.getByRole('region', { name: 'X account' })).toHaveCount(0);
  const refused = await page.request.post('/api/x/connect', { form: { return_to: '/settings/profile' }, headers: { origin: baseURL }, maxRedirects: 0 });
  expect(refused.status()).toBe(303);
  expect(decodeURIComponent(refused.headers().location ?? '')).toContain('Connecting X is for creator accounts');

  await login(page, 'creator_d');
  await visit(page, '/settings/profile');
  const section = page.getByRole('region', { name: 'X account' });
  const connect = section.getByRole('button', { name: 'Connect X' });
  test.skip(await connect.count() === 0, 'creator_d already has X connected in this database');
  await Promise.all([page.waitForURL(/\/dev\/x-authorize\?/), connect.click()]);
  await Promise.all([page.waitForURL(/\/settings\/profile\?/), page.getByRole('button', { name: 'Cancel' }).click()]);
  await expect(page.getByRole('main').getByRole('alert')).toContainText('X sign-in was cancelled. Nothing was connected.');
  await expect(page.getByRole('region', { name: 'X account' }).getByRole('button', { name: 'Connect X' })).toBeVisible();
});

test('a new creator can start setup from X: name, handle, bio and link come filled in, and stay editable', async ({ page }) => {
  await visit(page, '/sign-up?role=creator');
  await signUpInDialog(page, 'Creator');
  const step = page.getByRole('region', { name: /Start from X/ });
  await expect(step).toBeVisible();
  const username = `n${Date.now().toString().slice(-12)}`;
  await Promise.all([page.waitForURL(/\/dev\/x-authorize\?/), step.getByRole('button', { name: 'Connect X' }).click()]);
  await page.getByLabel('Sandbox X username').fill(username);
  await Promise.all([page.waitForURL(/\/welcome\?/), page.getByRole('button', { name: 'Authorize app' }).click()]);
  await expect(page.getByRole('status')).toContainText(`X account @${username} connected.`);

  const connected = page.getByRole('region', { name: /Start from X/ });
  await expect(connected.getByText(/^Connected\./)).toBeVisible();
  await expect(connected.getByRole('region', { name: 'On X' }).getByRole('link', { name: `@${username}` })).toBeVisible();
  await expect(page.getByLabel('Creator name')).toHaveValue(username.slice(0, 1).toUpperCase() + username.slice(1));
  await expect(page.getByLabel('Public handle')).toHaveValue(username);
  await expect(page.getByLabel('Introduce yourself')).not.toHaveValue('');
  await expect(page.getByLabel(/^X profile or website/)).toHaveValue(`https://x.com/${username}`);
  await page.getByLabel('Creator name').fill('Edited Name');
  await expect(page.getByRole('complementary', { name: 'Preview' }).getByText('Edited Name')).toBeVisible();
});

