import { expect, test } from '@playwright/test';
import { createPublishedService, dateTimeLocal, login, orderPath, payOrder, submit, uniqueSuffix, visit } from './helpers';

test('a cap-only two-hire request funds one creator after application, offer and capacity confirmation', async ({ page }) => {
  // creator_c needs a published service with an approved sample before applying.
  await createPublishedService(page, 'request-hire');
  const title = `E2E two hires ${uniqueSuffix()}`;
  await login(page, 'buyer_a');
  await visit(page, '/buyer/requests/new');
  await page.getByLabel('Brief title', { exact: true }).fill(title);
  await page.getByRole('group', { name: 'What is the campaign for?' }).getByRole('radio', { name: /^Education/ }).check();
  await page.getByRole('group', { name: 'What do you need?' }).getByRole('radio', { name: /^Create/ }).check();
  await page.getByLabel('Brief', { exact: true }).fill(`Develop two independent launch narratives for ${title}, each with audience, message and CTA.`);
  await page.getByLabel('Total budget (USD, optional if you set a cap)', { exact: true }).fill('');
  await page.getByLabel('Per creator cap (USD, optional)', { exact: true }).fill('200');
  await page.getByLabel('Creators needed', { exact: true }).fill('2');
  await page.getByLabel('Delivery deadline', { exact: true }).fill(dateTimeLocal(new Date(Date.now() + 14 * 86400_000)));
  await submit(page, page.getByRole('button', { name: 'Publish brief', exact: true }));
  // create_request redirects straight to the new request page.
  const requestPath = new URL(page.url()).pathname;
  expect(requestPath).toMatch(/^\/requests\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: /^Total budget/ })).toContainText('$400.00');
  await login(page, 'creator_c');
  await visit(page, requestPath);
  await page.getByLabel('Your quote (USD)', { exact: true }).fill('100');
  await page.getByLabel('Delivery time (hours)', { exact: true }).fill('24');
  await page.getByLabel('Your approach and relevant samples', { exact: true }).fill(`Application ${uniqueSuffix()}: I will research the audience and deliver a launch narrative with a focused CTA.`);
  await submit(page, page.getByRole('button', { name: 'Send application', exact: true }));
  await login(page, 'buyer_a');
  await visit(page, requestPath);
  // REQ-11: sorting and filters change only the view, and the CSV lists the same applications.
  const sortNav = page.getByRole('navigation', { name: 'Sort applications' });
  await Promise.all([page.waitForURL(/sort=quote_low/), sortNav.getByRole('link', { name: 'Lowest quote', exact: true }).click()]);
  await expect(sortNav.getByRole('link', { name: 'Lowest quote', exact: true })).toHaveAttribute('aria-current', 'true');
  const filterNav = page.getByRole('navigation', { name: 'Filter applications' });
  await Promise.all([page.waitForURL(/status=OFFERED/), filterNav.getByRole('link', { name: 'Offer sent', exact: true }).click()]);
  await expect(page.getByRole('heading', { name: 'No applications match this filter' })).toBeVisible();
  await Promise.all([page.waitForURL(/status=SUBMITTED/), filterNav.getByRole('link', { name: 'Waiting for you', exact: true }).click()]);
  const csv = await page.request.get(`/api/requests/${requestPath.split('/').pop()}/applications`);
  expect(csv.status()).toBe(200);
  expect(csv.headers()['content-type']).toContain('text/csv');
  const csvText = await csv.text();
  expect(csvText.split('\r\n')[0]).toBe('creator,handle,status,quote_usd,turnaround_hours,quote_version,valid_until,offer_status,received_at,updated_at,note');
  expect(csvText).toContain('"SUBMITTED","100.00","24"');
  await submit(page, page.getByRole('button', { name: 'Offer $100.00 to this creator', exact: true }));
  await expect(page.getByText(/Offer sent, waiting for the creator/)).toBeVisible();
  await login(page, 'creator_c');
  await visit(page, requestPath);
  await expect(page.getByText('Accepting creates the order. The buyer funds it before work starts.')).toBeVisible();
  await submit(page, page.getByRole('button', { name: 'Accept offer', exact: true }));
  const path = orderPath(page);
  await login(page, 'buyer_a');
  await visit(page, path);
  await payOrder(page);
  await visit(page, requestPath);
  await expect(page.getByRole('heading', { name: 'Campaign', exact: true })).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'Hires funded / needed' })).toHaveText(/Hires funded \/ needed\s*1 \/ 2/);
});
