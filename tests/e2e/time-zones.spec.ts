import { expect, test } from '@playwright/test';
import { chooseOption, createPublishedService, dateTimeLocal, login, submit, uniqueSuffix, visit } from './helpers';

/**
 * A `datetime-local` field shows a wall clock with no zone attached to it. Read as UTC it would move an auction or a
 * deadline by the reader's whole offset — seven hours, for a creator in Bangkok. These run the browser on a zone that
 * is not UTC and check the instant that comes back out.
 */
/** How the app writes an instant everywhere (`date()` in src/components/ui.tsx): medium date, short time, UTC. */
const shownUtc = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';

test.describe('times are read on the clock the person is looking at', () => {
  test.use({ timezoneId: 'Asia/Bangkok' });

  test('AUC-13b: an auction scheduled at a Bangkok wall clock starts at that Bangkok moment', async ({ page }) => {
    const service = await createPublishedService(page, 'auction-zone');
    // 09:00 tomorrow in Bangkok, written as the wall clock the creator sees and types.
    const tomorrow = new Date(Date.now() + 86_400_000);
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(tomorrow);
    const startsWall = `${day}T09:00`;
    const endsWall = `${day}T21:00`;

    await visit(page, '/creator/auctions/new');
    await chooseOption(page, page, 'Published service', `${service.title} · $100.00`);
    await page.getByLabel('Starting price (USD)', { exact: true }).fill('100');
    await page.getByLabel('Minimum increment (USD)', { exact: true }).fill('10');
    await page.getByLabel('Starts at', { exact: true }).fill(startsWall);
    await page.getByLabel('Ends at', { exact: true }).fill(endsWall);
    // The field says which zone it read and what that is in UTC, so the two never disagree silently.
    await expect(page.getByText(/Asia\/Bangkok \(UTC\+07:00\)/).first()).toBeVisible();
    await submit(page, page.getByRole('button', { name: 'Schedule auction', exact: true }));

    // The page shows every time in UTC, so 09:00 in Bangkok must read as 02:00 UTC — and never as 09:00 UTC.
    await expect(page.getByRole('main')).toContainText(shownUtc(`${day}T02:00:00.000Z`));
    await expect(page.getByRole('main')).not.toContainText(shownUtc(`${day}T09:00:00.000Z`));
  });

  test('a campaign deadline typed in Bangkok closes at that Bangkok moment', async ({ page }) => {
    await login(page, 'buyer_a');
    await visit(page, '/buyer/requests/new');
    const title = `Zone brief ${uniqueSuffix()}`;
    // Both radio groups are required: without a goal the browser refuses the form and nothing is ever posted.
    await page.getByRole('group', { name: 'What is the campaign for?' }).getByRole('radio', { name: /^Launch/ }).check();
    await page.getByRole('group', { name: 'What do you need?' }).getByRole('radio', { name: /^Create/ }).check();
    await page.getByLabel('Brief title', { exact: true }).fill(title);
    await page.getByLabel('Brief', { exact: true }).fill('Three launch videos, audience and references included, for a timezone check.');
    await page.getByLabel('Total budget (USD, optional if you set a cap)', { exact: true }).fill('600');
    await page.getByLabel('Creators needed', { exact: true }).fill('1');
    const inTenDays = new Date(Date.now() + 10 * 86_400_000);
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(inTenDays);
    await page.getByLabel('Delivery deadline', { exact: true }).fill(`${day}T18:00`);
    await submit(page, page.getByRole('button', { name: 'Publish brief', exact: true }));

    // 18:00 in Bangkok is 11:00 UTC, which is what the campaign page shows.
    await expect(page.getByRole('main')).toContainText(shownUtc(`${day}T11:00:00.000Z`));
  });
});

test('without a zone the wall clock is still read as UTC, and the field says so', async ({ page }) => {
  await login(page, 'creator_c');
  await visit(page, '/creator/auctions/new');
  // The browser here runs on UTC (playwright.config.ts), so the hint names UTC and the value is unshifted.
  await page.getByLabel('Starts at', { exact: true }).fill(dateTimeLocal(new Date(Date.now() + 3_600_000)));
  await expect(page.getByText(/\(UTC\+00:00\)/).first()).toBeVisible();
});
