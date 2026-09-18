import { crc32, deflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { dateTimeLocal, login, submit, uniqueSuffix, visit, waitForHydration } from './helpers';

/** A real RGB PNG of noise, large enough (1600×1000, a few MB) that the browser makes a card-sized copy of it. */
function noisePng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const rows = Buffer.alloc((width * 3 + 1) * height);
  let seed = 7;
  for (let i = 0; i < rows.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    rows[i] = i % (width * 3 + 1) === 0 ? 0 : seed & 0xff;
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const PNG = noisePng(1600, 1000);

test('a buyer picks the campaign type from cards, adds a project image, and creators see it on the campaign', async ({ page }) => {
  const title = `E2E visual brief ${uniqueSuffix()}`;
  const imageName = `${title}, image 1 of 1`;
  await login(page, 'buyer_a');
  await visit(page, '/buyer/requests/new');

  // Posting terms appear only once the work is a post; picking the Shiller goal suggests Publish.
  await expect(page.getByRole('group', { name: 'Post format' })).toBeHidden();
  await page.getByRole('group', { name: 'What is the campaign for?' }).getByRole('radio', { name: /^Shiller/ }).check();
  // The goal carries the kind of work: Shiller is a post, so the posting terms appear without a second question.
  await expect(page.getByRole('group', { name: 'Post format' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Platform' }).getByRole('radio', { name: 'X', exact: true })).toBeChecked();
  await page.getByRole('group', { name: 'Post format' }).getByRole('radio', { name: 'Thread', exact: true }).check();

  await page.getByLabel('Brief title', { exact: true }).fill(title);
  await page.getByLabel('Brief', { exact: true }).fill(`Two disclosed launch threads for ${title}, covering the product, audience and CTA.`);
  const fileInput = page.locator('input[type="file"]');
  await waitForHydration(fileInput);
  await fileInput.setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: PNG });
  // A few megabytes plus the card copy the browser makes: allow for a busy dev server.
  await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 60_000 });
  await page.getByLabel('Total budget (USD, optional if you set a cap)', { exact: true }).fill('600');
  await page.getByLabel('Creators needed', { exact: true }).fill('2');
  await page.getByLabel('Delivery deadline', { exact: true }).fill(dateTimeLocal(new Date(Date.now() + 14 * 86400_000)));
  await submit(page, page.getByRole('button', { name: 'Publish brief', exact: true }));

  const requestPath = new URL(page.url()).pathname;
  expect(requestPath).toMatch(/^\/requests\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('listitem').filter({ hasText: /^Creators post on/ })).toContainText('X · thread');
  await expect(page.getByRole('listitem').filter({ hasText: /^Campaign goal/ })).toContainText('Shiller');
  const image = page.getByRole('img', { name: imageName, exact: true });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  // The campaign page shows the full image.
  expect(await image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1600);
  const original = await image.getAttribute('src');
  await expect(page.getByRole('button', { name: 'Replace images', exact: true })).toBeVisible();

  await login(page, 'creator_c');
  await visit(page, '/requests');
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Campaigns', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('navigation', { name: 'Marketplace sections' })).toHaveCount(0);
  const card = page.getByRole('link', { name: new RegExp(title) });
  await expect(card.locator('img')).toHaveCount(1);
  // The card loads the small copy the browser made at upload, not the full image.
  const cover = card.locator('img');
  await cover.scrollIntoViewIfNeeded();
  await expect.poll(() => cover.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  expect(await cover.getAttribute('src')).not.toBe(original);
  expect(await cover.evaluate((img: HTMLImageElement) => Math.max(img.naturalWidth, img.naturalHeight))).toBe(640);
  await Promise.all([page.waitForURL(new RegExp(`${requestPath}$`)), card.click()]);
  await expect(page.getByRole('img', { name: imageName, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Replace images', exact: true })).toHaveCount(0);
  expect(page.context().pages()).toHaveLength(1);
});

test('an access campaign asks for a session length, and a digital one for the rights, and both reach the hired order', async ({ page }) => {
  const title = `E2E session brief ${uniqueSuffix()}`;
  await login(page, 'buyer_a');
  await visit(page, '/buyer/requests/new');

  // Each category asks only for its own terms: a session length here, no posting terms and no license.
  await page.getByRole('group', { name: 'What is the campaign for?' }).getByRole('radio', { name: /^AMA/ }).check();
  await expect(page.getByRole('group', { name: 'Session length' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Post format' })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'License' })).toHaveCount(0);
  await page.getByRole('group', { name: 'Session length' }).getByRole('radio', { name: '1.5 hours', exact: true }).check();
  await page.getByLabel('Brief title', { exact: true }).fill(title);
  await page.getByLabel('Brief', { exact: true }).fill(`A live walkthrough of our tooling for our engineering team, with questions at the end (${title}).`);
  await page.getByLabel('Total budget (USD, optional if you set a cap)', { exact: true }).fill('400');
  await page.getByLabel('Creators needed', { exact: true }).fill('1');
  await page.getByLabel('Delivery deadline', { exact: true }).fill(dateTimeLocal(new Date(Date.now() + 14 * 86400_000)));
  await submit(page, page.getByRole('button', { name: 'Publish brief', exact: true }));

  const fact = (label: string) => page.getByRole('listitem').filter({ hasText: new RegExp(`^${label}`) });
  await expect(fact('Live session')).toContainText('90 minutes');
  await expect(fact('Time')).toContainText('Agreed with the creator in the order messages');

  const filesTitle = `E2E licensed files ${uniqueSuffix()}`;
  await visit(page, '/buyer/requests/new');
  await page.getByRole('group', { name: 'What is the campaign for?' }).getByRole('radio', { name: /^Memes/ }).check();
  await expect(page.getByRole('group', { name: 'Session length' })).toHaveCount(0);
  await page.getByRole('group', { name: 'License' }).getByRole('radio', { name: /^Exclusive to you/ }).check();
  const rights = 'Use in our own marketing on any channel, edit for size and language, worldwide, with no time limit.';
  await page.getByLabel('What you may do with the files', { exact: true }).fill(rights);
  await page.getByLabel('Brief title', { exact: true }).fill(filesTitle);
  await page.getByLabel('Brief', { exact: true }).fill(`Editable launch graphics and a slide template for our public beta (${filesTitle}).`);
  await page.getByLabel('Total budget (USD, optional if you set a cap)', { exact: true }).fill('400');
  await page.getByLabel('Creators needed', { exact: true }).fill('1');
  await page.getByLabel('Delivery deadline', { exact: true }).fill(dateTimeLocal(new Date(Date.now() + 14 * 86400_000)));
  await submit(page, page.getByRole('button', { name: 'Publish brief', exact: true }));

  const campaign = new URL(page.url()).pathname;
  await expect(fact('License')).toContainText('Exclusive to the buyer');
  await expect(fact('Rights asked for')).toContainText(rights);

  // The rights follow the hire into the order, where both sides read the same words.
  await login(page, 'creator_c');
  await visit(page, campaign);
  await page.getByLabel('Your quote (USD)', { exact: true }).fill('300');
  await page.getByLabel('Delivery time (hours)', { exact: true }).fill('72');
  await page.getByLabel('Your approach and relevant samples', { exact: true }).fill(`Application ${uniqueSuffix()}: editable source files, delivered with a slide template.`);
  await submit(page, page.getByRole('button', { name: 'Send application', exact: true }));

  await login(page, 'buyer_a');
  await visit(page, campaign);
  await submit(page, page.getByRole('button', { name: 'Offer $300.00 to this creator', exact: true }));
  await login(page, 'creator_c');
  await visit(page, campaign);
  await submit(page, page.getByRole('button', { name: 'Accept offer', exact: true }));

  await expect(fact('License')).toContainText('Exclusive to the buyer');
  await expect(fact('Rights')).toContainText(rights);
});
