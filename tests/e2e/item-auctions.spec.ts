import { expect, test, type Page } from '@playwright/test';
import { TINY_PNG, baseURL, login, submit, uniqueSuffix, visit, waitForHydration } from './helpers';

/** Fill the listing form; times keep their defaults (opens now, closes in 3 days, delivery within 7 days). */
async function listItem(page: Page, fields: { title: string; type: string; origin?: 'project' | 'resale'; buyNow?: string; starting?: string; collateral?: string; increment?: string; pictures?: number }) {
  await visit(page, '/auctions/new');
  const create = page.getByRole('button', { name: 'Create listing' });
  await waitForHydration(create);
  if (fields.origin === 'project') await page.getByRole('radio', { name: /I’m the project/ }).check();
  await page.getByRole('button', { name: fields.type, exact: true }).click();
  await expect(page.getByLabel('Item type', { exact: true })).toHaveValue(fields.type);
  await page.getByLabel('Title').fill(fields.title);
  if (fields.pictures) {
    await page.getByLabel('Pictures (optional)').setInputFiles(Array.from({ length: fields.pictures }, (_, index) => ({ name: `picture-${index + 1}.png`, mimeType: 'image/png', buffer: TINY_PNG })));
    await expect(page.getByText('Ready', { exact: true })).toHaveCount(fields.pictures);
  }
  await page.getByLabel('Project', { exact: true }).fill('Nebula Punks');
  await page.getByLabel(/^Project link/).fill('x.com/nebulapunks');
  await page.getByLabel('Network').fill('Base');
  await page.getByLabel('Quantity').fill('1 spot');
  await page.getByLabel('Description').fill('One spot in the Nebula Punks genesis mint on Oct 12, mint price 0.015 ETH.');
  await page.getByLabel('How the winner receives it').fill("I submit the winner's wallet to the team's form before the snapshot.");
  await page.getByLabel('What the winner must give you').fill('EVM wallet address');
  await page.getByLabel('Starting price (USD)').fill(fields.starting ?? '100');
  // Stated, not inherited: the bid amounts below are arithmetic on this step, and the form's default is a
  // presentation choice that may change with the prices the marketplace suggests.
  await page.getByLabel('Minimum increment (USD)').fill(fields.increment ?? '10');
  if (fields.buyNow) await page.getByLabel(/^Buy now price/).fill(fields.buyNow);
  await page.getByLabel('Your collateral (USD)').fill(fields.collateral ?? '19');
  await expect(page.getByText(/At least \$20\.00, a fifth of the starting price\. Covers 19% of the starting price\./)).toBeVisible();
  // A refused listing keeps everything typed.
  await create.click();
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('Collateral must be at least $20.00, a fifth of the starting price');
  await expect(page.getByLabel('Title')).toHaveValue(fields.title);
  await page.getByLabel('Your collateral (USD)').fill('90');
  await Promise.all([page.waitForURL(/\/auctions\/[0-9a-f-]{36}$/), create.click()]);
  await expect(page.getByRole('heading', { level: 1, name: fields.title })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Lock the collateral' })).toBeVisible();
  await submit(page, page.getByRole('button', { name: 'Lock $90.00 (sandbox)' }));
  await expect(page.getByRole('status')).toContainText('Collateral of $90.00 locked (sandbox).');
  return new URL(page.url()).pathname;
}

test('a resale item bought now: paid into escrow, delivered with proof, confirmed, and the seller is paid with the collateral back', async ({ page, browser }) => {
  const title = `Nebula GTD resale ${uniqueSuffix()}`;
  await login(page, 'creator_c');
  // A creator account resells; selling as the project needs a project account.
  await visit(page, '/auctions/new');
  await expect(page.getByRole('radio', { name: /I’m the project/ })).toBeDisabled();
  const path = await listItem(page, { title, type: 'GTD mint', buyNow: '450', pictures: 2 });
  // The pictures show on the listing, the first as the cover.
  const gallery = page.getByRole('group', { name: 'Pictures' });
  await expect(gallery.getByRole('button')).toHaveCount(2);
  await expect(page.getByRole('img', { name: `${title}, picture 1 of 2` })).toHaveAttribute('src', /^\/api\/item-images\/[0-9a-f-]{36}$/);
  await waitForHydration(gallery.getByRole('button', { name: 'Show picture 2' }));
  await gallery.getByRole('button', { name: 'Show picture 2' }).click();
  await expect(page.getByRole('img', { name: `${title}, picture 2 of 2` })).toBeVisible();

  const buyerContext = await browser.newContext({ baseURL });
  try {
    const buyer = await buyerContext.newPage();
    await login(buyer, 'buyer_a');
    await visit(buyer, '/auctions?type=GTD%20mint');
    const card = buyer.locator('.item-card').filter({ hasText: title });
    await expect(card).toContainText('Resale');
    const cover = card.locator('img').first();
    await expect(cover).toHaveAttribute('src', /^\/api\/item-images\/[0-9a-f-]{36}$/);
    expect((await buyer.request.get((await cover.getAttribute('src'))!)).status()).toBe(200);
    await expect(card).toContainText('Collateral $90.00');
    await expect(card).toContainText('Buy now $450.00');
    await visit(buyer, path);
    const panel = buyer.getByRole('complementary', { name: 'Price and actions' });
    await expect(panel).toContainText('Seller collateral $90.00, 90% of the starting price.');
    await submit(buyer, panel.getByRole('button', { name: 'Buy now for $450.00' }));
    await expect(buyer.getByRole('status')).toContainText('Bought for $450.00. Pay into escrow within 24 hours.');
    await buyer.getByLabel('Your EVM wallet address').fill('0x8ba1f109551bD432803012645Ac136ddd64DBA72');
    await submit(buyer, buyer.getByRole('button', { name: 'Pay $450.00 into escrow (sandbox)' }));
    await expect(buyer.getByRole('status')).toContainText('$450.00 held in escrow (sandbox).');

    await visit(page, path);
    const sellerPanel = page.getByRole('complementary', { name: 'Price and actions' });
    await expect(sellerPanel).toContainText('0x8ba1f109551bD432803012645Ac136ddd64DBA72');
    await page.getByLabel('Proof of delivery').fill('Wallet submitted to the GTD form; team confirmation ref NP-2231.');
    await submit(page, sellerPanel.getByRole('button', { name: 'Mark as delivered' }));
    await expect(page.getByRole('status')).toContainText('Marked as delivered.');

    // Nobody else sees the wallet or the proof.
    const visitorContext = await browser.newContext({ baseURL });
    const visitor = await visitorContext.newPage();
    await visit(visitor, path);
    await expect(visitor.getByText('0x8ba1f109551bD432803012645Ac136ddd64DBA72')).toHaveCount(0);
    await expect(visitor.getByText(/NP-2231/)).toHaveCount(0);
    await visitorContext.close();

    await visit(buyer, path);
    await expect(buyer.getByText('Wallet submitted to the GTD form; team confirmation ref NP-2231.')).toBeVisible();
    await submit(buyer, buyer.getByRole('button', { name: 'I received it' }));
    await expect(buyer.getByRole('status')).toContainText('Confirmed. The seller is paid and gets the collateral back.');
    await expect(buyer.getByRole('complementary', { name: 'Price and actions' })).toContainText('The seller received $450.00 and the $90.00 collateral back.');
  } finally {
    await buyerContext.close();
  }
});

test('a project lists its own WL spot; bids must beat the last by the increment and bidders stay anonymous', async ({ page, browser }) => {
  const title = `Nebula WL from the team ${uniqueSuffix()}`;
  await login(page, 'buyer_b');
  const path = await listItem(page, { title, type: 'WL spot', origin: 'project', buyNow: '300' });
  await visit(page, '/auctions?origin=PROJECT');
  const card = page.locator('.item-card').filter({ hasText: title });
  await expect(card).toContainText('Sold by the project');
  // Without pictures the card draws the kind of item instead: a ticket for a WL spot.
  await expect(card.locator('[data-kind="ticket"]')).toBeVisible();

  const bidderContext = await browser.newContext({ baseURL });
  try {
    const bidder = await bidderContext.newPage();
    await login(bidder, 'creator_d');
    await visit(bidder, path);
    const gavel = bidder.getByRole('button', { name: 'Place bid' });
    await waitForHydration(gavel);
    await bidder.getByLabel(/^Your bid/).fill('100');
    await gavel.click();
    // The gavel strikes while the bid is sent, and the answer shows in place.
    await expect(gavel.locator('svg g').first()).toHaveCSS('animation-name', /strike/);
    await expect(bidder.getByRole('main').getByRole('status')).toContainText('Bid of $100.00 placed. You are the highest bidder.');
    await expect(bidder.getByRole('button', { name: /^Buy now/ })).toHaveCount(0);

    await login(page, 'buyer_a');
    await visit(page, path);
    // The field already refuses less than the next minimum; the server enforces the same rule.
    const amount = page.getByLabel(/^Your bid \(USD, at least \$110\.00\)/);
    await amount.fill('105');
    expect(await amount.evaluate((input: HTMLInputElement) => input.validity.rangeUnderflow)).toBe(true);
    await amount.fill('110');
    await waitForHydration(page.getByRole('button', { name: 'Place bid' }));
    await page.getByRole('button', { name: 'Place bid' }).click();
    await expect(page.getByRole('main').getByRole('status')).toContainText('Bid of $110.00 placed.');

    await visit(bidder, path);
    const history = bidder.getByRole('region', { name: 'Bid history' });
    await expect(history.getByRole('listitem')).toHaveCount(2);
    await expect(history.getByRole('listitem').first()).toContainText('$110.00');
    await expect(history.getByRole('listitem').first()).toContainText('Bidder 2');
    await expect(history.getByRole('listitem').nth(1)).toContainText('You');
    await expect(bidder.getByRole('complementary', { name: 'Price and actions' })).toContainText('$110.00');
    await expect(bidder.getByLabel(/^Your bid \(USD, at least \$120\.00\)/)).toHaveValue('120.00');
  } finally {
    await bidderContext.close();
  }
});

test('the retired creator auction form leads to the item listing form', async ({ page }) => {
  await login(page, 'creator_c');
  await visit(page, '/creator/auctions/new');
  await expect(page).toHaveURL(/\/auctions\/new$/);
  await expect(page.getByRole('heading', { level: 1, name: 'List an item' })).toBeVisible();
});
