import { expect, test } from '@playwright/test';
import { authorizeSandboxX, openAccountMenu, signUpInDialog, submit, visit, waitForHydration } from './helpers';

test('an account made with X adds an email in settings, then signs in with either; X cannot be dropped while it is the only way in', async ({ page }) => {
  await visit(page, '/sign-up?role=creator');
  const username = await signUpInDialog(page, 'Creator');

  await visit(page, '/settings/profile');
  const signIn = page.getByRole('region', { name: 'Sign-in' });
  const methods = signIn.getByRole('listitem');
  await expect(methods.filter({ hasText: /^X/ })).toContainText(`@${username} · sandbox X`);
  await expect(methods.filter({ hasText: 'Email and password' })).toContainText('Not added');
  // Disconnecting X now would lock the account out.
  await expect(page.getByRole('region', { name: 'X account' }).getByText('Add an email under Sign-in before disconnecting it.')).toBeVisible();
  const disconnect = page.getByRole('region', { name: 'X account' }).getByRole('button', { name: 'Disconnect X' });
  await Promise.all([page.waitForURL(/error=/), disconnect.click()]);
  await expect(page.getByRole('main').getByRole('alert')).toContainText('X is how you sign in to this account.');

  const email = `${username}@example.test`;
  await signIn.getByLabel('Email address').fill(email);
  await signIn.getByLabel(/^Password/).fill('a-long-test-password');
  await submit(page, signIn.getByRole('button', { name: 'Add email', exact: true }));
  await expect(page.getByRole('main').getByRole('status')).toContainText('Email added.');
  await expect(methods.filter({ hasText: 'Email and password' })).toContainText(email);
  await expect(signIn.getByRole('button', { name: 'Add email' })).toHaveCount(0);

  // Signed out, both ways lead back in.
  await openAccountMenu(page);
  await submit(page, page.getByRole('banner').getByRole('button', { name: 'Log out', exact: true }));
  await visit(page, '/sign-in');
  const dialog = page.locator('.auth-dialog');
  const email_ = dialog.getByRole('button', { name: 'Continue with email' });
  await waitForHydration(email_);
  await email_.click();
  await dialog.getByLabel('Email address').fill(email);
  await dialog.getByLabel('Password').fill('a-long-test-password');
  await Promise.all([page.waitForURL(/\/welcome/), dialog.getByRole('button', { name: 'Sign in', exact: true }).click()]);

  await openAccountMenu(page);
  await submit(page, page.getByRole('banner').getByRole('button', { name: 'Log out', exact: true }));
  await visit(page, '/sign-in');
  const x = page.locator('.auth-dialog').getByRole('button', { name: 'Continue with X' });
  await waitForHydration(x);
  await x.click();
  await authorizeSandboxX(page, username, /\/welcome/);
  await expect(page.getByRole('banner').getByRole('button', { name: 'Account', exact: true })).toBeVisible();
});
