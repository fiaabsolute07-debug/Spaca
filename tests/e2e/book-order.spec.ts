import { expect, test } from '@playwright/test';
import { bookFromExplore, createPublishedService, deliverText, expectOrderState, login, payOrder, runJobs, startOrder, submit, uniqueSuffix, visit } from './helpers';

test('buyer books creator_c’s first published service, pays, approves delivery v1 and becomes eligible to review', async ({ page }) => {
  const service = await createPublishedService(page, 'book');
  const path = await bookFromExplore(page, service.title);
  await payOrder(page);
  await startOrder(page, path);
  await deliverText(page, `Delivery ${uniqueSuffix()}: The complete launch narrative, three hooks and a clear CTA.`);
  await login(page, 'buyer_a');
  await visit(page, path);
  await submit(page, page.getByRole('button', { name: 'Approve version 1', exact: true }));
  await expectOrderState(page, 'APPROVED');
  await runJobs(page);
  await visit(page, path);
  await expectOrderState(page, 'COMPLETED');
  await expect(page.getByRole('button', { name: 'Leave a review', exact: true })).toBeVisible();
  await expect(page.getByLabel('Rating (1–5)', { exact: true })).toBeVisible();
  await expect(page.getByLabel('What stood out?', { exact: true })).toBeVisible();
});
