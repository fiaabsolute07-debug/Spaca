import { expect, test } from '@playwright/test';
import { TINY_PNG, chooseOption, createPublishedService, login, submit, uniqueSuffix, visit, waitForHydration } from './helpers';

/**
 * A work sample is the work, not a link pointing at it: the creator uploads a picture or a video, a moderator decides
 * by looking at it, and buyers see it play on the page. Uploads cost an upload intent (30 per account per hour), so
 * this file is the only one that spends them.
 */
test('an uploaded work sample is shown as the picture itself, once moderation has seen it', async ({ page, request }) => {
  // The creator's services page carries every service this dev database has collected, so give the walk some room.
  test.setTimeout(240_000);
  const service = await createPublishedService(page, 'sample-media');
  const title = `Uploaded sample ${uniqueSuffix()}`;

  // The creator adds the file from the one Work samples form at the top of their services page, folded until opened.
  await visit(page, '/creator/services');
  const form = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: 'Work samples', exact: true }) });
  const upload = form.getByLabel('Sample file');
  await waitForHydration(upload);
  await form.getByRole('heading', { name: 'Work samples', exact: true }).click();
  await upload.setInputFiles({ name: 'launch-frame.png', mimeType: 'image/png', buffer: TINY_PNG });
  await expect(form.getByText('Ready', { exact: true })).toBeVisible();
  await form.getByLabel('What this work is').fill(title);
  await chooseOption(page, form, 'Show it on', service.title);
  await submit(page, form.getByRole('button', { name: 'Add work sample', exact: true }));
  await expect(page.getByRole('main').getByRole('status')).toContainText('waiting for moderation');

  // A pending sample is nobody else's business yet: the buyer's page does not list it.
  await login(page, 'buyer_a');
  await visit(page, service.path);
  await expect(page.getByText(title, { exact: true })).toHaveCount(0);

  // The moderator decides by looking at the file, which the queue shows instead of only its id.
  await login(page, 'moderator');
  await visit(page, '/admin/moderation');
  const queued = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  const picture = queued.getByRole('img', { name: title });
  await expect(picture).toBeVisible();
  const src = (await picture.getAttribute('src'))!;
  expect(src).toMatch(/^\/api\/samples\/[0-9a-f-]{36}$/);
  // While it is pending, that same address is 404 to anyone without a session that may see it.
  expect((await request.get(src)).status()).toBe(404);
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
