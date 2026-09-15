import { expect, test } from '@playwright/test';
import { bookFromExplore, createPublishedService, expectNoHorizontalOverflow, login, payOrder, startOrder, submit, visit } from './helpers';

test('the creator proposes a later deadline and it changes only when the buyer accepts', async ({ page }) => {
  const service = await createPublishedService(page, 'deadline');
  const path = await bookFromExplore(page, service.title);
  await payOrder(page);
  await startOrder(page, path);

  const deadline = page.getByRole('region', { name: 'Deadline' });
  const current = await deadline.getByRole('listitem').filter({ hasText: 'Delivery due' }).locator('strong').innerText();
  // The form suggests two days after the current deadline.
  await deadline.getByLabel('Why more time is needed').fill('The buyer asked to add a second audience to the narrative.');
  await submit(page, deadline.getByRole('button', { name: 'Propose new deadline', exact: true }));
  await expect(page.getByRole('status')).toContainText('Deadline proposal sent');
  await expect(deadline.getByText('You proposed a new deadline')).toBeVisible();
  await expect(deadline.getByRole('button', { name: 'Accept new deadline' })).toHaveCount(0);
  await expect(deadline.getByRole('listitem').filter({ hasText: 'Delivery due' }).locator('strong')).toHaveText(current);

  await login(page, 'buyer_a');
  await visit(page, path);
  await expect(deadline.getByText(/proposed a new deadline/)).toBeVisible();
  await expect(deadline.getByText('The buyer asked to add a second audience to the narrative.')).toBeVisible();
  await submit(page, deadline.getByRole('button', { name: 'Accept new deadline', exact: true }));
  await expect(page.getByRole('status')).toContainText('Deadline extended');
  await expect(deadline.getByRole('listitem').filter({ hasText: 'Delivery due' }).locator('strong')).not.toHaveText(current);
  await expect(deadline.getByRole('listitem').filter({ hasText: 'Accepted' })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await visit(page, path);
  await expectNoHorizontalOverflow(page);
});
