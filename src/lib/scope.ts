/**
 * What spaca shows (user decision 2026-09-27): item auctions only. Services, campaigns, orders, funds and the workspace
 * overview stay in the code and the database, and their commands and jobs still run, but no page links to them and
 * their addresses lead to the auction board. `MARKETPLACE_SCOPE=full` shows the whole marketplace again.
 *
 * next.config.ts reads this file for its redirects, so it imports nothing.
 */
export const auctionsOnly = () => process.env.MARKETPLACE_SCOPE !== 'full';

/** Top-level sections that lead to /auctions while only auctions are shown: every page under each one, too. */
export const HIDDEN_SECTIONS = ['/dashboard', '/explore', '/services', '/creators', '/campaigns', '/requests', '/buyer', '/creator', '/orders', '/funds'] as const;
