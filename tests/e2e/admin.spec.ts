import { expect, test, type Page } from '@playwright/test';
import { login, submit, uniqueSuffix, visit } from './helpers';

async function expectNotFound(page: Page, path: string) {
  // Next may stream notFound() after a 200 shell; require its actual 404 UI in either case.
  const response = await page.goto(path);
  expect([200, 404]).toContain(response?.status());
  await expect(page.getByText('404 · Not found', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'That page has moved on.', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: /^(Operator overview|Audit log)$/ })).toHaveCount(0);
}

test('buyer_a cannot access the admin overview', async ({ page }) => {
  await login(page, 'buyer_a');
  await expectNotFound(page, '/admin');
});

test('moderator can view moderation but cannot access the audit page', async ({ page }) => {
  await login(page, 'moderator');
  await visit(page, '/admin/moderation');
  await expect(page.getByRole('heading', { name: 'Moderation', exact: true })).toBeVisible();
  await expectNotFound(page, '/admin/audit');
});

test('finance can view operational queues', async ({ page }) => {
  await login(page, 'finance');
  await visit(page, '/admin/operations');
  await expect(page.getByRole('heading', { name: 'Operations', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Provider operations/ })).toBeVisible();
});

test('admin saves a flag with a unique audit reason and sees success', async ({ page }) => {
  await login(page, 'admin');
  await visit(page, '/admin/flags');
  const reason = `E2E flag audit ${uniqueSuffix()}: Confirm the existing booking setting.`;
  const flag = page.locator('section').filter({ has: page.getByRole('heading', { name: 'BOOKING_ENABLED', exact: true }) });
  // A <select> inside its <label> includes the selected option in its accessible name.
  const enabled = flag.getByLabel('Enabled (admin only)');
  const original = await enabled.inputValue();
  // A same-value save exercises the audited form without disabling another journey's sales.
  await enabled.selectOption(original);
  await flag.getByLabel('Reason for the audit log (at least 10 characters)', { exact: true }).fill(reason);
  await submit(page, flag.getByRole('button', { name: 'Save flag', exact: true }));
  await expect(page.getByRole('status')).toBeVisible();
  await expect(flag).toContainText(reason);
  await expect(enabled).toHaveValue(original);
});
