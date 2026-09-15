import { expect, test } from '@playwright/test';
import { dateTimeLocal, login, submit, uniqueSuffix, visit, waitForHydration } from './helpers';

// A valid 1×1 PNG: it passes the upload signature check and renders in the browser.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('a buyer picks the campaign type from cards, adds a project image, and creators see it on the campaign', async ({ page }) => {
  const title = `E2E visual brief ${uniqueSuffix()}`;
  const imageName = `${title}, image 1 of 1`;
  await login(page, 'buyer_a');
  await visit(page, '/buyer/requests/new');

  // Posting terms appear only once the buyer picks Publish.
  await expect(page.getByRole('group', { name: 'Post format' })).toBeHidden();
  await page.getByRole('group', { name: 'What do you need?' }).getByRole('radio', { name: /^Publish/ }).check();
  await expect(page.getByRole('group', { name: 'Platform' }).getByRole('radio', { name: 'X', exact: true })).toBeChecked();
  await page.getByRole('group', { name: 'Post format' }).getByRole('radio', { name: 'Thread', exact: true }).check();

  await page.getByLabel('Brief title', { exact: true }).fill(title);
  await page.getByLabel('Brief', { exact: true }).fill(`Two disclosed launch threads for ${title}, covering the product, audience and CTA.`);
  const fileInput = page.locator('input[type="file"]');
  await waitForHydration(fileInput);
  await fileInput.setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByText('Ready', { exact: true })).toBeVisible();
  await page.getByLabel('Total budget (USD, optional if you set a cap)', { exact: true }).fill('600');
  await page.getByLabel('Creators needed', { exact: true }).fill('2');
  await page.getByLabel('Delivery deadline', { exact: true }).fill(dateTimeLocal(new Date(Date.now() + 14 * 86400_000)));
  await submit(page, page.getByRole('button', { name: 'Publish brief', exact: true }));

  const requestPath = new URL(page.url()).pathname;
  expect(requestPath).toMatch(/^\/requests\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('listitem').filter({ hasText: /^Creators post on/ })).toContainText('X · thread');
  const image = page.getByRole('img', { name: imageName, exact: true });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await expect(page.getByRole('button', { name: 'Replace images', exact: true })).toBeVisible();

  await login(page, 'creator_c');
  await visit(page, '/requests');
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Campaigns', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('navigation', { name: 'Marketplace sections' })).toHaveCount(0);
  const card = page.getByRole('link', { name: new RegExp(title) });
  await expect(card.locator('img')).toHaveCount(1);
  await Promise.all([page.waitForURL(new RegExp(`${requestPath}$`)), card.click()]);
  await expect(page.getByRole('img', { name: imageName, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Replace images', exact: true })).toHaveCount(0);
  expect(page.context().pages()).toHaveLength(1);
});
