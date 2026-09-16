/**
 * Text contrast check for the pages the brand rollout touches (docs/BRAND_ROLLOUT_PROMPT.md §6): every visible
 * run of text is measured against the background actually painted behind it, and anything under WCAG AA is
 * reported. Large text (>= 24px, or >= 18.66px bold) is held to 3:1, everything else to 4.5:1.
 *
 *   ./node_modules/.bin/tsx scripts/brand-contrast.ts
 *   LANDING_THEME=light ./node_modules/.bin/tsx scripts/brand-contrast.ts   # the landing's other setting
 *
 * Needs the dev server on 3100. It signs in with fixture personas through POST /api/dev/session and writes
 * nothing. Exits non-zero if any text fails, listing the worst pairs first.
 */
import { chromium, type BrowserContext, type Page } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3100';
/** The landing keeps a light/dark switch; both settings have to pass, so either can be asked for here. */
const landingTheme = process.env.LANDING_THEME === 'light' || process.env.LANDING_THEME === 'dark' ? process.env.LANDING_THEME : null;

type Persona = 'buyer_a' | 'creator_d' | 'admin' | null;
type Target = { name: string; path: string; persona: Persona };

const TARGETS: Target[] = [
  { name: 'landing', path: '/', persona: null },
  { name: 'explore', path: '/explore', persona: null },
  { name: 'campaigns/shiller', path: '/campaigns/shiller', persona: null },
  { name: 'campaigns/testnet', path: '/campaigns/testnet', persona: null },
  { name: 'requests', path: '/requests', persona: null },
  { name: 'funds (buyer)', path: '/funds', persona: 'buyer_a' },
  { name: 'funds (creator)', path: '/funds', persona: 'creator_d' },
  { name: 'post a brief', path: '/buyer/requests/new', persona: 'buyer_a' },
  { name: 'admin', path: '/admin', persona: 'admin' },
];

type Finding = { page: string; ratio: number; needed: number; text: string; color: string; background: string; selector: string };

/** Runs in the page: every element holding its own text, its colour, and the colour actually painted behind it. */
const MEASURE = `(() => {
  const parse = (value) => {
    const parts = value.match(/[\\d.]+/g);
    if (!parts) return null;
    const [r, g, b, a] = parts.map(Number);
    return { r, g, b, a: a === undefined ? 1 : a };
  };
  const over = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  });
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const luminance = (c) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  const ratio = (a, b) => {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const path = (el) => {
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && parts.length < 4; node = node.parentElement) {
      parts.unshift(node.tagName.toLowerCase() + (node.classList.length ? '.' + [...node.classList].slice(0, 2).join('.') : ''));
    }
    return parts.join(' > ');
  };

  const results = [];
  for (const el of document.querySelectorAll('body *')) {
    const own = [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim().length > 1);
    if (!own) continue;
    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) < 0.15) continue;
    const front = parse(style.color);
    if (!front || front.a < 0.1) continue;

    // Walk up until something opaque is painted; an image behind the text makes the measurement meaningless, so skip it.
    let backdrop = { r: 255, g: 255, b: 255, a: 1 };
    let layers = [];
    let imaged = false;
    for (let node = el; node; node = node.parentElement) {
      const nodeStyle = getComputedStyle(node);
      if (nodeStyle.backgroundImage !== 'none' && !nodeStyle.backgroundImage.startsWith('linear-gradient')) { imaged = true; break; }
      const bg = parse(nodeStyle.backgroundColor);
      if (!bg || bg.a === 0) continue;
      layers.push(bg);
      if (bg.a === 1) { backdrop = bg; break; }
    }
    if (imaged) continue;
    let behind = backdrop;
    for (let i = layers.length - 1; i >= 0; i--) behind = layers[i].a === 1 ? layers[i] : over(layers[i], behind);

    const size = parseFloat(style.fontSize);
    const weight = Number(style.fontWeight) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const needed = large ? 3 : 4.5;
    const text = el.textContent.trim().replace(/\\s+/g, ' ').slice(0, 60);
    results.push({
      ratio: ratio(over(front, behind), behind),
      needed,
      text,
      color: style.color,
      background: 'rgb(' + [behind.r, behind.g, behind.b].map(Math.round).join(', ') + ')',
      selector: path(el),
    });
  }
  return results;
})()`;

async function login(context: BrowserContext, persona: Exclude<Persona, null>) {
  const response = await context.request.post(`${baseURL}/api/dev/session`, {
    data: { persona },
    headers: { Origin: new URL(baseURL).origin, Accept: 'application/json' },
  });
  if (!response.ok()) throw new Error(`login ${persona}: HTTP ${response.status()}`);
}

async function main() {
  const browser = await chromium.launch({ channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  if (landingTheme) {
    await context.addInitScript((theme) => {
      try { localStorage.setItem('capacity-landing-theme', theme); } catch { /* private mode */ }
    }, landingTheme);
  }
  const page: Page = await context.newPage();
  const failures: Finding[] = [];
  let measured = 0;
  let signedIn: Persona = null;
  try {
    for (const target of TARGETS) {
      if (target.persona !== signedIn) {
        if (target.persona) await login(context, target.persona);
        else await context.clearCookies();
        signedIn = target.persona;
      }
      await page.goto(`${baseURL}${target.path}`, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => document.fonts.ready);
      const found = await page.evaluate(MEASURE) as Omit<Finding, 'page'>[];
      measured += found.length;
      for (const item of found) if (item.ratio < item.needed) failures.push({ ...item, page: target.name });
      process.stdout.write(`${target.name}: ${found.length} text runs\n`);
    }
  } finally {
    await browser.close();
  }

  if (!failures.length) {
    console.log(`\n${measured} text runs measured on ${TARGETS.length} pages${landingTheme ? ` (landing set to ${landingTheme})` : ''}. All meet WCAG AA.`);
    return;
  }
  failures.sort((a, b) => a.ratio - b.ratio);
  console.error(`\n${failures.length} of ${measured} text runs are below WCAG AA:\n`);
  for (const item of failures.slice(0, 40)) {
    console.error(`  ${item.ratio.toFixed(2)}:1 (needs ${item.needed}:1)  ${item.page}  ${item.selector}`);
    console.error(`      "${item.text}"  ${item.color} on ${item.background}`);
  }
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
