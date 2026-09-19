/**
 * Screenshots of the pages the brand rollout is judged on (docs/BRAND_ROLLOUT_PROMPT.md §6), at a desktop
 * width and a phone width, so each phase can be compared against docs/brand/spaca-brand-kit.html by eye.
 *
 *   ./node_modules/.bin/tsx scripts/brand-shots.ts [outputDir]
 *
 * Needs the dev server on 3100 (see docs/HANDOFF_PROMPT.md). It signs in with fixture personas through
 * POST /api/dev/session, the only local login, and writes <outputDir>/<width>/<name>.png. Nothing is
 * written to the database. Images stay out of the repo by default: they are a working check, not evidence.
 */
import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

/** Chrome by default, as on the owner's machine; a container sets E2E_BROWSER_EXECUTABLE to its own Chromium. */
const browserOptions = () => (process.env.E2E_BROWSER_EXECUTABLE
  ? { executablePath: process.env.E2E_BROWSER_EXECUTABLE }
  : { channel: process.env.E2E_BROWSER_CHANNEL ?? 'chrome' });

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3100';
const outRoot = process.argv[2] ?? process.env.BRAND_SHOTS_DIR ?? '/tmp/brand-shots';
const WIDTHS = [1280, 375] as const;

type Persona = 'buyer_a' | 'creator_d' | 'admin' | null;
type Shot = { name: string; path: string | ((page: Page) => Promise<string>); persona: Persona };

async function login(context: BrowserContext, persona: Exclude<Persona, null>) {
  const response = await context.request.post(`${baseURL}/api/dev/session`, {
    data: { persona },
    headers: { Origin: new URL(baseURL).origin, Accept: 'application/json' },
  });
  if (!response.ok()) throw new Error(`login ${persona}: HTTP ${response.status()}`);
}

/** The seeded ids differ per database, so the first campaign and order are read off the page instead. */
const firstHref = (selector: string, prefix: string) => async (page: Page) => {
  await page.goto(`${baseURL}${selector}`, { waitUntil: 'domcontentloaded' });
  const href = await page.locator(`a[href^="${prefix}"]`).first().getAttribute('href');
  if (!href) throw new Error(`no link starting ${prefix} on ${selector}`);
  return href;
};

const SHOTS: Shot[] = [
  { name: '01-landing', path: '/', persona: null },
  { name: '02-explore', path: '/explore', persona: null },
  { name: '03-campaigns-shiller', path: '/campaigns/shiller', persona: null },
  { name: '04-campaigns-testnet', path: '/campaigns/testnet', persona: null },
  { name: '05-requests', path: '/requests', persona: null },
  { name: '06-request-detail', path: firstHref('/requests', '/requests/'), persona: null },
  { name: '07-funds-buyer', path: '/funds', persona: 'buyer_a' },
  { name: '08-funds-creator', path: '/funds', persona: 'creator_d' },
  { name: '09-order-workspace', path: firstHref('/buyer/orders', '/orders/'), persona: 'buyer_a' },
  { name: '10-post-a-brief', path: '/buyer/requests/new', persona: 'buyer_a' },
  { name: '11-admin', path: '/admin', persona: 'admin' },
];

async function main() {
  const browser = await chromium.launch(browserOptions());
  const overflowing: string[] = [];
  try {
    for (const width of WIDTHS) {
      const dir = path.join(outRoot, String(width));
      await mkdir(dir, { recursive: true });
      let signedIn: Persona = null;
      const context = await browser.newContext({ viewport: { width, height: width === 1280 ? 900 : 812 } });
      const page = await context.newPage();
      for (const shot of SHOTS) {
        if (shot.persona !== signedIn) {
          if (shot.persona) await login(context, shot.persona);
          else await context.clearCookies();
          signedIn = shot.persona;
        }
        const target = typeof shot.path === 'string' ? shot.path : await shot.path(page);
        await page.goto(`${baseURL}${target}`, { waitUntil: 'domcontentloaded' });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(400);
        // A page body wider than the viewport means something is pushing the layout sideways.
        const size = await page.evaluate(() => ({
          viewport: document.documentElement.clientWidth,
          content: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
        }));
        if (size.content > size.viewport + 1) overflowing.push(`${width}px ${shot.name}: ${size.content} > ${size.viewport}`);
        await page.screenshot({ path: path.join(dir, `${shot.name}.png`), fullPage: true });
        process.stdout.write(`${width}px ${shot.name} ${target}\n`);
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`\nWrote ${SHOTS.length * WIDTHS.length} screenshots to ${outRoot}`);
  if (overflowing.length) {
    console.error(`\nHorizontal overflow:\n${overflowing.map((line) => `  ${line}`).join('\n')}`);
    process.exitCode = 1;
  } else {
    console.log('No horizontal overflow at either width.');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
