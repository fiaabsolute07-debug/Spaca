import { expect, test } from '@playwright/test';
import { chooseOption, login, submit, uniqueSuffix, visit, waitForHydration } from './helpers';

const priceOf = (text: string) => Number(text.replace(/[^0-9.]/g, ''));
// 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==', 'base64');

test('explore: filters beside the results; selecting a card shows its details, and closing returns to the filters', async ({ page }) => {
  await visit(page, '/explore');
  const filters = page.getByRole('complementary', { name: 'Filters' });
  await expect(filters).toBeVisible();
  await expect(page.getByRole('list', { name: 'Services' })).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(0);

  await submit(page, filters.getByRole('radio', { name: '$100 – $500' }));
  await expect(page).toHaveURL(/price=100_500/);
  await expect(filters.getByRole('radio', { name: '$100 – $500' })).toHaveAttribute('aria-checked', 'true');
  const chips = page.getByRole('list', { name: 'Active filters' });
  await expect(chips.getByRole('link', { name: 'Remove filter $100 – $500' })).toBeVisible();

  await chooseOption(page, page, 'Sort by', 'Price: low to high');
  await expect(page).toHaveURL(/sort=price_asc/);
  await expect(page).toHaveURL(/price=100_500/);
  const prices = (await page.locator('.explore-card-price').allTextContents()).map(priceOf);
  expect(prices.length).toBeGreaterThan(0);
  for (const price of prices) expect(price >= 100 && price <= 500, `price ${price}`).toBe(true);
  expect([...prices].sort((a, b) => a - b)).toEqual(prices);

  await submit(page, page.getByRole('complementary', { name: 'Filters' }).getByRole('radio', { name: 'Accepting orders' }));
  await expect(page).toHaveURL(/available=1/);
  await expect(chips.getByRole('link', { name: 'Remove filter Accepting orders' })).toBeVisible();

  const cards = page.getByRole('list', { name: 'Services' }).getByRole('link');
  const title = (await cards.first().getByRole('heading').textContent())!.trim();
  await waitForHydration(cards.first());
  await cards.first().click();
  const detail = page.getByRole('article', { name: `Details: ${title}` });
  await expect(detail).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Filters' })).toBeHidden();
  await expect(page).toHaveURL(/selected=/);
  await expect(cards.first()).toHaveAttribute('aria-current', 'true');

  await detail.getByRole('button', { name: 'Close details' }).click();
  await expect(page.getByRole('article')).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Filters' })).toBeVisible();
  await expect(page).not.toHaveURL(/selected=/);

  await submit(page, chips.getByRole('link', { name: 'Clear all' }));
  await expect(page).toHaveURL(/\/explore$/);
});

test('a creator adds a profile photo and headline; the photo shows on the public profile and can be removed', async ({ page }) => {
  const headline = `Launch threads for L2 teams ${uniqueSuffix()}`;
  await login(page, 'creator_d');
  await visit(page, '/settings/profile');
  const details = page.getByRole('region', { name: 'Details' });
  await details.getByLabel('Headline').fill(headline);
  await submit(page, details.getByRole('button', { name: 'Save profile', exact: true }));
  await expect(page.getByRole('status')).toContainText('Profile saved');

  const photo = page.getByRole('region', { name: 'Profile photo' });
  const fileInput = photo.locator('input[type="file"]');
  await waitForHydration(fileInput);
  await fileInput.setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: PNG });
  await expect(photo.getByText('Ready', { exact: true })).toBeVisible();
  await submit(page, photo.getByRole('button', { name: /Save (new )?photo/ }));
  await expect(page.getByRole('status')).toContainText('Profile photo updated');
  const img = photo.locator('img.avatar-photo');
  await expect(img).toBeVisible();
  const src = await img.getAttribute('src');
  expect(src).toMatch(/^\/api\/avatars\/[0-9a-f-]{36}$/);
  const served = await page.request.get(src!);
  expect(served.status()).toBe(200);
  expect(Buffer.from(await served.body())).toEqual(PNG);
  await expect(page.getByRole('region', { name: 'Profile strength' }).getByText('✓ Profile photo')).toBeVisible();

  const profileLink = page.getByRole('link', { name: 'View public profile ›' });
  const publicPath = await profileLink.getAttribute('href');
  await visit(page, publicPath!);
  await expect(page.getByText(headline)).toBeVisible();
  await expect(page.locator(`img[src="${src}"]`).first()).toBeVisible();

  await visit(page, '/settings/profile');
  await submit(page, page.getByRole('region', { name: 'Profile photo' }).getByRole('button', { name: 'Remove photo' }));
  await expect(page.getByRole('status')).toContainText('Profile photo removed');
  expect((await page.request.get(src!)).status()).toBe(404);
});
