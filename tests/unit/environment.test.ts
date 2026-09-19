import { afterEach, describe, expect, it, vi } from 'vitest';
import { appStage, auctionMoneyNote, paymentsOpen } from '@/lib/environment';

describe('where the build runs and whether money moves (launch decisions 2026-09-17)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is the local sandbox outside a production build, and staging or production by APP_ENV inside one', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('APP_ENV', 'production');
    expect(appStage()).toBe('local');
    vi.stubEnv('NODE_ENV', 'production');
    expect(appStage()).toBe('production');
    vi.stubEnv('APP_ENV', 'staging');
    expect(appStage()).toBe('staging');
  });

  it('keeps payments open unless PAYMENT_MODE=off, and words the auction money note for each place', () => {
    vi.stubEnv('PAYMENT_MODE', 'mock');
    expect(paymentsOpen()).toBe(true);
    vi.stubEnv('NODE_ENV', 'development');
    expect(auctionMoneyNote()).toBe('Sandbox: collateral and escrow are recorded by spaca and no funds move.');

    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_ENV', 'production');
    vi.stubEnv('PAYMENT_MODE', 'off');
    expect(paymentsOpen()).toBe(false);
    expect(auctionMoneyNote()).toBe('Payments are not open yet: collateral, bids and escrow start when they do.');
    vi.stubEnv('PAYMENT_MODE', 'live');
    expect(auctionMoneyNote()).toBeNull();
  });

  it('treats a missing PAYMENT_MODE as closed in a production build, and as the local sandbox outside one (F4)', () => {
    // A deployment that loses the variable would otherwise advertise paying again, with no rail behind it.
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_ENV', 'production');
    vi.stubEnv('PAYMENT_MODE', undefined);
    expect(paymentsOpen()).toBe(false);
    expect(auctionMoneyNote()).toBe('Payments are not open yet: collateral, bids and escrow start when they do.');
    vi.stubEnv('PAYMENT_MODE', '');
    expect(paymentsOpen()).toBe(false);
    vi.stubEnv('PAYMENT_MODE', 'testnet');
    expect(paymentsOpen()).toBe(true);

    // Locally the mock provider still runs without anyone setting the variable.
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('PAYMENT_MODE', undefined);
    expect(paymentsOpen()).toBe(true);
  });
});
