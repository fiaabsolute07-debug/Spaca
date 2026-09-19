import { expect, test } from '@playwright/test';
import { dateTimeLocal, login, nextFormStep, submit, uniqueSuffix, visit, waitForHydration } from './helpers';

test('a buyer posts a brief in a dialog over the campaign board, without leaving the list until it is published', async ({ page }) => {
  await login(page, 'buyer_a');
  await visit(page, '/requests');
  const post = page.getByRole('main').getByRole('link', { name: 'Post a brief', exact: true });
  await waitForHydration(post);

  // It opens over the board with the page's own address; Escape returns to the board.
  await post.click();
  const dialog = page.getByRole('dialog', { name: 'Post a brief' });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/\/buyer\/requests\/new$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Bring your next project to life.' })).toBeAttached();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/requests$/);

  // The three steps are asked in order, and the brief is only published from the last one.
  await post.click();
  await expect(dialog).toBeVisible();
  const title = `E2E dialog brief ${uniqueSuffix()}`;
  const publish = dialog.getByRole('button', { name: 'Publish brief', exact: true });
  await expect(publish).toBeHidden();
  await dialog.getByRole('group', { name: 'What is the campaign for?' }).getByRole('radio', { name: /^Education/ }).check();
  await nextFormStep(page);
  await dialog.getByLabel('Brief title', { exact: true }).fill(title);
  await dialog.getByLabel('Brief', { exact: true }).fill(`Two explainers for our docs, written from the campaign board (${title}).`);
  await nextFormStep(page);
  await expect(publish).toBeVisible();
  await dialog.getByLabel('Total budget (USD, optional if you set a cap)', { exact: true }).fill('300');
  await dialog.getByLabel('Creators needed', { exact: true }).fill('1');
  await dialog.getByLabel('Delivery deadline', { exact: true }).fill(dateTimeLocal(new Date(Date.now() + 14 * 86400_000)));
  await submit(page, publish);

  expect(new URL(page.url()).pathname).toMatch(/^\/requests\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
});

test('opening the brief address directly shows the full page', async ({ page }) => {
  await login(page, 'buyer_a');
  await visit(page, '/buyer/requests/new');
  await expect(page.getByRole('heading', { level: 1, name: 'Share the project behind the ask.' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('a seller lists an item in a dialog over the auction board, in three steps', async ({ page }) => {
  await login(page, 'creator_c');
  await visit(page, '/auctions');
  const list = page.getByRole('main').getByRole('link', { name: /^List an item/ }).first();
  await waitForHydration(list);

  await list.click();
  const dialog = page.getByRole('dialog', { name: 'List an item' });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/\/auctions\/new$/);
  // The auction terms wait behind two steps; the create button belongs to the last one.
  const create = dialog.getByRole('button', { name: 'Create listing', exact: true });
  await expect(create).toBeHidden();
  await expect(dialog.getByLabel('Starting price (USD)')).toBeHidden();

  const title = `E2E dialog listing ${uniqueSuffix()}`;
  await dialog.getByLabel('Title', { exact: true }).fill(title);
  await nextFormStep(page);
  await nextFormStep(page);
  await expect(create).toBeVisible();
  await dialog.getByLabel('Starting price (USD)').fill('100');
  await create.click();

  await page.waitForURL(/\/auctions\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
});

test('opening the listing address directly shows the full page', async ({ page }) => {
  await login(page, 'creator_c');
  await visit(page, '/auctions/new');
  await expect(page.getByRole('heading', { level: 1, name: 'List an item' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
