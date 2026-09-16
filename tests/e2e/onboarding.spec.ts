import { expect, test } from '@playwright/test';
import { TINY_PNG, completeSetup, login, openAccountMenu, signUpInDialog, submit, uniqueSuffix, visit, waitForHydration } from './helpers';

test('setup comes first after sign-up: it previews the profile, asks for the logo, and waits for the account until done', async ({ page }) => {
  await visit(page, '/explore');
  const start = page.getByRole('banner').getByRole('link', { name: 'Get started', exact: true });
  await waitForHydration(start);
  await start.click();
  const email = await signUpInDialog(page, 'Buyer');
  await expect(page.getByRole('heading', { level: 1, name: 'Set up your project' })).toBeVisible();
  await expect(page.getByText('Buyer account · Set up')).toBeVisible();

  // The preview follows what is typed.
  const preview = page.getByRole('complementary', { name: 'Preview' });
  await expect(preview.getByText('Your project name')).toBeVisible();
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
  await expect(page).toHaveURL(/\/welcome$/);
  await expect(page.getByLabel('Project name')).toHaveValue(name);

  // Leaving setup for later: the workspace keeps asking, and the Account menu marks it.
  await Promise.all([page.waitForURL(/\/dashboard$/), page.getByRole('link', { name: 'Do this later' }).click()]);
  const nudge = page.getByRole('link', { name: /Finish setting up your project/ });
  await expect(nudge).toBeVisible();
  let menu = await openAccountMenu(page);
  const card = page.getByRole('region', { name: 'Signed in as' });
  await expect(card.getByText('New project')).toBeVisible();
  await expect(card.getByText('Buyer account', { exact: true })).toBeVisible();
  await expect(card.getByRole('link', { name: /Finish setup/ })).toHaveAttribute('href', '/welcome');
  await expect(menu.getByRole('link', { name: 'Post a brief' })).toBeVisible();

  // Signing in again goes back to setup.
  await submit(page, page.getByRole('banner').getByRole('button', { name: 'Log out', exact: true }));
  await visit(page, '/explore');
  const logIn = page.getByRole('banner').getByRole('link', { name: 'Log in', exact: true });
  await waitForHydration(logIn);
  await logIn.click();
  const dialog = page.getByRole('dialog', { name: 'Sign in to your account' });
  await dialog.getByRole('button', { name: 'Continue with email' }).click();
  await dialog.getByLabel('Email address').fill(email);
  await dialog.getByLabel(/^Password/).fill('a-long-test-password');
  await Promise.all([page.waitForURL(/\/welcome/), dialog.getByRole('button', { name: 'Sign in', exact: true }).click()]);

  await completeSetup(page, { name, headline: 'A restaking protocol opening its public testnet', intro: 'Arcadia lets stakers restake once and secure several networks. Testnet opens in October.' });
  await expect(page.getByRole('link', { name: /Finish setting up/ })).toHaveCount(0);
  menu = await openAccountMenu(page);
  await expect(card.getByText(name)).toBeVisible();
  await expect(card.locator('img.avatar-photo')).toBeVisible();
  await expect(card.getByRole('link', { name: /Finish setup/ })).toHaveCount(0);
  await expect(card.getByRole('link', { name: /Wallet/ })).toHaveAttribute('href', '/settings/profile#wallets');
  await expect(menu).toBeVisible();
  // A finished account going to /welcome is sent on.
  await visit(page, '/welcome');
  await expect(page).toHaveURL(/\/dashboard$/);
});

test('the Account menu opens on the account: photo, name, handle, account type and wallet, before the workspace links', async ({ page }) => {
  await login(page, 'creator_c');
  await visit(page, '/dashboard');
  const button = page.getByRole('banner').getByRole('button', { name: 'Account', exact: true });
  await expect(button.locator('.avatar')).toBeVisible();
  const menu = await openAccountMenu(page);
  const card = page.getByRole('region', { name: 'Signed in as' });
  await expect(card.getByText('Ari Nguyen', { exact: true })).toBeVisible();
  await expect(card.getByText('@ari-makes', { exact: true })).toBeVisible();
  await expect(card.getByText('Creator account', { exact: true })).toBeVisible();
  const wallet = card.getByRole('link', { name: /Wallet/ });
  await expect(wallet).toHaveText(/^Wallet\s*(Connect wallet|0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4})/);
  // The account card comes before the workspace links.
  const order = await page.locator('.account-menu-panel').evaluate((panel) => [...panel.children].map((child) => child.getAttribute('aria-label') ?? child.tagName.toLowerCase()));
  expect(order.slice(0, 2)).toEqual(['Signed in as', 'Account menu']);
  await expect(menu.getByRole('link', { name: 'My services', exact: true })).toBeVisible();
});

test('on a phone, setup stacks the preview above the form and fits the screen', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, baseURL: 'http://127.0.0.1:3100' });
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
