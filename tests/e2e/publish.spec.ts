import { expect, test } from '@playwright/test';
import { chooseOption, expectOrderState, login, orderPath, payOrder, submit, uniqueSuffix, visit } from './helpers';

test('a PUBLISH order is delivered with the post link on the sold X channel and approved by the buyer', async ({ page }) => {
  const suffix = uniqueSuffix();
  const handle = `e2e${suffix.replace(/\D/g, '').slice(-11)}`;
  const title = `E2E sponsored thread ${suffix}`;

  await login(page, 'creator_d');
  await visit(page, '/settings/profile');
  const accounts = page.getByRole('region', { name: 'Linked accounts' });
  await accounts.getByLabel('Handle or link').fill(`https://twitter.com/${handle}`);
  await submit(page, accounts.getByRole('button', { name: 'Link account', exact: true }));
  await expect(accounts.getByRole('link', { name: `@${handle}`, exact: true })).toBeVisible();
  await expect(accounts.getByText('Self-reported').first()).toBeVisible();

  await visit(page, '/creator/services/new');
  await page.getByLabel('Service title', { exact: true }).fill(title);
  await chooseOption(page, page, 'What are you offering?', 'Publish · a post on your channel');
  await page.getByLabel('Price (USD)', { exact: true }).fill('150');
  await page.getByLabel('Delivery time (hours)').fill('48');
  await page.getByLabel('Scope and deliverables').fill(`One disclosed thread on my X account explaining your launch (${suffix}).`);
  await chooseOption(page, page, 'Posting account', `@${handle} · X`);
  await chooseOption(page, page, 'Post format', 'Thread');
  await page.getByLabel('Sample URL 1', { exact: true }).fill(`https://x.com/${handle}/status/1000000000001`);
  await page.getByLabel('Sample title 1', { exact: true }).fill('A past launch thread');
  await submit(page, page.getByRole('button', { name: 'Save draft service', exact: true }));
  const card = page.locator('div.panel').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  await submit(page, card.getByRole('button', { name: 'Publish', exact: true }));
  await expect(card.getByText('Published', { exact: true })).toBeVisible();
  const servicePath = await card.getByRole('link', { name: 'Open public page ›', exact: true }).getAttribute('href');

  await login(page, 'buyer_a');
  await visit(page, servicePath!);
  await expect(page.getByRole('link', { name: `@${handle}`, exact: true })).toBeVisible();
  await expect(page.getByText(/labelled “#ad”, and keeps it live for at least 72 hours/)).toBeVisible();
  await page.getByLabel('Tell the creator about your project').fill('Explain our testnet in your own words for builders and link the docs.');
  await page.getByRole('checkbox', { name: /The post is labelled “#ad”/ }).check();
  await page.getByRole('checkbox', { name: /I agree that version/ }).check();
  await submit(page, page.getByRole('button', { name: 'Reserve this service', exact: true }));
  const path = orderPath(page);
  await payOrder(page);

  await login(page, 'creator_d');
  await visit(page, path);
  await submit(page, page.getByRole('button', { name: 'Start work', exact: true }));
  await expectOrderState(page, 'IN_PROGRESS');
  await page.getByLabel(`Link to the post on @${handle} on X`).fill(`https://x.com/${handle}/status/1834567890123`);
  await page.getByLabel('When it went live (UTC)').fill(new Date().toISOString().slice(0, 16));
  await page.getByRole('checkbox', { name: /The post shows “#ad”/ }).check();
  await submit(page, page.getByRole('button', { name: 'Submit the published post', exact: true }));
  await expectOrderState(page, 'DELIVERED');

  await login(page, 'buyer_a');
  await visit(page, path);
  await expect(page.getByText(`Link matches @${handle} on X`)).toBeVisible();
  await expect(page.getByText('“#ad” confirmed by the creator')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open post ›' })).toHaveAttribute('href', `https://x.com/${handle}/status/1834567890123`);
  await submit(page, page.getByRole('button', { name: /^Approve/ }).first());
  await expectOrderState(page, 'APPROVED');
});
