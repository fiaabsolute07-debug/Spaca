import { expect, test } from '@playwright/test';
import { chooseOption, expectNoHorizontalOverflow, expectOrderState, login, orderPath, payOrder, submit, uniqueSuffix, visit } from './helpers';

test('a DIGITAL product is released, bought, delivered on payment and downloaded only by its buyer', async ({ page }) => {
  const suffix = uniqueSuffix();
  const title = `E2E launch template kit ${suffix}`;
  const fileBytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(`e2e template kit ${suffix}`)]);

  await login(page, 'admin');
  await visit(page, '/admin/flags');
  const flag = page.locator('section').filter({ has: page.getByRole('heading', { name: 'DIGITAL_PRODUCTS_ENABLED', exact: true }) });
  await chooseOption(page, flag, 'Enabled (admin only)', 'true');
  await flag.getByLabel('Reason for the audit log (at least 10 characters)', { exact: true }).fill(`E2E ${suffix}: enable DIGITAL sales for the local journey.`);
  await submit(page, flag.getByRole('button', { name: 'Save flag', exact: true }));

  await login(page, 'creator_d');
  await visit(page, '/creator/services/new');
  await page.getByLabel('Service title', { exact: true }).fill(title);
  await chooseOption(page, page, 'What are you offering?', 'Digital · ready-made files');
  await page.getByLabel('Price (USD)', { exact: true }).fill('35');
  await page.getByLabel('Delivery time (hours)').fill('1');
  await page.getByLabel('Scope and deliverables').fill(`Notion and Figma templates for a token launch week (${suffix}).`);
  await page.getByLabel('Downloads per purchase').fill('3');
  await page.getByLabel('What buyers may do with the files').fill('Use in your own and client launches. Do not resell or share the files.');
  await page.getByLabel('Sample URL 1', { exact: true }).fill('https://example.com/kit-preview');
  await page.getByLabel('Sample title 1', { exact: true }).fill('Kit preview');
  await submit(page, page.getByRole('button', { name: 'Save draft service', exact: true }));

  const card = page.locator('div.panel').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  await expect(card.getByText('Upload the product file before publishing.')).toBeVisible();
  await card.locator('input[type="file"]').setInputFiles({ name: 'launch-kit.zip', mimeType: 'application/zip', buffer: fileBytes });
  await expect(card.getByText('Ready', { exact: true })).toBeVisible();
  await submit(page, card.getByRole('button', { name: 'Add product file', exact: true }));
  await expect(card.getByText('Version 1 · launch-kit.zip')).toBeVisible();
  await submit(page, card.getByRole('button', { name: 'Publish', exact: true }));
  await expect(card.getByText('Published', { exact: true })).toBeVisible();
  const servicePath = await card.getByRole('link', { name: 'Open public page ›', exact: true }).getAttribute('href');

  await login(page, 'buyer_a');
  await visit(page, servicePath!);
  await expect(page.getByText('Use in your own and client launches. Do not resell or share the files.')).toBeVisible();
  await expect(page.getByLabel('Tell the creator about your project')).toHaveCount(0);
  await page.getByRole('checkbox', { name: /I accept the license above for version 1/ }).check();
  await submit(page, page.getByRole('button', { name: 'Buy license', exact: true }));
  const path = orderPath(page);
  await payOrder(page);
  await expectOrderState(page, 'DELIVERED');

  const files = page.getByRole('heading', { name: 'Files for this purchase', exact: true }).locator('..');
  await expect(files).toContainText('0 of 3 used');
  await expect(page.getByRole('button', { name: 'Cancel before downloading', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Request included revision/ })).toHaveCount(0);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    files.getByRole('button', { name: 'Download version 1', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('launch-kit.zip');
  const saved = await download.path();
  expect(saved).toBeTruthy();
  await visit(page, path);
  await expect(files).toContainText('1 of 3 used');
  await expect(page.getByRole('button', { name: 'Cancel before downloading', exact: true })).toHaveCount(0);

  // Another buyer cannot open the purchase, so never sees its files.
  await login(page, 'buyer_b');
  const response = await page.goto(path);
  expect(response?.status()).toBe(404);

  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'buyer_a');
  await visit(page, path);
  await expectNoHorizontalOverflow(page);
});
