import { expect, test } from '@playwright/test';
import { TINY_PNG, chooseOption, createPublishedService, login, submit, uniqueSuffix, visit, waitForHydration } from './helpers';

/**
 * A work sample is the work, not a link pointing at it: the creator uploads a picture or a video, a moderator decides
 * by looking at it, and buyers see it play on the page. Uploads cost an upload intent (30 per account per hour), so
 * this file is the only one that spends them.
 */
test('an uploaded work sample is shown as the picture itself, once moderation has seen it', async ({ page, request }) => {
  const service = await createPublishedService(page, 'sample-media');
  const title = `Uploaded sample ${uniqueSuffix()}`;

  // The creator adds the file to the live service.
  await visit(page, '/creator/services');
  const card = page.locator('div.panel').filter({ has: page.getByRole('heading', { name: service.title, exact: true }) });
  // Opening the panel changes the `open` attribute, so React has to hydrate first or it re-renders the upload field
  // out from under the file that was just chosen.
  const upload = card.getByLabel('Sample file');
  await waitForHydration(upload);
  await card.locator('summary').filter({ hasText: 'Work samples' }).click();
  await upload.setInputFiles({ name: 'launch-frame.png', mimeType: 'image/png', buffer: TINY_PNG });
  await expect(card.getByText('Ready', { exact: true })).toBeVisible();
  await card.getByLabel('What this work is').fill(title);
  await submit(page, card.getByRole('button', { name: 'Add work sample', exact: true }));
  await expect(page.getByRole('main').getByRole('status')).toContainText('waiting for moderation');

  // The creator sees their own file as a picture, served through the sample route rather than linked away from.
  await visit(page, '/creator/services');
  const owned = page.locator('div.panel').filter({ has: page.getByRole('heading', { name: service.title, exact: true }) });
  await waitForHydration(owned.getByLabel('Sample file'));
  await owned.locator('summary').filter({ hasText: 'Work samples' }).click();
  const picture = owned.getByRole('img', { name: title });
  await expect(picture).toBeVisible();
  const src = (await picture.getAttribute('src'))!;
  expect(src).toMatch(/^\/api\/samples\/[0-9a-f-]{36}$/);

  // Nobody else can reach the file while the sample is still pending, and the buyer's page does not list it.
  expect((await request.get(src)).status()).toBe(404);
  await login(page, 'buyer_a');
  await visit(page, service.path);
  await expect(page.getByText(title, { exact: true })).toHaveCount(0);

  // The moderator decides by looking at the file, which the queue now shows.
  await login(page, 'moderator');
  await visit(page, '/admin/moderation');
  const queued = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  await expect(queued.getByRole('img', { name: title })).toBeVisible();
  await chooseOption(page, queued, 'Decision', 'APPROVED');
  await queued.getByLabel(/^Reason for the audit log/).fill(`Approved in an end-to-end test ${uniqueSuffix()}`);
  await submit(page, queued.getByRole('button', { name: 'Save moderation decision', exact: true }));

  // Now the picture is part of the public service page, and its file is served to a signed-out visitor.
  await login(page, 'buyer_a');
  await visit(page, service.path);
  const shown = page.getByRole('img', { name: title });
  await expect(shown).toBeVisible();
  expect(await shown.getAttribute('src')).toBe(src);
  const served = await request.get(src);
  expect(served.ok()).toBe(true);
  expect(served.headers()['content-type']).toContain('image/png');
  // The link sample keeps its link, so work that only lives on someone else's channel is still listed.
  await expect(page.getByRole('link', { name: 'Open the post ›' }).first()).toBeVisible();
});
