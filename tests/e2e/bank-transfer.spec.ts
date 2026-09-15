import { expect, test, type Page } from '@playwright/test';
import { bookFromExplore, chooseOption, createPublishedService, expectOrderState, login, submit, uniqueSuffix, visit } from './helpers';

async function setBankFunding(page: Page, enabled: boolean) {
  await login(page, 'admin');
  await visit(page, '/admin/flags');
  const flag = page.locator('section').filter({ has: page.getByRole('heading', { name: 'BANK_FUNDING_ENABLED', exact: true }) });
  await chooseOption(page, flag, 'Enabled (admin only)', String(enabled));
  await flag.getByLabel('Reason for the audit log (at least 10 characters)', { exact: true }).fill(`E2E ${uniqueSuffix()}: ${enabled ? 'enable' : 'disable'} bank funding for the local journey.`);
  await submit(page, flag.getByRole('button', { name: 'Save flag', exact: true }));
}

test('a buyer pays by bank transfer; the order waits on its own hold and is funded only when the bank settles', async ({ page }) => {
  await setBankFunding(page, true);
  try {
    const service = await createPublishedService(page, 'bank');
    const path = await bookFromExplore(page, service.title);

    await submit(page, page.getByRole('button', { name: 'Pay by bank transfer', exact: true }));
    await expect(page.getByRole('status')).toContainText('Work starts only after the bank confirms the transfer');
    const transfer = page.getByRole('region', { name: 'Bank transfer' });
    await expect(transfer.getByRole('listitem').filter({ hasText: 'Payment reference' })).toContainText(/mock_fund_/);
    await expect(transfer.getByRole('listitem').filter({ hasText: 'Status' })).toContainText('Waiting for your transfer');
    await expect(transfer.getByText('receipts and screenshots are not accepted as payment')).toBeVisible();
    await expect(transfer.locator('input[type="file"]')).toHaveCount(0);

    await submit(page, transfer.getByRole('button', { name: 'Sandbox: send the transfer', exact: true }));
    await expectOrderState(page, 'AWAITING_PAYMENT');
    await expect(transfer.getByRole('listitem').filter({ hasText: 'Status' })).toContainText('On its way');

    await login(page, 'creator_c');
    await visit(page, path);
    await expect(page.getByRole('button', { name: 'Start work', exact: true })).toHaveCount(0);

    await login(page, 'buyer_a');
    await visit(page, path);
    await submit(page, transfer.getByRole('button', { name: 'Sandbox: bank settles it', exact: true }));
    await expectOrderState(page, 'FUNDED');
    await expect(page.getByRole('status')).toContainText('settled');
  } finally {
    await setBankFunding(page, false);
  }
});
