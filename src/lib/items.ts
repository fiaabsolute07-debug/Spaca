/**
 * Web3 item auctions (drizzle/0033), the parts pages and client components share: item suggestions, windows and the
 * words used for each state. The rules themselves live in src/modules/items.
 */
export const ITEM_TYPE_SUGGESTIONS = ['WL spot', 'GTD mint', 'FCFS mint', 'Pre-market token', 'Presale allocation', 'Points', 'Airdrop allocation', 'NFT'] as const;

/** The winner pays into escrow within this window after the auction closes. */
export const ITEM_PAYMENT_HOURS = 24;
/** After the seller marks delivery, the buyer confirms or disputes within this window; silence confirms. */
export const ITEM_CONFIRM_HOURS = 72;
/** Collateral covers at least this share of the starting price (1/5). */
export const ITEM_COLLATERAL_MIN_DIVISOR = 5;

export type ItemOrigin = 'PROJECT' | 'RESALE';
export const ORIGIN_LABEL: Record<ItemOrigin, string> = { PROJECT: 'Sold by the project', RESALE: 'Resale' };

export const SALE_STATUS_LABEL: Record<string, string> = {
  AWAITING_PAYMENT: 'Waiting for payment',
  AWAITING_DELIVERY: 'Waiting for delivery',
  DELIVERED: 'Delivered, waiting for confirmation',
  COMPLETED: 'Completed',
  PAYMENT_EXPIRED: 'Not paid in time',
  SELLER_DEFAULTED: 'Not delivered: buyer refunded with collateral',
  DISPUTED: 'In dispute',
  REFUNDED: 'Refunded',
};

/** "$1,250.00" from minor units. */
export const usd = (minor: number | bigint | string) => `$${(Number(minor) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
