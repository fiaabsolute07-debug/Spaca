import { expect, test } from '@playwright/test';
import { baseURL, chooseOption, createPublishedService, dateTimeLocal, login, submit, visit } from './helpers';

test('buyer_a sees a live outbid update within 12 seconds after buyer_b bids in a separate context', async ({ page, browser }) => {
  const service = await createPublishedService(page, 'auction');
  await visit(page, '/creator/auctions/new');
  await chooseOption(page, page, 'Published service', `${service.title} · $100.00`);
  await page.getByLabel('Starting price (USD)', { exact: true }).fill('100');
  await page.getByLabel('Minimum increment (USD)', { exact: true }).fill('10');
  await page.getByLabel('Buy now price (optional)', { exact: true }).fill('400');
  // Start slightly in the past within the server's five-minute allowance; finish ~2 h later.
  await page.getByLabel('Starts at', { exact: true }).fill(dateTimeLocal(new Date(Date.now() - 60_000)));
  await page.getByLabel('Ends at', { exact: true }).fill(dateTimeLocal(new Date(Date.now() + 2 * 3600_000)));
  await submit(page, page.getByRole('button', { name: 'Schedule auction', exact: true }));
  // create_auction redirects straight to the new auction page.
  const auctionPath = new URL(page.url()).pathname;
  expect(auctionPath).toMatch(/^\/auctions\/[0-9a-f-]{36}$/);

  // Reuse the first isolated context for buyer_a; buyer_b never shares its cookies.
  await login(page, 'buyer_a');
  await visit(page, auctionPath);
  await expect(page.getByRole('button', { name: 'Buy now · $400.00', exact: true })).toBeVisible();
  await page.getByLabel('Bid amount (USD, at least $100.00)', { exact: true }).fill('100');
  await submit(page, page.getByRole('button', { name: 'Place binding bid', exact: true }));
  await expect(page.getByText(/You are the highest bidder/)).toBeVisible();
  // The immutable Terms panel still mentions Buy Now; assert the purchase action is gone.
  await expect(page.getByRole('button', { name: /^Buy now ·/ })).toHaveCount(0);

  const buyerB = await browser.newContext({ baseURL });
  try {
    const other = await buyerB.newPage();
    await login(other, 'buyer_b');
    await visit(other, auctionPath);
    await expect(other.getByRole('button', { name: /^Buy now ·/ })).toHaveCount(0);
    await other.getByLabel('Bid amount (USD, at least $110.00)', { exact: true }).fill('120');
    await page.bringToFront();
    // Start the deadline before the second POST, with buyer_a already loaded and visible.
    const bidStarted = Date.now();
    await submit(other, other.getByRole('button', { name: 'Place binding bid', exact: true }));
    await page.bringToFront();
    const remaining = 12_000 - (Date.now() - bidStarted);
    expect(remaining, 'Second bid must finish within the 12-second live-update budget').toBeGreaterThan(0);
    await expect(page.getByText(/You have been outbid · your best \$100\.00/)).toBeVisible({ timeout: remaining });
    expect(Date.now() - bidStarted).toBeLessThanOrEqual(12_000);
    await expect(page.getByRole('listitem').filter({ hasText: 'Minimum next bid' })).toContainText('$130.00');
    await expect(page.getByRole('button', { name: /^Buy now ·/ })).toHaveCount(0);
    await expect(other.getByText(/You are the highest bidder/)).toBeVisible();
  } finally {
    await buyerB.close();
  }
});
