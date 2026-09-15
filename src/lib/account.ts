/**
 * Buyer and creator accounts are separate (product decision 2026-09-15): a new account is one or the other. Buyers hire
 * (book, post campaigns, bid, pay); creators sell (services, samples, applications, delivery). Operators are separate
 * grants. Older test accounts may still hold both roles and pass both checks.
 */
export type AccountType = 'buyer' | 'creator';

type WithRoles = { roles: readonly string[] };

export const isBuyer = (actor: WithRoles) => actor.roles.includes('buyer');
export const isCreator = (actor: WithRoles) => actor.roles.includes('creator');

/** The account's primary type for navigation: creator when it can sell, otherwise buyer. */
export const accountTypeOf = (actor: WithRoles): AccountType | null => (isCreator(actor) ? 'creator' : isBuyer(actor) ? 'buyer' : null);

const CREATOR_COMMANDS = [
  'add_sample', 'create_service', 'update_service', 'publish_service', 'pause_service', 'archive_service', 'set_accepting_orders',
  'add_digital_release', 'add_social_account', 'remove_social_account', 'create_auction', 'cancel_auction',
  'apply', 'withdraw_application', 'accept_offer', 'decline_offer', 'start', 'deliver',
];
const BUYER_COMMANDS = [
  'book', 'submit_brief', 'revision', 'approve', 'refund_digital_purchase', 'create_crypto_payment',
  'create_request', 'update_request', 'set_request_images', 'close_request', 'cancel_request', 'select_application', 'withdraw_offer',
  'bid', 'buy_now', 'create_pool', 'create_campaign_pool', 'update_pool_template', 'create_pool_funding', 'refund_pool_unused', 'close_campaign_pool',
];
const REQUIRED = new Map<string, AccountType>([
  ...CREATOR_COMMANDS.map((command) => [command, 'creator'] as [string, AccountType]),
  ...BUYER_COMMANDS.map((command) => [command, 'buyer'] as [string, AccountType]),
]);

/** Which account type a command needs; commands on an existing order or profile are open to either side. */
export const requiredAccountType = (command: string): AccountType | null => REQUIRED.get(command) ?? null;

export const accountTypeMessage = (needed: AccountType) => needed === 'creator'
  ? 'This needs a creator account. Buyer accounts hire creators; create a creator account to offer services.'
  : 'This needs a buyer account. Creator accounts offer services; create a buyer account to hire creators.';
