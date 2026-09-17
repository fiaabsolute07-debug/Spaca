import { expect, test } from '@playwright/test';
import { completeSetup, submit, signUpInDialog, uniqueSuffix, visit, waitForHydration, openAccountMenu } from './helpers';

test('Log in opens a dialog over the current page; errors show in place; Escape returns to the page', async ({ page }) => {
  await visit(page, '/explore');
  const login = page.getByRole('banner').getByRole('link', { name: 'Log in', exact: true });
  await waitForHydration(login);
  await login.click();
  const dialog = page.getByRole('dialog', { name: 'Sign in to your account' });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/\/sign-in$/);
  // The page behind stays mounted.
  await expect(page.getByRole('heading', { level: 1, name: 'Find creators for your launch.' })).toBeAttached();

  await dialog.getByRole('button', { name: 'Continue with email' }).click();
  await dialog.getByLabel('Email address').fill(`nobody-${uniqueSuffix()}@example.test`);
  await dialog.getByLabel(/^Password/).fill('wrong-password-123');
  await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('The email or password is not correct.');
  await expect(page).toHaveURL(/\/sign-in$/);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/explore$/);
});

test('Get started asks for the account type first, then signs up a buyer account with X that starts at setup', async ({ page }) => {
  await visit(page, '/explore');
  const start = page.getByRole('banner').getByRole('link', { name: 'Get started', exact: true });
  await waitForHydration(start);
  await start.click();
  const dialog = page.getByRole('dialog', { name: 'Create your account' });
  await expect(dialog).toBeVisible();
  // Nothing is chosen for the person: email waits until Buyer or Creator is picked.
  await expect(dialog.getByRole('group', { name: 'Choose your account type' })).toBeVisible();
  await expect(dialog.getByRole('radio', { name: /^Buyer/ })).not.toBeChecked();
  await expect(dialog.getByRole('radio', { name: /^Creator/ })).not.toBeChecked();
  // Sign-up is X only: its button waits until Buyer or Creator is picked, and there is no email form.
  await expect(dialog.getByRole('button', { name: 'Continue with X' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Continue with email' })).toHaveCount(0);
  await expect(dialog.getByText('Choose Buyer or Creator to continue.')).toBeVisible();
  await expect(dialog.getByLabel('Your name')).toHaveCount(0);
  await signUpInDialog(page, 'Buyer');
  await expect(page.getByRole('heading', { level: 1, name: 'Set up your project' })).toBeVisible();
  await expect(page.getByRole('banner').getByRole('button', { name: 'Account', exact: true })).toBeVisible();
  const menu = await openAccountMenu(page);
  await expect(menu.getByRole('link', { name: 'Profile', exact: true })).toBeVisible();
  await expect(menu.getByRole('link', { name: 'My campaigns' })).toBeVisible();
  await expect(menu.getByRole('link', { name: 'My services' })).toHaveCount(0);
});

test('a creator account sells: its workspace has no hiring tools and booking asks for a buyer account', async ({ page }) => {
  await visit(page, '/explore');
  const serviceHref = await page.locator('a[href^="/services/"]').first().getAttribute('href');
  const start = page.getByRole('banner').getByRole('link', { name: 'Get started', exact: true });
  await waitForHydration(start);
  await start.click();
  await signUpInDialog(page, 'Creator');
  await completeSetup(page, { name: 'Creator Tester', handle: `tester-${uniqueSuffix().replace(/\D/g, '').slice(-8)}`, headline: 'Launch threads for DeFi teams', intro: 'I write launch threads for L2 testnets and explain restaking in plain words.' });

  const menu = await openAccountMenu(page);
  await expect(menu.getByRole('link', { name: 'Profile', exact: true })).toBeVisible();
  await expect(menu.getByRole('link', { name: 'My services' })).toBeVisible();
  await expect(menu.getByRole('link', { name: 'My campaigns' })).toHaveCount(0);

  await visit(page, '/buyer/requests/new');
  await expect(page.getByRole('heading', { name: 'This page is for buyer accounts' })).toBeVisible();
  expect(serviceHref).toMatch(/^\/services\/[0-9a-f-]{36}/);
  await visit(page, serviceHref!);
  await expect(page.getByRole('heading', { name: 'Booking needs a buyer account' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Reserve|Buy license/ })).toHaveCount(0);
});

test('the dialog switches between sign in and join, offers local test accounts, and /sign-in still works as a page', async ({ page }) => {
  await visit(page, '/explore');
  const login = page.getByRole('banner').getByRole('link', { name: 'Log in', exact: true });
  await waitForHydration(login);
  await login.click();
  const dialog = page.getByRole('dialog', { name: 'Sign in to your account' });
  await dialog.getByRole('button', { name: 'Join here' }).click();
  await expect(page.getByRole('dialog', { name: 'Create your account' })).toBeVisible();
  await expect(page).toHaveURL(/\/sign-up$/);
  await page.getByRole('dialog').getByRole('button', { name: 'Sign in' }).click();
  await expect(dialog).toBeVisible();

  await submit(page, dialog.getByRole('button', { name: /Sam Tran/ }));
  await expect(page).toHaveURL(/\/explore$/);
  await expect(page.getByRole('banner').getByRole('button', { name: 'Account', exact: true })).toBeVisible();

  const context = await page.context().browser()!.newContext();
  const direct = await context.newPage();
  const response = await direct.goto('/sign-in');
  expect(response?.status()).toBe(200);
  await expect(direct.getByRole('heading', { level: 1, name: 'Sign in to your account' })).toBeVisible();
  await expect(direct.getByRole('dialog')).toHaveCount(0);
  await context.close();
});

test('on the landing, Early access opens the join dialog over the landing with the role choice usable', async ({ page }) => {
  await page.goto('/');
  const cta = page.getByRole('link', { name: 'Early access' }).first();
  await waitForHydration(cta);
  await cta.click();
  const dialog = page.getByRole('dialog', { name: 'Create your account' });
  await expect(dialog).toBeVisible();
  // The landing keeps its own navigation; the marketplace header does not appear behind the dialog.
  await expect(page.getByPlaceholder('Search creators and services')).toHaveCount(0);
  // Early access is for projects, so Buyer comes chosen; the person can still pick Creator.
  await expect(dialog.getByRole('radio', { name: /^Buyer/ })).toBeChecked();
  await dialog.getByRole('radio', { name: /^Creator/ }).check();
  await expect(dialog.getByRole('button', { name: 'Continue with X' })).toBeEnabled();
  await expect(dialog.getByRole('radio', { name: /^Creator/ })).toBeChecked();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/127\.0\.0\.1:3100\/$/);
});
