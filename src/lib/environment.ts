/**
 * Where this build runs and what it may do (launch decisions, 2026-09-17). A local build is the sandbox; a deployment is
 * staging or production by APP_ENV. PAYMENT_MODE=off means no money moves at all: checkout, collateral, bids that must be
 * paid and payouts refuse whatever the feature flags say, and pages say payments open later.
 */
export type AppStage = 'local' | 'staging' | 'production';

export const appStage = (): AppStage => (process.env.NODE_ENV !== 'production' ? 'local' : process.env.APP_ENV === 'staging' ? 'staging' : 'production');

export const paymentsOpen = () => process.env.PAYMENT_MODE !== 'off';

/**
 * Whether the sign-in dialog offers email and password. `EMAIL_SIGN_IN=off` hides it, leaving the connected
 * accounts as the only way in; an email and password added in settings still work if the dialog is shown again.
 */
export const emailSignInEnabled = () => process.env.EMAIL_SIGN_IN !== 'off';

/** The line under item auctions about where the money is: sandbox wording off production, early access while closed. */
export function auctionMoneyNote(): string | null {
  if (appStage() !== 'production') return 'Sandbox: collateral and escrow are recorded by spaca and no funds move.';
  return paymentsOpen() ? null : 'Payments are not open yet: collateral, bids and escrow start when they do.';
}

export const PAYMENTS_CLOSED_MESSAGE = 'Payments are not open yet on spaca. Everything before paying works; paying, bidding and collateral open later.';
