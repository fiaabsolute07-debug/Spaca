import { expect, test, type Page } from '@playwright/test';
import { baselineFor, postViews } from '../../src/modules/publish/metrics';
import { chooseOption, dateTimeLocal, flagCard, freeLinkedAccountSlot, login, payOrder, runJobs, setFlag, submit, uniqueSuffix, visit } from './helpers';

/** A handle the mock metrics treat as having enough recent posts for a priced bonus. X handles hold 15 characters. */
function eligibleHandle(): string {
  for (let attempt = 0; attempt < 200; attempt++) {
    const handle = `perf${uniqueSuffix().replace(/\D/g, '').slice(-8)}${attempt}`;
    if (baselineFor({ handle, accountId: handle }).eligible) return handle;
  }
  throw new Error('no eligible handle');
}

/** A post whose mock metrics look earned, so the checkpoint prices it instead of holding it for review. */
function quietPostUrl(handle: string): string {
  const baselineMedian = baselineFor({ handle, accountId: handle }).median_views;
  for (let n = 1; n < 2000; n++) {
    const url = `https://x.com/${handle}/status/${1834567890000 + n}`;
    if (postViews({ postUrl: url, baselineMedian }).signals.length === 0) return url;
  }
  throw new Error('no quiet post url');
}

/**
 * The X account the creator posts from. This suite runs against the shared dev database, where an account linked by an
 * earlier run is still there and the platform allows only ten, so an eligible one is reused before a new one is linked.
 */
async function eligibleXAccount(page: Page): Promise<string> {
  await visit(page, '/settings/profile');
  const accounts = page.getByRole('region', { name: 'Linked accounts' });
  for (const link of await accounts.getByRole('link').all()) {
    const href = (await link.getAttribute('href')) ?? '';
    const handle = (await link.innerText()).trim().replace(/^@/, '');
    if (!/^https:\/\/(x|twitter)\.com\//.test(href) || !handle) continue;
    if (baselineFor({ handle, accountId: handle }).eligible) return handle;
  }
  const handle = eligibleHandle();
  await freeLinkedAccountSlot(page);
  await accounts.getByLabel('Handle or link').fill(`https://twitter.com/${handle}`);
  await submit(page, accounts.getByRole('button', { name: 'Link account', exact: true }));
  await expect(accounts.getByRole('link', { name: `@${handle}`, exact: true })).toBeVisible();
  return handle;
}

test('a performance campaign pays a fixed fee plus a measured bonus, and returns the unused hold', async ({ page }) => {
  const reason = `Performance campaign browser test ${uniqueSuffix()}`;
  const wasEnabled = await flagCard(page, 'PERFORMANCE_CAMPAIGNS_ENABLED').then((card) => card.getByText('Enabled', { exact: true }).isVisible());
  if (!wasEnabled) await setFlag(page, 'PERFORMANCE_CAMPAIGNS_ENABLED', true, reason);
  try {
    // The creator posts from their own account, and its recent median sets the view cap.
    await login(page, 'creator_d');
    const handle = await eligibleXAccount(page);
    // Manual QA on the shared dev database may have paused this creator's orders.
    await visit(page, '/creator/services');
    const resume = page.getByRole('button', { name: 'Resume new orders', exact: true });
    if (await resume.isVisible()) await submit(page, resume);

    const title = `E2E performance campaign ${uniqueSuffix()}`;
    await login(page, 'buyer_a');
    await visit(page, '/buyer/requests/new');
    await page.getByRole('group', { name: 'What is the campaign for?' }).getByRole('radio', { name: /^Launch/ }).check();
    await page.getByRole('group', { name: 'How you pay' }).getByRole('radio', { name: /view bonus/ }).check();
    await expect(page.getByText(/You pay at most \$100\.00 per creator/)).toBeVisible();
    await page.getByLabel('Brief title', { exact: true }).fill(title);
    await page.getByLabel('Brief', { exact: true }).fill(`Post your own testnet walkthrough for ${title}, with the disclosure and our docs link.`);
    await page.getByLabel('Total budget (USD, optional if you set a cap)', { exact: true }).fill('500');
    await page.getByLabel('Creators needed', { exact: true }).fill('1');
    await page.getByLabel('Delivery deadline', { exact: true }).fill(dateTimeLocal(new Date(Date.now() + 14 * 86400_000)));
    await submit(page, page.getByRole('button', { name: 'Publish brief', exact: true }));

    const campaign = new URL(page.url()).pathname;
    const fact = (label: string) => page.getByRole('listitem').filter({ hasText: new RegExp(`^${label}`) });
    await expect(fact('Paid per post')).toContainText('$20.00');
    await expect(fact('Most per creator')).toContainText('$100.00');
    await expect(fact('Views that can be paid')).toContainText("3× the creator's recent median");

    // The creator applies at the fixed fee, naming the account they will post from.
    await login(page, 'creator_d');
    await visit(page, campaign);
    await page.getByLabel('Your quote (USD)', { exact: true }).fill('20');
    await page.getByLabel('Delivery time (hours)', { exact: true }).fill('48');
    await chooseOption(page, page, 'Account you will post on (X)', `@${handle}`);
    await page.getByLabel('Your approach and relevant samples', { exact: true }).fill(`Application ${uniqueSuffix()}: a walkthrough thread for builders, in my own words.`);
    await submit(page, page.getByRole('button', { name: 'Send application', exact: true }));

    await login(page, 'buyer_a');
    await visit(page, campaign);
    await submit(page, page.getByRole('button', { name: 'Offer $20.00 to this creator', exact: true }));
    await login(page, 'creator_d');
    await visit(page, campaign);
    await submit(page, page.getByRole('button', { name: 'Accept offer', exact: true }));
    const order = new URL(page.url()).pathname;
    const orderId = order.split('/').pop()!;

    await login(page, 'buyer_a');
    await visit(page, order);
    // The hold is the maximum the campaign can be charged: the fixed fee plus the whole bonus cap.
    const bonus = page.getByRole('region', { name: 'View bonus' });
    await expect(bonus.getByRole('listitem').filter({ hasText: /^Held for this hire/ })).toContainText('$100.00');
    await expect(bonus.getByText('Waiting for the checkpoint', { exact: true })).toBeVisible();
    await payOrder(page);

    await login(page, 'creator_d');
    await visit(page, order);
    await submit(page, page.getByRole('button', { name: 'Start work', exact: true }));
    await page.getByLabel(/^Link to the post on/).fill(quietPostUrl(handle));
    await page.getByLabel('When it went live', { exact: true }).fill(dateTimeLocal(new Date()));
    await page.getByRole('checkbox', { name: /written in my own words/ }).check();
    await submit(page, page.getByRole('button', { name: 'Submit the published post', exact: true }));

    await login(page, 'buyer_a');
    await visit(page, order);
    await submit(page, page.getByRole('button', { name: 'Approve version 1', exact: true }));

    // Approval alone does not pay: the post is counted first, at its checkpoint.
    await runJobs(page);
    await visit(page, order);
    await expect(bonus.getByText('Waiting for the checkpoint', { exact: true })).toBeVisible();

    const bringForward = async () => {
      const response = await page.request.post('/api/dev/performance-checkpoint', { data: { order_id: orderId } });
      expect(response.status(), await response.text()).toBe(200);
    };
    await bringForward();
    await runJobs(page);
    await visit(page, order);
    await expect(bonus.getByText('Counted, in the checking period', { exact: true })).toBeVisible();
    await expect(bonus.getByRole('listitem').filter({ hasText: /^Views counted/ })).toBeVisible();

    await bringForward();
    await runJobs(page);
    await visit(page, order);
    await expect(bonus.getByText('Bonus final', { exact: true })).toBeVisible();
    await expect(bonus.getByRole('listitem').filter({ hasText: /^Returned to the buyer/ })).toBeVisible();
  } finally {
    if (!wasEnabled) await setFlag(page, 'PERFORMANCE_CAMPAIGNS_ENABLED', false, reason);
  }
});
