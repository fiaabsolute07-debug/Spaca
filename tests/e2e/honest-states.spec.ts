import { expect, test } from '@playwright/test';
import { baseURL, bookFromExplore, chooseOption, completeSetup, createPublishedService, signUpInDialog, expectNoHorizontalOverflow, expectOrderState, login, submit, uniqueSuffix, visit, waitForHydration, openAccountMenu } from './helpers';

test('FND-04: each account type sees only its own workspace; a legacy dual test account can use both; nobody reaches the admin console', async ({ page }) => {
  await login(page, 'buyer_a');
  await visit(page, '/creator/services');
  await expect(page.getByRole('heading', { level: 1, name: 'This page is for creator accounts' })).toBeVisible();
  const menu = await openAccountMenu(page);
  await expect(menu.getByRole('link', { name: 'My campaigns', exact: true })).toBeVisible();
  await expect(menu.getByRole('link', { name: 'My services', exact: true })).toHaveCount(0);
  expect((await page.goto('/admin'))?.status()).toBe(404);

  await login(page, 'creator_c');
  await visit(page, '/buyer/requests/new');
  await expect(page.getByRole('heading', { level: 1, name: 'This page is for buyer accounts' })).toBeVisible();
  expect((await page.goto('/admin/flags'))?.status()).toBe(404);

  await login(page, 'dual_e');
  await visit(page, '/creator/requests');
  await expect(page.getByRole('heading', { level: 1, name: 'My applications' })).toBeVisible();
  await visit(page, '/buyer/requests');
  await expect(page.getByRole('heading', { level: 1, name: 'My campaigns' })).toBeVisible();
  expect((await page.goto('/admin'))?.status()).toBe(404);
});

test('SUP-02 / REV-03: a brand-new creator shows as new, with no invented rating or completion numbers', async ({ page }) => {
  const suffix = uniqueSuffix();
  const handle = `new${suffix.replace(/\D/g, '').slice(-10)}`;
  const title = `Fresh creator thread ${suffix}`;
  await visit(page, '/explore');
  const start = page.getByRole('banner').getByRole('link', { name: 'Get started', exact: true });
  await waitForHydration(start);
  await start.click();
  await signUpInDialog(page, 'Creator', `fresh-${suffix}@example.test`);
  await completeSetup(page, { name: 'Fresh Creator', handle, headline: 'Launch threads for developer tools', intro: 'Writes launch threads for developer tools and L2 teams; new to spaca.' });

  await visit(page, '/creator/services/new');
  await page.getByLabel('Service title', { exact: true }).fill(title);
  await chooseOption(page, page, 'What are you offering?', 'Create · content you deliver');
  await page.getByLabel('Price (USD)', { exact: true }).fill('90');
  await page.getByLabel('Scope and deliverables').fill(`One launch thread with a clear CTA for ${title}.`);
  await page.getByLabel('Link to work online (optional)', { exact: true }).fill(`${baseURL}/?sample=${suffix}`);
  await page.getByLabel('What that work is', { exact: true }).fill('A previous launch thread');
  await submit(page, page.getByRole('button', { name: 'Save draft service', exact: true }));
  const card = page.locator('div.panel').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  await submit(page, card.getByRole('button', { name: 'Publish', exact: true }));
  await expect(card.getByText('Published', { exact: true })).toBeVisible();

  await visit(page, `/creators/${handle}`);
  await expect(page.getByText('0 completed jobs')).toBeVisible();
  await expect(page.getByText(/ rating$/)).toHaveCount(0);
  await expect(page.getByText(/%/)).toHaveCount(0);

  await visit(page, '/explore');
  const listing = page.getByRole('main').getByRole('link').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  await expect(listing).toContainText('New creator');
  await expect(listing).not.toContainText('★');
});

test('DSC-02: Explore explains an empty search with a way out, and a bad page link falls back to real listings with a notice', async ({ page }) => {
  await visit(page, `/explore?q=${encodeURIComponent('zqxj nothing matches ' + uniqueSuffix())}`);
  await expect(page.getByRole('heading', { name: 'No services match these filters' })).toBeVisible();
  await submit(page, page.getByRole('link', { name: 'Clear all filters' }));
  await expect(page).toHaveURL(/\/explore$/);

  await visit(page, '/explore?sort=price_asc&cursor=not-a-real-cursor');
  await expect(page.getByText(/The page cursor is invalid for this sort; start from the first page Showing the newest services instead\./)).toBeVisible();
  await expect(page.getByRole('main').getByRole('list', { name: 'Services' }).getByRole('listitem').first()).toBeVisible();
});

test('ORD-02 / PAY-06: a success-looking link never funds an order; the creator is told what work is waiting for', async ({ page }) => {
  const service = await createPublishedService(page, 'redirect');
  const path = await bookFromExplore(page, service.title);
  await visit(page, `${path}?message=${encodeURIComponent('Payment confirmed by the provider. The creator can start work.')}&payment=success&redirect_status=succeeded`);
  await expectOrderState(page, 'AWAITING_PAYMENT');
  await expect(page.getByRole('status')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Pay with local test provider', exact: true })).toBeVisible();

  await login(page, 'creator_c');
  await visit(page, path);
  await expect(page.getByText(/Waiting for the buyer's payment to be confirmed by the payment provider/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start work', exact: true })).toHaveCount(0);
});

test('SEC-07: markup in briefs and messages stays text, and script or data links are refused', async ({ page }) => {
  const service = await createPublishedService(page, 'markup');
  await login(page, 'buyer_a');
  await visit(page, service.path);
  const payload = `<img src=x onerror="window.__spacaXss=1"><script>window.__spacaXss=2</script> Launch brief ${uniqueSuffix()} with audience and CTA.`;
  await page.getByLabel('Tell the creator about your project').fill(payload);
  await page.getByRole('checkbox', { name: /I agree that version/ }).check();
  await submit(page, page.getByRole('button', { name: 'Reserve this service', exact: true }));
  await expect(page.getByText(payload, { exact: true })).toBeVisible();
  await page.getByLabel('Message', { exact: true }).fill('<a href="javascript:window.__spacaXss=3">click</a>');
  await submit(page, page.getByRole('button', { name: 'Send message', exact: true }));
  await expect(page.getByText('<a href="javascript:window.__spacaXss=3">click</a>', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __spacaXss?: number }).__spacaXss ?? null)).toBeNull();
  expect(await page.locator('main a[href^="javascript:"], main img[onerror]').count()).toBe(0);

  await login(page, 'creator_c');
  await visit(page, '/creator/services/new');
  await page.getByLabel('Service title', { exact: true }).fill(`Unsafe sample ${uniqueSuffix()}`);
  await chooseOption(page, page, 'What are you offering?', 'Create · content you deliver');
  await page.getByLabel('Price (USD)', { exact: true }).fill('50');
  await page.getByLabel('Scope and deliverables').fill('A scope long enough to be accepted by the service form rules.');
  await page.getByLabel('Link to work online (optional)', { exact: true }).fill('javascript:alert(document.cookie)');
  await page.getByLabel('What that work is', { exact: true }).fill('Bad sample');
  await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Save draft service', exact: true }).click()]);
  expect(new URL(page.url()).searchParams.has('error')).toBe(true);
  await expect(page.getByRole('main').getByRole('alert')).toBeVisible();
});

test('OPS-07: a buyer can book with the keyboard alone, and a very long title does not break a phone-width page', async ({ page }) => {
  const service = await createPublishedService(page, `keyboard ${'Averyveryverylongunbrokenwordthatkeepsgoing'}`);
  await login(page, 'buyer_a');
  await visit(page, service.path);
  const brief = page.getByLabel('Tell the creator about your project');
  await brief.focus();
  await page.keyboard.type(`Keyboard-only brief ${uniqueSuffix()}: audience, goal and a clear CTA for the launch.`);
  await page.keyboard.press('Tab');
  const consent = page.getByRole('checkbox', { name: /I agree that version/ });
  for (let i = 0; i < 6 && !(await consent.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
  await expect(consent).toBeFocused();
  await page.keyboard.press('Space');
  await expect(consent).toBeChecked();
  const reserve = page.getByRole('button', { name: 'Reserve this service', exact: true });
  for (let i = 0; i < 6 && !(await reserve.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
  await expect(reserve).toBeFocused();
  await Promise.all([page.waitForURL(/\/orders\/[0-9a-f-]{36}/), page.keyboard.press('Enter')]);
  await expectOrderState(page, 'AWAITING_PAYMENT');

  await page.setViewportSize({ width: 360, height: 780 });
  for (const path of [service.path, new URL(page.url()).pathname, '/explore']) {
    await visit(page, path);
    await expectNoHorizontalOverflow(page);
  }
});

test('SUP-03: a creator edits a live service; a buyer who agreed to the old version must review the new terms, and the order records what was sold', async ({ page, browser }) => {
  const service = await createPublishedService(page, 'terms-change');
  const buyerContext = await browser.newContext({ baseURL });
  try {
    const buyer = await buyerContext.newPage();
    await login(buyer, 'buyer_a');
    await visit(buyer, service.path);
    await buyer.getByLabel('Tell the creator about your project').fill(`Terms change brief ${uniqueSuffix()}: audience, goal and a clear CTA.`);
    await buyer.getByRole('checkbox', { name: /I agree that version 1 of these terms applies/ }).check();

    // Meanwhile the creator raises the price.
    await visit(page, '/creator/services');
    const card = page.locator('div.panel').filter({ has: page.getByRole('heading', { name: service.title, exact: true }) });
    await card.getByText('Edit service', { exact: true }).click();
    await card.getByLabel('Price (USD)').fill('180');
    await submit(page, card.getByRole('button', { name: 'Save changes', exact: true }));
    await expect(page.getByRole('status')).toContainText('New checkouts use the new terms');

    // The buyer's page still shows version 1; submitting it is refused and the new terms are shown.
    await Promise.all([buyer.waitForNavigation(), buyer.getByRole('button', { name: 'Reserve this service', exact: true }).click()]);
    await expect(buyer.getByRole('main').getByRole('alert')).toContainText('The creator updated this service. Review the new price and scope before booking.');
    await expect(buyer.getByRole('checkbox', { name: /I agree that version 2 of these terms applies/ })).toBeVisible();
    await expect(buyer.getByRole('main')).toContainText('$180.00');

    await buyer.getByLabel('Tell the creator about your project').fill(`Terms change brief ${uniqueSuffix()}: audience, goal and a clear CTA.`);
    await buyer.getByRole('checkbox', { name: /I agree that version 2 of these terms applies/ }).check();
    await submit(buyer, buyer.getByRole('button', { name: 'Reserve this service', exact: true }));
    await expectOrderState(buyer, 'AWAITING_PAYMENT');
    await expect(buyer.getByRole('main')).toContainText('$180.00');
  } finally {
    await buyerContext.close();
  }
});

test('DSC-05: a buyer on a stale page cannot book after the creator pauses new orders, and sees why', async ({ page, browser }) => {
  const service = await createPublishedService(page, 'pause-stale');
  const buyerContext = await browser.newContext({ baseURL });
  try {
    const buyer = await buyerContext.newPage();
    await login(buyer, 'buyer_a');
    await visit(buyer, service.path);
    await buyer.getByLabel('Tell the creator about your project').fill(`Stale page brief ${uniqueSuffix()}: audience, goal and a clear CTA.`);
    await buyer.getByRole('checkbox', { name: /I agree that version/ }).check();

    await visit(page, '/creator/services');
    await submit(page, page.getByRole('button', { name: 'Pause new orders', exact: true }));

    await Promise.all([buyer.waitForNavigation(), buyer.getByRole('button', { name: 'Reserve this service', exact: true }).click()]);
    await expect(buyer.getByRole('main').getByRole('alert')).toContainText('This creator paused new orders');
    await expect(buyer).toHaveURL(new RegExp(`${service.path}\\?`));
    await expect(buyer.getByRole('heading', { name: 'Paused', exact: true })).toBeVisible();
    await expect(buyer.getByRole('button', { name: 'Reserve this service', exact: true })).toHaveCount(0);
  } finally {
    await buyerContext.close();
    await login(page, 'creator_c');
    await visit(page, '/creator/services');
    const resume = page.getByRole('button', { name: 'Resume new orders', exact: true });
    if (await resume.isVisible()) await submit(page, resume);
  }
});
