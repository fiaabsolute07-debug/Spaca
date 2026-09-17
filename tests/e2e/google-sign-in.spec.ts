import { expect, test } from '@playwright/test';
import { openAccountMenu, signUpInDialog, submit, visit, waitForHydration } from './helpers';

/** Chooses `email` on the local stand-in for Google's account chooser, and waits for spaca to take over again. */
async function chooseSandboxGoogle(page: import('@playwright/test').Page, email: string, destination: RegExp) {
  await page.waitForURL(/\/dev\/google-authorize\?/);
  await page.getByLabel('Sandbox Google account').fill(email);
  await Promise.all([page.waitForURL(destination), page.getByRole('button', { name: 'Continue', exact: true }).click()]);
}

test('an account made with X connects Google in settings and then signs in with Google', async ({ page }) => {
  await visit(page, '/sign-up?role=buyer');
  const dialog = page.locator('.auth-dialog');
  await expect(dialog.getByRole('button', { name: 'Continue with Google' })).toHaveCount(0);
  await expect(dialog.getByText('After joining, you can connect Google (Gmail) or add an email in your account settings.')).toBeVisible();
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
