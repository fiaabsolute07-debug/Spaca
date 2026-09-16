/**
 * Browser-tab and home-screen icons from `src/app/icon.svg` (a lime badge with the dark spaca bars, the way
 * marketplaces like Fiverr show a coloured badge in the tab). Writes `src/app/favicon.ico` (16, 32 and 48 px PNG
 * frames) for tab strips that do not draw SVG favicons, and `src/app/apple-icon.png` (180 px, full-bleed lime, since
 * iOS rounds the corners itself). Run after changing the SVG:
 *
 *   ./node_modules/.bin/tsx scripts/brand-icons.ts
 */
import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';

const svg = await readFile('src/app/icon.svg', 'utf8');
const bars = /<path[^>]*\/>/.exec(svg)?.[0];
if (!bars) throw new Error('src/app/icon.svg has no bars path');

const browser = await chromium.launch({ channel: 'chrome' });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const render = async (markup: string, size: number) => {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${markup.replace('<svg ', `<svg width="${size}" height="${size}" style="display:block" `)}</body></html>`);
    return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  };

  // One page renders one size at a time, so the frames are made in turn.
  const frames: { size: number; png: Buffer }[] = [];
  for (const size of [16, 32, 48]) frames.push({ size, png: await render(svg, size) });
  // ICO: 6-byte header, one 16-byte entry per frame, then the PNG data of each frame.
  const header = Buffer.alloc(6 + 16 * frames.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach(({ size, png }, index) => {
    const entry = 6 + 16 * index;
    header.writeUInt8(size, entry);
    header.writeUInt8(size, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  await writeFile('src/app/favicon.ico', Buffer.concat([header, ...frames.map((frame) => frame.png)]));

  const square = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#D6F25E"/>${bars}</svg>`;
  await writeFile('src/app/apple-icon.png', await render(square, 180));
  console.log(`favicon.ico (${frames.map((frame) => frame.size).join(', ')} px) and apple-icon.png (180 px) written`);
} finally {
  await browser.close();
}
