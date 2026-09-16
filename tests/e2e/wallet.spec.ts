import { expect, test } from '@playwright/test';
import { login, visit, waitForHydration } from './helpers';

test('the profile lists linked wallets and says plainly when no browser wallet is available', async ({ page }) => {
  await login(page, 'creator_d');
  await visit(page, '/settings/profile');
  const wallets = page.getByRole('region', { name: 'Wallets' });
  await expect(wallets.getByText('No wallet linked yet.', { exact: true })).toBeVisible();

  const link = wallets.getByRole('button', { name: 'Link a wallet', exact: true });
  await waitForHydration(link);
  await link.click();
  // This browser has no injected wallet, so the page says so instead of claiming anything was linked.
  await expect(wallets.getByRole('status')).toContainText('No browser wallet was found');
  await expect(wallets.getByText('No wallet linked yet.', { exact: true })).toBeVisible();
});
