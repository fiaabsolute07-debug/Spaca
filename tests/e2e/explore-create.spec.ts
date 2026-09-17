import { expect, test } from '@playwright/test';
import { chooseServiceType, login, submit, uniqueSuffix, visit, waitForHydration } from './helpers';

test('a creator creates a service from Explore in a dialog, without leaving the page until it is saved', async ({ page }) => {
  await login(page, 'creator_d');
  await visit(page, '/explore');
  const create = page.getByRole('main').getByRole('link', { name: 'Create a service', exact: true });
  await waitForHydration(create);

  // It opens over Explore with the page's own address; Escape returns to Explore.
  await create.click();
  const dialog = page.getByRole('dialog', { name: 'Create a service' });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/\/creator\/services\/new$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Find creators for your launch.' })).toBeAttached();
  // The first question is what kind of service; only the chosen kind's terms are shown.
  await expect(dialog.getByRole('radio', { name: /^Create\b/ })).toBeFocused();
  await expect(dialog.getByText('Posting account', { exact: true })).toBeHidden();
  await dialog.getByRole('radio', { name: /^Publish\b/ }).check();
  await expect(dialog.getByText('Posting account', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Session length', { exact: true })).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/explore$/);

  // Saving the draft goes to My services, where the new draft is the first card.
  await create.click();
  await expect(dialog).toBeVisible();
  const title = `E2E explore-create ${uniqueSuffix()}`;
  await dialog.getByLabel('Service title', { exact: true }).fill(title);
  await chooseServiceType(dialog, 'Create');
  await dialog.getByLabel('Price (USD)', { exact: true }).fill('120');
  await dialog.getByLabel('Delivery time (hours)').fill('48');
  await dialog.getByLabel('Scope and deliverables').fill(`One launch thread with a revision, made from Explore (${title}).`);
  await dialog.getByLabel('Link to work online (optional)', { exact: true }).fill('https://example.com/launch-thread');
  await dialog.getByLabel('What that work is', { exact: true }).fill('Launch thread');
  await submit(page, dialog.getByRole('button', { name: 'Save draft service', exact: true }));
  await expect(page).toHaveURL(/\/creator\/services/);
  const first = page.locator('.service-row').first();
  await expect(first.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(first.getByText('Draft', { exact: true })).toBeVisible();
});

test('opening the address directly shows the full page, and only creator accounts get the button', async ({ page }) => {
  await login(page, 'creator_d');
  await visit(page, '/creator/services/new');
  await expect(page.getByRole('heading', { level: 1, name: 'Offer a clear next step.' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // The work counts on My services open the overview's action list, not the orders page.
  await visit(page, '/creator/services');
  const stages = page.getByRole('list', { name: 'Work in progress' }).getByRole('link');
  expect(await stages.count()).toBeGreaterThan(0);
  for (const href of await stages.evaluateAll((links) => links.map((link) => link.getAttribute('href')))) expect(href).toBe('/dashboard#overview-actions');

  await login(page, 'buyer_a');
  await visit(page, '/explore');
  await expect(page.getByRole('heading', { level: 1, name: 'Find creators for your launch.' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create a service', exact: true })).toHaveCount(0);
});
