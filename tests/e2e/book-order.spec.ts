import { expect, test } from '@playwright/test';
import { bookFromExplore, createPublishedService, deliverText, expectOrderState, login, payOrder, runJobs, startOrder, submit, uniqueSuffix, visit } from './helpers';

test('buyer books creator_c’s first published service, pays, approves delivery v1 and becomes eligible to review', async ({ page }) => {
  const service = await createPublishedService(page, 'book');
  const path = await bookFromExplore(page, service.title);
  await payOrder(page);
  // ORD-01 receipt: what was charged, how and when, and that the creator's money is held.
  const receipt = page.getByRole('region', { name: 'Receipt' });
  const fact = (label: string) => receipt.getByRole('listitem').filter({ hasText: new RegExp(`^${label}`) });
  await expect(fact('Amount charged')).toContainText('$100.00');
  await expect(fact('Platform fee')).toContainText('$0.00');
  await expect(fact('Paid with')).toContainText('Card');
  await expect(fact('Paid on')).toContainText('UTC');
  await expect(fact('Payment')).toContainText('Paid');
  await expect(fact('Creator payout')).toContainText('Held until the buyer approves');
  await startOrder(page, path);
  await expect(fact('Amount charged')).toContainText('$100.00');
  await deliverText(page, `Delivery ${uniqueSuffix()}: The complete launch narrative, three hooks and a clear CTA.`);
  await login(page, 'buyer_a');
  await visit(page, path);
  await submit(page, page.getByRole('button', { name: 'Approve version 1', exact: true }));
  await expectOrderState(page, 'APPROVED');
  await runJobs(page);
  await visit(page, path);
  await expectOrderState(page, 'COMPLETED');
  await expect(fact('Creator payout')).toContainText('Released to the creator');
  await expect(fact('Payment')).toContainText('Paid');
  await expect(page.getByRole('button', { name: 'Leave a review', exact: true })).toBeVisible();
  await expect(page.getByLabel('Rating (1–5)', { exact: true })).toBeVisible();
  await expect(page.getByLabel('What stood out?', { exact: true })).toBeVisible();
});
