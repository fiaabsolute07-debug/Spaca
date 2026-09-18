import { expect, test } from '@playwright/test';
import { openAccountMenu, signUpInDialog, submit, visit, waitForHydration, xUsername } from './helpers';

/** Chooses `email` on the local stand-in for Google's account chooser, and waits for spaca to take over again. */
async function chooseSandboxGoogle(page: import('@playwright/test').Page, email: string, destination: RegExp) {
  await page.waitForURL(/\/dev\/google-authorize\?/);
  await page.getByLabel('Sandbox Google account').fill(email);
  await Promise.all([page.waitForURL(destination), page.getByRole('button', { name: 'Continue', exact: true }).click()]);
}

test('an account made with X connects Google in settings and then signs in with Google', async ({ page }) => {
  await visit(page, '/sign-up?role=buyer');
  const username = await signUpInDialog(page, 'Buyer');

  await visit(page, '/settings/profile');
  const signIn = page.getByRole('region', { name: 'Sign-in' });
  const row = signIn.getByRole('listitem').filter({ hasText: 'Google' });
  await expect(row).toContainText('Not connected');
  const connect = row.getByRole('button', { name: 'Connect Google' });
  await waitForHydration(signIn.getByLabel('Email address'));
  await connect.click();
  const email = `${username}@gmail.com`;
  await chooseSandboxGoogle(page, email, /\/settings\/profile\?/);
  await expect(page.getByRole('main').getByRole('status')).toContainText(`Google account ${email} connected.`);
  await expect(row).toContainText(`${email} · sandbox Google`);
  await expect(row.getByRole('button', { name: 'Disconnect' })).toBeVisible();
  // The Google address is offered for the email and password too.
  await expect(signIn.getByLabel('Email address')).toHaveValue(email);

  await openAccountMenu(page);
  await submit(page, page.getByRole('banner').getByRole('button', { name: 'Log out', exact: true }));
  await visit(page, '/sign-in');
  const google = page.locator('.auth-dialog').getByRole('button', { name: 'Continue with Google' });
  await waitForHydration(google);
  await google.click();
  await chooseSandboxGoogle(page, email, /\/welcome/);
  await expect(page.getByRole('banner').getByRole('button', { name: 'Account', exact: true })).toBeVisible();
});

test('a new account can be created with Google, once an account type is chosen', async ({ page }) => {
  await visit(page, '/sign-up');
  const dialog = page.locator('.auth-dialog');
  const google = dialog.getByRole('button', { name: 'Continue with Google' });
  await waitForHydration(google);
  // Each account is one type, so neither way in is open before that choice is made.
  await expect(google).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Continue with X' })).toBeDisabled();
  await expect(dialog.getByText('Choose Buyer or Creator to continue.')).toBeVisible();

  await dialog.getByRole('radio', { name: /^Creator/ }).check();
  await expect(google).toBeEnabled();
  const email = `${xUsername()}@gmail.com`;
  await google.click();
  await chooseSandboxGoogle(page, email, /\/welcome(\?|$)/);
  await expect(page.getByRole('main').getByRole('status')).toContainText(`Signed up with Google as ${email}.`);

  // It is a creator account, and setup comes before the workspace, exactly as after signing up with X.
  await expect(page.getByLabel('Creator name')).toBeVisible();
  await openAccountMenu(page);
  const menu = page.getByRole('banner');
  await expect(menu).toContainText('Creator');
  await expect(menu).toContainText('Finish setup');
  await expect(menu.getByRole('link', { name: 'My services' })).toBeVisible();

  // Signing out and back in with the same Google account returns to the same account, not a second one.
  await submit(page, page.getByRole('banner').getByRole('button', { name: 'Log out', exact: true }));
  await visit(page, '/sign-in');
  const again = page.locator('.auth-dialog').getByRole('button', { name: 'Continue with Google' });
  await waitForHydration(again);
  await again.click();
  await chooseSandboxGoogle(page, email, /\/welcome(\?|$)/);
  await expect(page.getByRole('banner').getByRole('button', { name: 'Account', exact: true })).toBeVisible();
});
