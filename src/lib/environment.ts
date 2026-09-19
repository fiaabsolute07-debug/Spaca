/**
 * Where this build runs and what it may do (launch decisions, 2026-09-17). A local build is the sandbox; a deployment is
 * staging or production by APP_ENV. PAYMENT_MODE=off means no money moves at all: checkout, collateral, bids that must be
 * paid and payouts refuse whatever the feature flags say, and pages say payments open later.
 */
export type AppStage = 'local' | 'staging' | 'production';

export const appStage = (): AppStage => (process.env.NODE_ENV !== 'production' ? 'local' : process.env.APP_ENV === 'staging' ? 'staging' : 'production');

/**
 * A deployment that loses PAYMENT_MODE must not start advertising paying again: in a production build an unset value
 * reads as `off`, so the variable has to say so explicitly before any money step is offered (audit 2026-09-18, F4).
 * Outside a production build the local sandbox keeps its mock payments without setting anything.
 */
export const paymentsOpen = () => {
  const mode = process.env.PAYMENT_MODE;
  if (process.env.NODE_ENV === 'production') return !!mode && mode !== 'off';
  return mode !== 'off';
};

/** The line under item auctions about where the money is: sandbox wording off production, early access while closed. */
export function auctionMoneyNote(): string | null {
  if (appStage() !== 'production') return 'Sandbox: collateral and escrow are recorded by spaca and no funds move.';
  return paymentsOpen() ? null : 'Payments are not open yet: collateral, bids and escrow start when they do.';
}

export const PAYMENTS_CLOSED_MESSAGE = 'Payments are not open yet on spaca. Everything before paying works; paying, bidding and collateral open later.';
