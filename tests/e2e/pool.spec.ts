import { expect, test, type Page } from '@playwright/test';
import { chooseOption, dateTimeLocal, login, submit, uniqueSuffix, visit } from './helpers';

/** The operator card for one feature flag, on the flags page. */
async function flagCard(page: Page, key: string) {
  await login(page, 'admin');
  await visit(page, '/admin/flags');
  return page.locator('section.panel').filter({ has: page.getByRole('heading', { name: key, exact: true }) });
}

async function setFlag(page: Page, key: string, enabled: boolean) {
  const card = await flagCard(page, key);
  await chooseOption(page, card, 'Enabled (admin only)', enabled ? 'true' : 'false');
  await card.getByLabel(/Reason for the audit log/).fill(`Campaign pool browser test ${uniqueSuffix()}`);
  await submit(page, card.getByRole('button', { name: 'Save flag', exact: true }));
}

test('a buyer backs a campaign with a reward pool, gets a deposit reference, and creators see only the rewards', async ({ page }) => {
  const title = `E2E pool campaign ${uniqueSuffix()}`;
  const wasEnabled = await (await flagCard(page, 'CRYPTO_CHECKOUT_ENABLED')).getByText('Enabled', { exact: true }).isVisible();
  if (!wasEnabled) await setFlag(page, 'CRYPTO_CHECKOUT_ENABLED', true);
  try {
    await login(page, 'buyer_a');
    await visit(page, '/buyer/requests/new');
    await page.getByRole('group', { name: 'What do you need?' }).getByRole('radio', { name: /^Create/ }).check();
    await page.getByLabel('Brief title', { exact: true }).fill(title);
    await page.getByLabel('Brief', { exact: true }).fill(`Launch threads for ${title}, paid from a funded reward pool.`);
    await page.getByLabel('Total budget (USD, optional if you set a cap)', { exact: true }).fill('500');
    await page.getByLabel('Creators needed', { exact: true }).fill('2');
    await page.getByLabel('Delivery deadline', { exact: true }).fill(dateTimeLocal(new Date(Date.now() + 14 * 86400_000)));
    await submit(page, page.getByRole('button', { name: 'Publish brief', exact: true }));
    const campaign = new URL(page.url()).pathname;
    expect(campaign).toMatch(/^\/requests\/[0-9a-f-]{36}$/);

    // The pool pays every hire the same amount, so every applicant quotes it.
    const form = page.getByRole('region', { name: 'Reward pool (optional)' });
    await expect(form.getByText(/every applicant quotes the same amount/)).toBeVisible();
    await form.getByLabel('Amount per creator').fill('100');
    await submit(page, form.getByRole('button', { name: 'Create the pool', exact: true }));

    const pool = page.getByRole('region', { name: 'Reward pool' });
    await expect(page.getByRole('status')).toContainText('Campaign pool created');
    await expect(pool.getByText('Waiting for funding', { exact: true })).toBeVisible();
    await expect(pool.getByRole('listitem').filter({ hasText: /^Paid per hire/ })).toContainText('100 USDC');
    // Two hires at 100 each: the whole target must arrive before anyone can be hired.
    await expect(pool.getByText(/Still to deposit: 200(\.00)? USDC/)).toBeVisible();
    await expect(pool.getByRole('heading', { name: 'Balances', exact: true })).toBeVisible();

    const funding = page.locator('form').filter({ has: page.locator('input[name="command"][value="create_pool_funding"]') });
    await funding.getByLabel('Amount to deposit').fill('200');
    await submit(page, funding.getByRole('button', { name: 'Get a deposit reference', exact: true }));
    await expect(page.getByRole('status')).toContainText('Send exactly');
    await expect(pool.getByRole('heading', { name: 'Deposits', exact: true })).toBeVisible();
    // The Badge component humanizes the status, so the row reads "Awaiting deposit".
    await expect(pool.getByRole('row').filter({ hasText: /Awaiting deposit/i })).toHaveCount(1);

    // A creator sees what a hire pays, and nothing about the buyer's balances or deposits.
    await login(page, 'creator_c');
    await visit(page, campaign);
    const creatorView = page.getByRole('region', { name: 'Reward pool' });
    await expect(creatorView.getByRole('listitem').filter({ hasText: /^Paid per hire/ })).toContainText('100 USDC');
    await expect(creatorView.getByRole('heading', { name: 'Balances' })).toHaveCount(0);
    await expect(creatorView.getByRole('heading', { name: 'Deposits' })).toHaveCount(0);
    await expect(creatorView.getByRole('button')).toHaveCount(0);
  } finally {
    if (!wasEnabled) await setFlag(page, 'CRYPTO_CHECKOUT_ENABLED', false);
  }
});
