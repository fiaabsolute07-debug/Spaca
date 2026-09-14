import { expect, test } from '@playwright/test';
import { bookFromExplore, createPublishedService, deliverText, expectOrderState, login, payOrder, startOrder, submit, uniqueSuffix, visit } from './helpers';

test('a buyer requests the included revision and receives version 2 with version 1 preserved', async ({ page }) => {
  const service = await createPublishedService(page, 'revision');
  const path = await bookFromExplore(page, service.title);
  await payOrder(page);
  await startOrder(page, path);
  const v1 = `Original delivery ${uniqueSuffix()}: A complete launch story with product positioning and CTA.`;
  const v2 = `Revised delivery ${uniqueSuffix()}: A clearer audience, shorter introduction and revised CTA.`;
  await deliverText(page, v1);
  await login(page, 'buyer_a');
  await visit(page, path);
  await page.getByLabel('What should change? (1 revision left)', { exact: true }).fill('Please shorten the introduction and make the intended audience explicit.');
  await submit(page, page.getByRole('button', { name: 'Request included revision', exact: true }));
  await expectOrderState(page, 'REVISION_REQUESTED');
  await login(page, 'creator_c');
  await visit(page, path);
  await deliverText(page, v2);
  await login(page, 'buyer_a');
  await visit(page, path);
  await expectOrderState(page, 'DELIVERED');
  await expect(page.getByText('Version 1', { exact: true })).toBeVisible();
  await expect(page.getByText('Version 2', { exact: true })).toBeVisible();
  await expect(page.getByText(v1, { exact: true })).toBeVisible();
  await expect(page.getByText(v2, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve version 2', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Request included revision', exact: true })).toHaveCount(0);
});

test('finance resumes a newly disputed order into its recorded IN_PROGRESS state with an audit reason', async ({ page }) => {
  const service = await createPublishedService(page, 'dispute');
  const path = await bookFromExplore(page, service.title);
  await payOrder(page);
  await startOrder(page, path);
  await login(page, 'buyer_a');
  await visit(page, path);
  await expectOrderState(page, 'IN_PROGRESS');
  await page.getByLabel('What went wrong?', { exact: true }).fill(`Dispute ${uniqueSuffix()}: Please clarify the agreed scope before the next delivery.`);
  await submit(page, page.getByRole('button', { name: 'Open a dispute', exact: true }));
  await expectOrderState(page, 'DISPUTED');
  await login(page, 'finance');
  await visit(page, '/admin/disputes');
  const id = path.split('/').at(-1)!;
  // Unnamed section: identify the case by its rendered order link, not queue position.
  const dispute = page.locator('section').filter({
    has: page.getByRole('link', { name: `Order #${id.slice(0, 8)} ↗`, exact: true }),
  });
  await expect(dispute).toHaveCount(1);
  await expect(dispute.getByRole('link')).toHaveAttribute('href', `/admin/orders/${id}`);
  await expect(dispute).toContainText('State before dispute: IN_PROGRESS');
  await dispute.getByLabel('Outcome').selectOption('RESUME');
  await dispute.getByLabel('Reason for the audit log (at least 10 characters)', { exact: true })
    .fill(`Resume ${uniqueSuffix()}: Both parties clarified scope and agreed to continue work.`);
  await submit(page, dispute.getByRole('button', { name: 'Resolve dispute', exact: true }));
  await expect(page.getByRole('status')).toBeVisible();
  await expect(dispute).toHaveCount(0);
  await login(page, 'buyer_a');
  await visit(page, path);
  await expectOrderState(page, 'IN_PROGRESS');
});
