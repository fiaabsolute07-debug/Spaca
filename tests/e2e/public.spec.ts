import { expect, test } from '@playwright/test';
import { visit } from './helpers';

test('anonymous visitors browse the landing, explore, service, requests and auctions without errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await visit(page, '/');
  await expect(page).toHaveTitle('spaca | Creator campaigns marketplace for web3 launches | Hire crypto-native creators on X');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Find the voices your launch needs.');
  await expect(page.getByRole('radiogroup', { name: 'Color theme' })).toBeVisible();
  await visit(page, '/explore');
  await expect(page.getByRole('heading', { name: 'Find creators for your launch.' })).toBeVisible();
  const service = page.getByRole('main').getByRole('link').filter({ has: page.getByRole('heading', { level: 3 }) }).first();
  const path = await service.getAttribute('href');
  expect(path).toMatch(/^\/services\//);
  await visit(page, path!);
  await expect(page.getByRole('heading', { name: 'The work, clearly defined.' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Log in to book' })).toBeVisible();
  await visit(page, '/requests');
  await expect(page.getByRole('heading', { name: 'Bring your next project to life.' })).toBeVisible();
  await visit(page, '/auctions');
  await expect(page.getByRole('heading', { name: 'Web3 items, bid in the open.' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('an anonymous buyer workspace displays the login prompt', async ({ page }) => {
  // The unauthenticated prompt deliberately uses h3, not a page h1.
  const response = await page.goto('/buyer/orders');
  expect(response?.status()).toBe(200);
  // Next.js renders an empty route-announcer alert outside <main>; app errors render inside it.
  await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Your workspace is one login away' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Log in to continue' })).toHaveAttribute('href', '/sign-in?return_to=%2Fbuyer%2Forders');
});
