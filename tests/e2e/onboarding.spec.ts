import { expect, test } from '@playwright/test';
import { baseURL, TINY_PNG, authorizeSandboxX, completeSetup, login, openAccountMenu, signUpInDialog, submit, uniqueSuffix, visit, waitForHydration } from './helpers';

test('setup comes first after sign-up: it previews the profile, asks for the logo, and waits for the account until done', async ({ page }) => {
  await visit(page, '/explore');
  const start = page.getByRole('banner').getByRole('link', { name: 'Get started', exact: true });
  await waitForHydration(start);
  await start.click();
  const username = await signUpInDialog(page, 'Buyer');
  const xName = username[0]!.toUpperCase() + username.slice(1);
  await expect(page.getByRole('heading', { level: 1, name: 'Set up your project' })).toBeVisible();
  await expect(page.getByText('Buyer account · Set up')).toBeVisible();
  await expect(page.getByRole('status')).toContainText(`Signed up with X as @${username}.`);

  // Setup starts from the X account, and the preview follows what is typed.
  const preview = page.getByRole('complementary', { name: 'Preview' });
  await expect(page.getByLabel('Project name')).toHaveValue(xName);
  await expect(preview.getByText(xName, { exact: true })).toBeVisible();
  const name = `Arcadia ${uniqueSuffix().slice(-6)}`;
  await page.getByLabel('Project name').fill(name);
  await page.getByLabel('What you are building').fill('A restaking protocol opening its public testnet');
  await page.getByRole('checkbox', { name: 'DeFi' }).check();
  await page.getByLabel('About the project').fill('Arcadia lets stakers restake once and secure several networks.');
  await page.getByLabel(/^Website or X/).fill('@arcadiaxyz');
  await expect(preview.getByText(name)).toBeVisible();
  await expect(preview.getByText('A restaking protocol opening its public testnet')).toBeVisible();
  await expect(preview.getByText('DeFi', { exact: true })).toBeVisible();
  await expect(preview.getByText('x.com/arcadiaxyz')).toBeVisible();
  await expect(preview.getByRole('progressbar', { name: 'Setup progress' })).toHaveAttribute('aria-valuenow', '3');

  // Without a logo, setup says so and keeps everything typed.
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Add your project logo.' })).toBeVisible();
  await expect(page).toHaveURL(/\/welcome(\?|$)/);
  await expect(page.getByLabel('Project name')).toHaveValue(name);

  // Leaving setup for later: the workspace keeps asking, and the Account menu marks it.
  await Promise.all([page.waitForURL(/\/dashboard$/), page.getByRole('link', { name: 'Do this later' }).click()]);
  const nudge = page.getByRole('link', { name: /Finish setting up your project/ });
  await expect(nudge).toBeVisible();
  let menu = await openAccountMenu(page);
  const card = page.getByRole('region', { name: 'Signed in as' });
  await expect(card.getByText(xName)).toBeVisible();
  await expect(card.getByText('Buyer', { exact: true })).toBeVisible();
  const panel = page.locator('.account-menu-panel');
  await expect(panel.getByRole('link', { name: 'Finish setup' })).toHaveAttribute('href', '/welcome');
  await expect(menu.getByRole('link', { name: 'My campaigns' })).toBeVisible();

  // Signing in again goes back to setup.
  await submit(page, page.getByRole('banner').getByRole('button', { name: 'Log out', exact: true }));
  await visit(page, '/explore');
  const logIn = page.getByRole('banner').getByRole('link', { name: 'Log in', exact: true });
  await waitForHydration(logIn);
  await logIn.click();
  const dialog = page.getByRole('dialog', { name: 'Sign in to your account' });
  const x = dialog.getByRole('button', { name: 'Continue with X' });
  await waitForHydration(x);
  await x.click();
  await authorizeSandboxX(page, username, /\/welcome/);

  await completeSetup(page, { name, headline: 'A restaking protocol opening its public testnet', intro: 'Arcadia lets stakers restake once and secure several networks. Testnet opens in October.' });
  await expect(page.getByRole('link', { name: /Finish setting up/ })).toHaveCount(0);
  menu = await openAccountMenu(page);
  await expect(card.getByText(name)).toBeVisible();
  await expect(card.locator('img.avatar-photo')).toBeVisible();
  await expect(panel.getByRole('link', { name: 'Finish setup' })).toHaveCount(0);
  await expect(menu.getByRole('link', { name: /^Wallet/ })).toHaveAttribute('href', '/settings/profile#wallets');
  await expect(menu).toBeVisible();
  // A finished account going to /welcome is sent on.
  await visit(page, '/welcome');
  await expect(page).toHaveURL(/\/dashboard$/);
});

test('the Account menu is short: who is signed in, the account’s own pages with icons, wallet state, profile and log out', async ({ page }) => {
  await login(page, 'creator_c');
  await visit(page, '/dashboard');
  const button = page.getByRole('banner').getByRole('button', { name: 'Account', exact: true });
  await expect(button.locator('.avatar')).toBeVisible();
  const menu = await openAccountMenu(page);
  const card = page.getByRole('region', { name: 'Signed in as' });
  await expect(card.getByText('Ari Nguyen', { exact: true })).toBeVisible();
  await expect(card).toContainText('Creator · @ari-makes');
  // The account comes first, then one list without group headings.
  const order = await page.locator('.account-menu-panel').evaluate((panel) => [...panel.children].map((child) => child.getAttribute('aria-label') ?? child.tagName.toLowerCase()));
  expect(order).toEqual(['Signed in as', 'Account menu', 'form']);
  await expect(page.locator('.account-menu-panel h4')).toHaveCount(0);
  const labels = (await menu.getByRole('link').allTextContents()).map((text) => text.replace(/\s+/g, ' ').trim());
  expect(labels.slice(0, 4)).toEqual(['Overview', 'My services', 'Orders', 'My applications']);
  expect(labels[4]).toMatch(/^Wallet ?(Connect|0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4})$/);
  expect(labels[5]).toBe('Profile');
  expect(labels).toHaveLength(6);
  // What the header already offers is not repeated here.
  for (const name of ['Open campaigns', 'New service', 'New auction', 'Funds']) await expect(menu.getByRole('link', { name, exact: true })).toHaveCount(0);
  await expect(page.getByRole('banner').getByRole('button', { name: 'Log out', exact: true })).toBeVisible();
});

test('on a phone, setup stacks the preview above the form and fits the screen', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, baseURL });
  const page = await context.newPage();
  await visit(page, '/sign-up?role=creator');
  await signUpInDialog(page, 'Creator');
  await expect(page.getByRole('heading', { level: 1, name: 'Set up your creator profile' })).toBeVisible();
  const upload = page.getByLabel('Upload photo');
  await waitForHydration(upload);
  await upload.setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: TINY_PNG });
  await expect(page.getByText('Ready', { exact: true })).toBeVisible();
  const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);
  const previewTop = await page.getByRole('complementary', { name: 'Preview' }).evaluate((node) => node.getBoundingClientRect().top);
  const formTop = await page.getByRole('region', { name: /Profile photo/ }).evaluate((node) => node.getBoundingClientRect().top);
  expect(previewTop).toBeLessThan(formTop);
  await context.close();
});
