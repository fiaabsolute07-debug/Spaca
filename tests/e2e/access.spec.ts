import { expect, test } from '@playwright/test';
import { chooseOption, expectNoHorizontalOverflow, expectOrderState, login, orderPath, payOrder, submit, uniqueSuffix, visit } from './helpers';

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

test('an ACCESS session is booked from the creator’s availability, paid, and gets a private meeting link', async ({ page }) => {
  const suffix = uniqueSuffix();
  const title = `E2E strategy call ${suffix}`;

  await login(page, 'admin');
  await visit(page, '/admin/flags');
  const flag = page.locator('section').filter({ has: page.getByRole('heading', { name: 'ACCESS_BOOKING_ENABLED', exact: true }) });
  await chooseOption(page, flag, 'Enabled (admin only)', 'true');
  await flag.getByLabel('Reason for the audit log (at least 10 characters)', { exact: true }).fill(`E2E ${suffix}: enable ACCESS bookings for the local journey.`);
  await submit(page, flag.getByRole('button', { name: 'Save flag', exact: true }));

  await login(page, 'creator_d');
  await visit(page, '/creator/services');
  const limit = page.getByRole('region', { name: 'Order limit' });
  await limit.getByLabel('Orders at a time').fill('100');
  await submit(page, limit.getByRole('button', { name: 'Save limit', exact: true }));
  const availability = page.getByRole('region', { name: 'Session availability' });
  await chooseOption(page, availability, 'Time zone', 'Asia/Ho Chi Minh');
  for (const day of WEEKDAYS) {
    await availability.getByRole('checkbox', { name: day }).check();
    await availability.getByLabel(`${day} start`).fill('08:00');
    await availability.getByLabel(`${day} end`).fill('22:00');
  }
  await submit(page, availability.getByRole('button', { name: 'Save availability', exact: true }));
  await expect(page.getByRole('status')).toContainText('Availability saved (7 weekly windows, Asia/Ho_Chi_Minh)');

  await visit(page, '/creator/services/new');
  await page.getByLabel('Service title', { exact: true }).fill(title);
  await chooseOption(page, page, 'What are you offering?', 'Access · a live session');
  await page.getByLabel('Price (USD)', { exact: true }).fill('90');
  await page.getByLabel('Delivery time (hours)').fill('24');
  await page.getByLabel('Scope and deliverables').fill(`A 45-minute call reviewing your launch plan and community steps (${suffix}).`);
  await chooseOption(page, page, 'Session length', '45 minutes');
  await page.getByLabel('Sample URL 1', { exact: true }).fill('https://example.com/talk');
  await page.getByLabel('Sample title 1', { exact: true }).fill('Conference talk');
  await submit(page, page.getByRole('button', { name: 'Save draft service', exact: true }));
  const card = page.locator('div.panel').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  await submit(page, card.getByRole('button', { name: 'Publish', exact: true }));
  await expect(card.getByText('Published', { exact: true })).toBeVisible();
  const servicePath = await card.getByRole('link', { name: 'Open public page ›', exact: true }).getAttribute('href');

  await login(page, 'buyer_a');
  await visit(page, servicePath!);
  await expect(page.getByText('A 45-minute live session at a time you pick.', { exact: false })).toBeVisible();
  const picker = page.getByRole('group', { name: 'Pick a 45-minute session' });
  await expect(picker.getByText(/The creator is in Asia\/Ho_Chi_Minh/)).toBeVisible();
  const firstSlot = picker.getByRole('radio').first();
  await expect(firstSlot).toBeVisible();
  await firstSlot.click();
  await expect(firstSlot).toHaveAttribute('aria-checked', 'true');
  await expect(picker.getByText(/^Selected:/)).toBeVisible();
  await page.getByLabel('What do you want to cover?').fill('Review our testnet launch plan and the first community steps.');
  await page.getByRole('checkbox', { name: /I agree that version/ }).check();
  await submit(page, page.getByRole('button', { name: 'Reserve this time', exact: true }));
  const path = orderPath(page);
  const session = page.getByRole('heading', { name: 'Session', exact: true }).locator('..');
  await expect(session).toContainText('Time held until payment is confirmed');
  await payOrder(page);
  await expectOrderState(page, 'FUNDED');
  await expect(session).toContainText('Booked');
  // The earliest slot is 12 hours out, inside the 24-hour notice: the buyer can only request a cancellation now.
  await expect(session).toContainText('The free cancellation period has ended (24 hours before the start)');
  await expect(page.getByRole('button', { name: 'Cancel order', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Request cancellation', exact: true })).toBeVisible();

  await login(page, 'creator_d');
  await visit(page, path);
  await expect(page.getByRole('button', { name: 'Start work', exact: true })).toHaveCount(0);
  await page.getByLabel('Meeting link (https)').fill(`https://meet.example.com/${suffix}`);
  await submit(page, page.getByRole('button', { name: 'Save meeting link', exact: true }));
  await expect(page.getByRole('link', { name: 'Join the meeting ›' })).toHaveAttribute('href', `https://meet.example.com/${suffix}`);
  await expect(page.getByText('You can record the outcome once the session starts.')).toBeVisible();

  await login(page, 'buyer_a');
  await visit(page, path);
  await expect(page.getByRole('link', { name: 'Join the meeting ›' })).toHaveAttribute('href', `https://meet.example.com/${suffix}`);

  // The link never appears on the public service page.
  await page.setViewportSize({ width: 390, height: 844 });
  await visit(page, servicePath!);
  await expect(page.getByText(`meet.example.com/${suffix}`)).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});
