import { mkdir } from 'node:fs/promises';
import { test } from '@playwright/test';
import { bookFromExplore, createPublishedService, expectNoHorizontalOverflow, visit } from './helpers';

for (const viewport of [{ width: 360, height: 780 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
  test(`commerce pages have no horizontal overflow at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const service = await createPublishedService(page, `responsive-${viewport.width}`);
    const path = await bookFromExplore(page, service.title);
    // bookFromExplore leaves the page signed in as buyer_a; the order belongs to this test.
    const routes = [
      { name: 'home', path: '/' },
      { name: 'explore', path: '/explore' },
      { name: 'service', path: service.path },
      { name: 'requests', path: '/requests' },
      { name: 'auctions', path: '/auctions' },
      { name: 'order', path },
    ];
    await mkdir('test-results/e2e/screens', { recursive: true });
    for (const route of routes) {
      await test.step(`${viewport.width}px ${route.name}`, async () => {
        await visit(page, route.path);
        // Keep every page's screenshot even when an earlier page overflows.
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: `test-results/e2e/screens/${viewport.width}-${route.name}.png`, fullPage: true });
        await test.step('No horizontal overflow', async () => {
          await expectNoHorizontalOverflow(page, true);
        }, { box: true });
      });
    }
  });
}
