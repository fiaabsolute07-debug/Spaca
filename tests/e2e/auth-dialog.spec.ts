import { expect, test } from '@playwright/test';
import { chooseOption, submit, uniqueSuffix, visit, waitForHydration } from './helpers';

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

test('Get started opens account creation in the dialog and signs the new account in', async ({ page }) => {
  await visit(page, '/explore');
  const start = page.getByRole('banner').getByRole('link', { name: 'Get started', exact: true });
  await waitForHydration(start);
  await start.click();
  const dialog = page.getByRole('dialog', { name: 'Create your account' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Continue with email' }).click();
  await dialog.getByLabel('Your name').fill('Dialog Tester');
  await dialog.getByLabel('Email address').fill(`dialog-${uniqueSuffix()}@example.test`);
  await dialog.getByLabel(/^Password/).fill('a-long-test-password');
  await Promise.all([page.waitForURL(/\/dashboard$/), dialog.getByRole('button', { name: 'Create account' }).click()]);
  await expect(page.getByRole('banner').getByRole('link', { name: 'Workspace' })).toBeVisible();
  // Accounts are one type; without a choice a new account hires.
  const sidebar = page.getByRole('complementary', { name: 'Workspace' });
  await expect(page.getByRole('banner').getByRole('link', { name: 'Your profile' })).toBeVisible();
  await expect(sidebar.getByRole('link', { name: 'Post a brief' })).toBeVisible();
  await expect(sidebar.getByRole('link', { name: 'My services' })).toHaveCount(0);
});

test('a creator account sells: its workspace has no hiring tools and booking asks for a buyer account', async ({ page }) => {
  await visit(page, '/explore');
  const serviceHref = await page.locator('a[href^="/services/"]').first().getAttribute('href');
  const start = page.getByRole('banner').getByRole('link', { name: 'Get started', exact: true });
  await waitForHydration(start);
  await start.click();
  const dialog = page.getByRole('dialog', { name: 'Create your account' });
  await dialog.getByRole('button', { name: 'Continue with email' }).click();
  await dialog.getByLabel('Your name').fill('Creator Tester');
  await dialog.getByLabel('Email address').fill(`creator-${uniqueSuffix()}@example.test`);
  await dialog.getByLabel(/^Password/).fill('a-long-test-password');
  await chooseOption(page, dialog, 'What brings you here?', 'I want to offer my skills');
  await Promise.all([page.waitForURL(/\/dashboard$/), dialog.getByRole('button', { name: 'Create account' }).click()]);

  const sidebar = page.getByRole('complementary', { name: 'Workspace' });
  await expect(page.getByRole('banner').getByRole('link', { name: 'Your profile' })).toBeVisible();
  await expect(sidebar.getByRole('link', { name: 'My services' })).toBeVisible();
  await expect(sidebar.getByRole('link', { name: 'Post a brief' })).toHaveCount(0);

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
  await expect(page.getByRole('banner').getByRole('link', { name: 'Workspace' })).toBeVisible();

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
  await dialog.getByRole('button', { name: 'Continue with email' }).click();
  await chooseOption(page, dialog, 'What brings you here?', 'I want to offer my skills');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/127\.0\.0\.1:3100\/$/);
});
