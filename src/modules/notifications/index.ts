/**
 * Notification templates, dispatcher with semantic dedupe, and a local-only sink.
 *
 * Ownership: Claude (see docs/COLLABORATION.md). Self-contained; no network, no real email.
 *
 * Rules (master §14.2):
 * - Dedupe on recipient + semantic event + channel.
 * - Send attempts and status are recorded.
 * - Subjects are static per template, so private content can never reach a subject line.
 * - Links are internal route paths without query strings or tokens; the route checks access.
 * - Marketing requires opt-in; transactional/security notifications are always delivered.
 * - Test/staging email goes to a sink. Only `LocalNotificationSink` is implemented here.
 */
import { createHash } from 'node:crypto';

export type NotificationChannel = 'in_app' | 'email';
export type NotificationCategory = 'transactional' | 'security' | 'marketing';

export type NotificationErrorCode =
  | 'UNKNOWN_TEMPLATE'
  | 'INVALID_PARAMS'
  | 'INVALID_RECIPIENT'
  | 'INVALID_SEMANTIC_KEY'
  | 'CHANNEL_NOT_ALLOWED'
  | 'UNSUPPORTED_CURRENCY'
  | 'DEDUPE_KEY_REUSED';

export class NotificationError extends Error {
  readonly code: NotificationErrorCode;
  constructor(code: NotificationErrorCode, message: string) {
    super(message);
    this.name = 'NotificationError';
    this.code = code;
  }
}

type Money = { amount: bigint; currency: string };
type OrderRef = { orderRef: string };

export interface NotificationTemplateParams {
  'auth.email_verification_requested': Record<string, never>;
  'auth.password_reset_requested': Record<string, never>;
  'payment.pending': OrderRef & Money;
  'payment.confirmed': OrderRef & Money;
  'order.new': OrderRef & { serviceTitle: string };
  'order.brief_missing': OrderRef;
  'order.due_soon': OrderRef & { dueAt: string };
  'order.delivered': OrderRef & { reviewDeadlineAt: string };
  'order.revision_requested': OrderRef;
  'order.approved': OrderRef;
  'order.review_reminder': OrderRef & { reviewDeadlineAt: string };
  'order.overdue': OrderRef;
  'order.completed': OrderRef;
  'order.cancellation_requested': OrderRef;
  'order.cancellation_resolved': OrderRef & { outcome: 'ACCEPTED' | 'REJECTED' | 'EXPIRED' };
  'order.deadline_extension_requested': OrderRef & { newDueAt: string };
  'order.deadline_extension_resolved': OrderRef & { outcome: 'ACCEPTED' | 'REJECTED' };
  'payout.succeeded': OrderRef & Money;
  'payout.failed': OrderRef;
  'refund.updated': OrderRef & Money & { refundStatus: 'PENDING' | 'SUCCEEDED' | 'FAILED' };
  'dispute.opened': OrderRef;
  'dispute.resolved': OrderRef;
  'request.application_received': { requestRef: string };
  'request.hire_offer': { requestRef: string };
  'auction.outbid': { auctionRef: string } & Money;
  'auction.won': { auctionRef: string; paymentDueAt: string } & Money;
  'auction.expired': { auctionRef: string };
  'pool.asset_missing': { poolRef: string; assetCode: string };
  'marketing.new_offers': Record<string, never>;
}

export type NotificationTemplateId = keyof NotificationTemplateParams;

type ParamKind = 'ref' | 'text' | 'instant' | 'amount' | 'currency' | 'refundStatus' | 'cancellationOutcome';

export interface NotificationTemplate<K extends NotificationTemplateId = NotificationTemplateId> {
  id: K;
  category: NotificationCategory;
  subject: string;
  allowedChannels: readonly NotificationChannel[];
  defaultChannels: readonly NotificationChannel[];
  params: Readonly<Record<keyof NotificationTemplateParams[K] & string, ParamKind>>;
  body: (params: NotificationTemplateParams[K]) => string;
  linkPath: (params: NotificationTemplateParams[K]) => string;
}

export interface RenderedNotification {
  templateId: NotificationTemplateId;
  category: NotificationCategory;
  subject: string;
  body: string;
  linkPath: string;
}

// ---------------------------------------------------------------------------
// Formatting (no floating point)
// ---------------------------------------------------------------------------

/** Minor-unit exponents for display. Extend deliberately; unknown assets are rejected. */
export const CURRENCY_EXPONENTS: Readonly<Record<string, number>> = Object.freeze({
  USD: 2,
  EUR: 2,
  GBP: 2,
  JPY: 0,
  VND: 0,
  USDC: 6,
});

export function formatAtomicAmount(amount: bigint, currency: string): string {
  if (typeof amount !== 'bigint' || amount < 0n) {
    throw new NotificationError('INVALID_PARAMS', 'amount must be a non-negative bigint');
  }
  const exponent = CURRENCY_EXPONENTS[currency];
  if (exponent === undefined) {
    throw new NotificationError('UNSUPPORTED_CURRENCY', `no display exponent for ${currency}`);
  }
  const digits = amount.toString();
  const whole = exponent === 0 ? digits : digits.length > exponent ? digits.slice(0, -exponent) : '0';
  const fraction = exponent === 0 ? '' : digits.padStart(exponent, '0').slice(-exponent);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${fraction ? `${grouped}.${fraction}` : grouped} ${currency}`;
}

function formatInstant(iso: string): string {
  // Validated as ISO-8601 UTC before rendering.
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

const money = (p: Money) => formatAtomicAmount(p.amount, p.currency);

// ---------------------------------------------------------------------------
// Templates (English default per master §2; strings kept in one catalog for localization)
// ---------------------------------------------------------------------------

const BOTH: readonly NotificationChannel[] = ['in_app', 'email'];
const orderLink = (p: OrderRef) => `/orders/${p.orderRef}`;

function template<K extends NotificationTemplateId>(definition: NotificationTemplate<K>): NotificationTemplate<K> {
  return Object.freeze(definition);
}

export const NOTIFICATION_TEMPLATES: { readonly [K in NotificationTemplateId]: NotificationTemplate<K> } = Object.freeze({
  'auth.email_verification_requested': template({
    id: 'auth.email_verification_requested',
    category: 'security',
    subject: 'Verify your email address',
    allowedChannels: ['email'],
    defaultChannels: ['email'],
    params: {},
    body: () =>
      'Finish verifying your email from the sign-in page. We never include long-lived sign-in tokens in notifications.',
    linkPath: () => '/sign-in',
  }),
  'auth.password_reset_requested': template({
    id: 'auth.password_reset_requested',
    category: 'security',
    subject: 'Password reset requested',
    allowedChannels: ['email'],
    defaultChannels: ['email'],
    params: {},
    body: () => 'A password reset was requested for your account. If this was not you, secure your account.',
    linkPath: () => '/reset-password',
  }),
  'payment.pending': template({
    id: 'payment.pending',
    category: 'transactional',
    subject: 'Payment pending confirmation',
    allowedChannels: BOTH,
    defaultChannels: ['in_app'],
    params: { orderRef: 'ref', amount: 'amount', currency: 'currency' },
    body: (p) => `Your payment of ${money(p)} is waiting for provider confirmation. Work starts only after it is confirmed.`,
    linkPath: orderLink,
  }),
  'payment.confirmed': template({
    id: 'payment.confirmed',
    category: 'transactional',
    subject: 'Payment confirmed',
    allowedChannels: BOTH,
    defaultChannels: BOTH,
    params: { orderRef: 'ref', amount: 'amount', currency: 'currency' },
    body: (p) => `Payment of ${money(p)} was confirmed by the provider. Platform fee: 0.`,
    linkPath: orderLink,
  }),
  'order.new': template({
    id: 'order.new',
    category: 'transactional',
    subject: 'You have a new order',
    allowedChannels: BOTH,
    defaultChannels: BOTH,
    params: { orderRef: 'ref', serviceTitle: 'text' },
    body: (p) => `A buyer booked "${p.serviceTitle}". Review the order to get started.`,
    linkPath: orderLink,
  }),
  'order.brief_missing': template({
    id: 'order.brief_missing',
    category: 'transactional',
    subject: 'Your order needs a brief',
    allowedChannels: BOTH,
    defaultChannels: BOTH,
    params: { orderRef: 'ref' },
    body: () => 'The creator is waiting for your brief before work can start.',
    linkPath: orderLink,
  }),
  'order.due_soon': template({
    id: 'order.due_soon',
    category: 'transactional',
    subject: 'Order due soon',
    allowedChannels: BOTH,
    defaultChannels: BOTH,
    params: { orderRef: 'ref', dueAt: 'instant' },
    body: (p) => `This order is due at ${formatInstant(p.dueAt)}.`,
    linkPath: orderLink,
  }),
  'order.delivered': template({
    id: 'order.delivered',
    category: 'transactional',
    subject: 'Your order was delivered',
    allowedChannels: BOTH,
    defaultChannels: BOTH,
    params: { orderRef: 'ref', reviewDeadlineAt: 'instant' },
    body: (p) => `A delivery is ready for review. Approve, request a revision or open a dispute before ${formatInstant(p.reviewDeadlineAt)}.`,
    linkPath: orderLink,
  }),
  'order.revision_requested': template({
    id: 'order.revision_requested',
    category: 'transactional',
    subject: 'Revision requested',
    allowedChannels: BOTH,
    defaultChannels: BOTH,
    params: { orderRef: 'ref' },
    body: () => 'The buyer requested a revision. Details are on the order page.',
    linkPath: orderLink,
  }),
  'order.approved': template({
    id: 'order.approved',
    category: 'transactional',
    subject: 'Order approved',
    allowedChannels: BOTH,
    defaultChannels: BOTH,
    params: { orderRef: 'ref' },
    body: () => 'The order was approved. Settlement starts once funds are available.',
    linkPath: orderLink,
  }),
  'order.review_reminder': template({
    id: 'order.review_reminder',
    category: 'transactional',
    subject: 'Delivery waiting for your review',
    allowedChannels: BOTH,
    defaultChannels: BOTH,
    params: { orderRef: 'ref', reviewDeadlineAt: 'instant' },
    body: (p) => `Please approve, request a revision or open a dispute before ${formatInstant(p.reviewDeadlineAt)}.`,
    linkPath: orderLink,
  }),
  'order.overdue': template({
    id: 'order.overdue',
    category: 'transactional',
    subject: 'Order is past its due date',
    allowedChannels: BOTH,
    defaultChannels: BOTH,
    params: { orderRef: 'ref' },
    body: () => 'The agreed delivery time has passed. You can message the creator or request a cancellation from the order page.',
    linkPath: orderLink,
  }),
  'order.completed': template({
    id: 'order.completed',
    category: 'transactional',
    subject: 'Order completed',
    allowedChannels: BOTH,
    defaultChannels: ['in_app'],
    params: { orderRef: 'ref' },
    body: () => 'The creator payout was confirmed by the provider. You can now leave a review.',
    linkPath: orderLink,
  }),
  'order.cancellation_requested': template({
    id: 'order.cancellation_requested',
    category: 'transactional',
    subject: 'Cancellation requested',
    allowedChannels: BOTH,
    defaultChannels: BOTH,
    params: { orderRef: 'ref' },
    body: () => 'The other party asked to cancel this order with a proposed refund. Review and respond on the order page.',
    linkPath: orderLink,
  }),
  'order.cancellation_resolved': template({
    id: 'order.cancellation_resolved',
    category: 'transactional',
    subject: 'Cancellation request updated',
    allowedChannels: BOTH,
    defaultChannels: ['in_app'],
    params: { orderRef: 'ref', outcome: 'cancellationOutcome' },
    body: (p) => ({ ACCEPTED: 'The cancellation was accepted with the agreed refund.', REJECTED: 'The cancellation request was declined; the order continues.', EXPIRED: 'The cancellation request expired because the order changed.' })[p.outcome],
    linkPath: orderLink,
  }),
  'order.deadline_extension_requested': template({
    id: 'order.deadline_extension_requested',
    category: 'transactional',
    subject: 'New deadline proposed',
    allowedChannels: BOTH,
    defaultChannels: BOTH,
    params: { orderRef: 'ref', newDueAt: 'instant' },
    body: (p) => `The other party proposed moving the deadline to ${formatInstant(p.newDueAt)}. The current deadline stays unless you accept on the order page.`,
    linkPath: orderLink,
  }),
  'order.deadline_extension_resolved': template({
    id: 'order.deadline_extension_resolved',
    category: 'transactional',
    subject: 'Deadline proposal answered',
    allowedChannels: BOTH,
    defaultChannels: ['in_app'],
    params: { orderRef: 'ref', outcome: 'cancellationOutcome' },
    body: (p) => (p.outcome === 'ACCEPTED' ? 'Your proposed deadline was accepted and is now the order deadline.' : 'Your proposed deadline was declined; the current deadline stays.'),
    linkPath: orderLink,
  }),
  'payout.succeeded': template({
    id: 'payout.succeeded',
    category: 'transactional',
    subject: 'Transfer sent',
    allowedChannels: BOTH,
    defaultChannels: BOTH,
    params: { orderRef: 'ref', amount: 'amount', currency: 'currency' },
    body: (p) => `The provider confirmed a transfer of ${money(p)} for this order. Bank payout timing depends on your provider.`,
    linkPath: () => '/creator/earnings',
  }),
  'payout.failed': template({
    id: 'payout.failed',
    category: 'transactional',
    subject: 'Transfer needs attention',
    allowedChannels: BOTH,
    defaultChannels: BOTH,
    params: { orderRef: 'ref' },
    body: () => 'A transfer for one of your orders could not be completed. No funds were marked as received.',
    linkPath: () => '/creator/payments',
  }),
  'refund.updated': template({
    id: 'refund.updated',
    category: 'transactional',
    subject: 'Refund update',
    allowedChannels: BOTH,
    defaultChannels: BOTH,
    params: { orderRef: 'ref', amount: 'amount', currency: 'currency', refundStatus: 'refundStatus' },
    body: (p) => {
      const state = { PENDING: 'is pending with the provider', SUCCEEDED: 'was confirmed by the provider', FAILED: 'failed and is being reviewed' };
      return `A refund of ${money(p)} ${state[p.refundStatus]}.`;
    },
    linkPath: orderLink,
  }),
  'dispute.opened': template({
    id: 'dispute.opened',
    category: 'transactional',
    subject: 'A dispute was opened',
    allowedChannels: BOTH,
    defaultChannels: BOTH,
    params: { orderRef: 'ref' },
    body: () => 'A dispute was opened on an order. Releases are paused while it is reviewed.',
    linkPath: orderLink,
  }),
  'dispute.resolved': template({
    id: 'dispute.resolved',
    category: 'transactional',
    subject: 'Dispute resolved',
    allowedChannels: BOTH,
    defaultChannels: BOTH,
    params: { orderRef: 'ref' },
    body: () => 'An operator resolved the dispute on this order. The outcome and any refund status are on the order page.',
    linkPath: orderLink,
  }),
  'request.application_received': template({
    id: 'request.application_received',
    category: 'transactional',
    subject: 'New application on your request',
    allowedChannels: BOTH,
    defaultChannels: ['in_app'],
    params: { requestRef: 'ref' },
    body: () => 'A creator applied to your request. Compare applicants when you are ready.',
    linkPath: (p) => `/requests/${p.requestRef}`,
  }),
  'request.hire_offer': template({
    id: 'request.hire_offer',
    category: 'transactional',
    subject: 'You received a hire offer',
    allowedChannels: BOTH,
    defaultChannels: BOTH,
    params: { requestRef: 'ref' },
    body: () => 'A buyer selected your quote. Confirm capacity before the offer expires.',
    linkPath: (p) => `/requests/${p.requestRef}`,
  }),
  'auction.outbid': template({
    id: 'auction.outbid',
    category: 'transactional',
    subject: 'You were outbid',
    allowedChannels: BOTH,
    defaultChannels: ['in_app'],
    params: { auctionRef: 'ref', amount: 'amount', currency: 'currency' },
    body: (p) => `The current bid is now ${money(p)}.`,
    linkPath: (p) => `/auctions/${p.auctionRef}`,
  }),
  'auction.won': template({
    id: 'auction.won',
    category: 'transactional',
    subject: 'You won an auction',
    allowedChannels: BOTH,
    defaultChannels: BOTH,
    params: { auctionRef: 'ref', amount: 'amount', currency: 'currency', paymentDueAt: 'instant' },
    body: (p) => `Your winning bid is ${money(p)}. Complete payment before ${formatInstant(p.paymentDueAt)}.`,
    linkPath: (p) => `/auctions/${p.auctionRef}`,
  }),
  'auction.expired': template({
    id: 'auction.expired',
    category: 'transactional',
    subject: 'Auction ended',
    allowedChannels: BOTH,
    defaultChannels: ['in_app'],
    params: { auctionRef: 'ref' },
    body: () => 'An auction you follow has ended.',
    linkPath: (p) => `/auctions/${p.auctionRef}`,
  }),
  'pool.asset_missing': template({
    id: 'pool.asset_missing',
    category: 'transactional',
    subject: 'Campaign funding needs attention',
    allowedChannels: BOTH,
    defaultChannels: BOTH,
    params: { poolRef: 'ref', assetCode: 'currency' },
    body: (p) => `The campaign pool is missing funding in ${p.assetCode}.`,
    linkPath: (p) => `/campaigns/${p.poolRef}/funding`,
  }),
  'marketing.new_offers': template({
    id: 'marketing.new_offers',
    category: 'marketing',
    subject: 'New creator offers',
    allowedChannels: BOTH,
    defaultChannels: ['email'],
    params: {},
    body: () => 'New creator services are available to explore.',
    linkPath: () => '/explore',
  }),
});

// ---------------------------------------------------------------------------
// Validation + rendering
// ---------------------------------------------------------------------------

const REF_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;
const CURRENCY_CODE_PATTERN = /^[A-Z][A-Z0-9]{2,9}$/;
const LINK_PATTERN = /^\/[A-Za-z0-9_\-/]*$/;
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function validateParam(name: string, kind: ParamKind, value: unknown): void {
  const fail = (why: string) => new NotificationError('INVALID_PARAMS', `param ${name} ${why}`);
  switch (kind) {
    case 'ref':
      if (typeof value !== 'string' || !REF_PATTERN.test(value)) throw fail('must be a route-safe id');
      return;
    case 'text':
      if (typeof value !== 'string' || value.length === 0 || value.length > 120 || hasControlChars(value)) {
        throw fail('must be 1-120 chars without control characters');
      }
      return;
    case 'instant':
      if (typeof value !== 'string' || !ISO_UTC_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
        throw fail('must be an ISO-8601 UTC instant');
      }
      return;
    case 'amount':
      if (typeof value !== 'bigint' || value < 0n) throw fail('must be a non-negative bigint');
      return;
    case 'currency':
      if (typeof value !== 'string' || !CURRENCY_CODE_PATTERN.test(value)) throw fail('must be an asset code');
      return;
    case 'refundStatus':
      if (value !== 'PENDING' && value !== 'SUCCEEDED' && value !== 'FAILED') throw fail('must be a refund status');
      return;
    case 'cancellationOutcome':
      if (value !== 'ACCEPTED' && value !== 'REJECTED' && value !== 'EXPIRED') throw fail('must be a cancellation outcome');
      return;
  }
}

export function renderNotification<K extends NotificationTemplateId>(
  templateId: K,
  params: NotificationTemplateParams[K],
): RenderedNotification {
  if (typeof templateId !== 'string' || !Object.prototype.hasOwnProperty.call(NOTIFICATION_TEMPLATES, templateId)) {
    throw new NotificationError('UNKNOWN_TEMPLATE', `unknown template ${String(templateId)}`);
  }
  const definition = NOTIFICATION_TEMPLATES[templateId] as unknown as NotificationTemplate<K>;
  if (typeof params !== 'object' || params === null) {
    throw new NotificationError('INVALID_PARAMS', 'params must be an object');
  }
  const declared = definition.params as Record<string, ParamKind>;
  const provided = params as Record<string, unknown>;
  // Undeclared params are rejected so private content cannot be smuggled into a message.
  for (const key of Object.keys(provided)) {
    if (!Object.prototype.hasOwnProperty.call(declared, key)) {
      throw new NotificationError('INVALID_PARAMS', `param ${key} is not declared by ${templateId}`);
    }
  }
  for (const [key, kind] of Object.entries(declared)) {
    validateParam(key, kind, provided[key]);
  }
  const linkPath = definition.linkPath(params);
  if (!LINK_PATTERN.test(linkPath) || linkPath.includes('//')) {
    throw new NotificationError('INVALID_PARAMS', 'rendered link must be an internal path without query');
  }
  return {
    templateId,
    category: definition.category,
    subject: definition.subject,
    body: definition.body(params),
    linkPath,
  };
}

// ---------------------------------------------------------------------------
// Sink
// ---------------------------------------------------------------------------

export interface OutboundNotification extends RenderedNotification {
  recipientId: string;
  channel: NotificationChannel;
  dedupeKey: string;
  semanticEventKey: string;
  attempt: number;
  createdAt: string;
}

export interface NotificationSink {
  readonly kind: string;
  deliver(message: OutboundNotification): Promise<{ messageId: string }>;
}

/** Stores messages in memory. Never sends email or performs network I/O. */
export class LocalNotificationSink implements NotificationSink {
  readonly kind = 'local';
  private readonly stored: (OutboundNotification & { messageId: string })[] = [];
  private failuresRemaining = 0;
  private sequence = 0;

  /** Makes the next `count` deliveries throw, to exercise retry paths. */
  failNext(count = 1): void {
    this.failuresRemaining += count;
  }

  async deliver(message: OutboundNotification): Promise<{ messageId: string }> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error('local sink simulated delivery failure');
    }
    this.sequence += 1;
    const messageId = `local_msg_${this.sequence}`;
    this.stored.push(Object.freeze({ ...message, messageId }));
    return { messageId };
  }

  messages(filter: { recipientId?: string; channel?: NotificationChannel } = {}): readonly (OutboundNotification & { messageId: string })[] {
    return this.stored.filter(
      (m) =>
        (filter.recipientId === undefined || m.recipientId === filter.recipientId) &&
        (filter.channel === undefined || m.channel === filter.channel),
    );
  }

  clear(): void {
    this.stored.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export interface RecipientPreferences {
  /** Marketing is opt-in. Defaults to false. */
  marketingOptIn: boolean;
}

export type NotificationDeliveryStatus = 'SENT' | 'DUPLICATE_SUPPRESSED' | 'SUPPRESSED_BY_PREFERENCE' | 'FAILED';

export interface ChannelOutcome {
  channel: NotificationChannel;
  dedupeKey: string;
  status: NotificationDeliveryStatus;
  attemptCount: number;
  messageId: string | null;
  error: string | null;
}

export interface NotificationAttempt {
  dedupeKey: string;
  recipientId: string;
  templateId: NotificationTemplateId;
  channel: NotificationChannel;
  attempt: number;
  status: 'SENT' | 'FAILED';
  error: string | null;
  at: string;
}

export interface NotificationRequest<K extends NotificationTemplateId = NotificationTemplateId> {
  recipientId: string;
  templateId: K;
  /** Stable business event id, e.g. `order:<id>:delivered:v3`. */
  semanticEventKey: string;
  params: NotificationTemplateParams[K];
  channels?: readonly NotificationChannel[];
}

export interface NotificationDispatcherOptions {
  sink: NotificationSink;
  now?: () => Date;
  preferences?: (recipientId: string) => RecipientPreferences | Promise<RecipientPreferences>;
  maxAttempts?: number;
}

interface DedupeClaim {
  state: 'SENDING' | 'SENT' | 'FAILED';
  payloadHash: string;
  attemptCount: number;
  messageId: string | null;
  lastError: string | null;
}

const RECIPIENT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SEMANTIC_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_.\-]{2,199}$/;

/** Hashed so dedupe keys stored in logs/DB carry no raw identifiers. */
export function notificationDedupeKey(recipientId: string, semanticEventKey: string, channel: NotificationChannel): string {
  return createHash('sha256').update(`${recipientId}\n${semanticEventKey}\n${channel}`).digest('hex');
}

function payloadHash(templateId: string, rendered: RenderedNotification): string {
  return createHash('sha256')
    .update(`${templateId}\n${rendered.subject}\n${rendered.body}\n${rendered.linkPath}`)
    .digest('hex');
}

export class NotificationDispatcher {
  private readonly sink: NotificationSink;
  private readonly now: () => Date;
  private readonly preferences: NotificationDispatcherOptions['preferences'];
  private readonly maxAttempts: number;
  private readonly claims = new Map<string, DedupeClaim>();
  private readonly attemptLog: NotificationAttempt[] = [];

  constructor(options: NotificationDispatcherOptions) {
    this.sink = options.sink;
    this.now = options.now ?? (() => new Date());
    this.preferences = options.preferences;
    this.maxAttempts = options.maxAttempts ?? 5;
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new NotificationError('INVALID_PARAMS', 'maxAttempts must be a positive integer');
    }
  }

  async dispatch<K extends NotificationTemplateId>(request: NotificationRequest<K>): Promise<ChannelOutcome[]> {
    if (typeof request.recipientId !== 'string' || !RECIPIENT_PATTERN.test(request.recipientId)) {
      throw new NotificationError('INVALID_RECIPIENT', 'recipientId must be an opaque id');
    }
    if (typeof request.semanticEventKey !== 'string' || !SEMANTIC_KEY_PATTERN.test(request.semanticEventKey)) {
      throw new NotificationError('INVALID_SEMANTIC_KEY', 'semanticEventKey must be 3-200 chars of [A-Za-z0-9:_.-]');
    }
    const rendered = renderNotification(request.templateId, request.params);
    const definition = NOTIFICATION_TEMPLATES[request.templateId] as NotificationTemplate;
    const channels = [...new Set(request.channels ?? definition.defaultChannels)];
    if (channels.length === 0) throw new NotificationError('CHANNEL_NOT_ALLOWED', 'at least one channel is required');
    for (const channel of channels) {
      if (!definition.allowedChannels.includes(channel)) {
        throw new NotificationError('CHANNEL_NOT_ALLOWED', `${channel} is not allowed for ${request.templateId}`);
      }
    }
    const hash = payloadHash(request.templateId, rendered);

    // Synchronous pre-flight: reject key reuse for a different payload before any claim.
    for (const channel of channels) {
      const claim = this.claims.get(notificationDedupeKey(request.recipientId, request.semanticEventKey, channel));
      if (claim && claim.payloadHash !== hash) {
        throw new NotificationError('DEDUPE_KEY_REUSED', 'semanticEventKey was already used with a different notification');
      }
    }

    // Claim every channel synchronously so concurrent duplicates observe SENDING.
    const work: { channel: NotificationChannel; key: string; claim: DedupeClaim | null; outcome: ChannelOutcome | null }[] = [];
    for (const channel of channels) {
      const key = notificationDedupeKey(request.recipientId, request.semanticEventKey, channel);
      const existing = this.claims.get(key);
      if (existing && (existing.state === 'SENT' || existing.state === 'SENDING')) {
        work.push({ channel, key, claim: null, outcome: this.outcome(channel, key, 'DUPLICATE_SUPPRESSED', existing) });
        continue;
      }
      if (existing && existing.attemptCount >= this.maxAttempts) {
        work.push({
          channel,
          key,
          claim: null,
          outcome: { ...this.outcome(channel, key, 'FAILED', existing), error: 'MAX_ATTEMPTS_EXCEEDED' },
        });
        continue;
      }
      const claim: DedupeClaim = existing ?? { state: 'SENDING', payloadHash: hash, attemptCount: 0, messageId: null, lastError: null };
      claim.state = 'SENDING';
      this.claims.set(key, claim);
      work.push({ channel, key, claim, outcome: null });
    }

    let prefs: RecipientPreferences | null = null;
    if (definition.category === 'marketing' && work.some((w) => w.claim)) {
      try {
        prefs = this.preferences ? await this.preferences(request.recipientId) : { marketingOptIn: false };
      } catch (error) {
        // Release claims so a later dispatch can retry; nothing was sent.
        for (const item of work) if (item.claim) this.releaseClaim(item.key, item.claim);
        throw error;
      }
    }

    const outcomes: ChannelOutcome[] = [];
    for (const item of work) {
      if (item.outcome) {
        outcomes.push(item.outcome);
        continue;
      }
      const claim = item.claim as DedupeClaim;
      if (definition.category === 'marketing' && !prefs?.marketingOptIn) {
        this.releaseClaim(item.key, claim);
        outcomes.push({
          channel: item.channel,
          dedupeKey: item.key,
          status: 'SUPPRESSED_BY_PREFERENCE',
          attemptCount: claim.attemptCount,
          messageId: null,
          error: null,
        });
        continue;
      }
      claim.attemptCount += 1;
      const at = this.now().toISOString();
      try {
        const { messageId } = await this.sink.deliver({
          ...rendered,
          recipientId: request.recipientId,
          channel: item.channel,
          dedupeKey: item.key,
          semanticEventKey: request.semanticEventKey,
          attempt: claim.attemptCount,
          createdAt: at,
        });
        claim.state = 'SENT';
        claim.messageId = messageId;
        claim.lastError = null;
        this.log(request, item, claim, 'SENT', null, at);
        outcomes.push(this.outcome(item.channel, item.key, 'SENT', claim));
      } catch (error) {
        claim.state = 'FAILED';
        claim.lastError = error instanceof Error ? error.message : 'delivery failed';
        this.log(request, item, claim, 'FAILED', claim.lastError, at);
        outcomes.push(this.outcome(item.channel, item.key, 'FAILED', claim));
      }
    }
    return outcomes;
  }

  attempts(): readonly NotificationAttempt[] {
    return [...this.attemptLog];
  }

  private releaseClaim(key: string, claim: DedupeClaim): void {
    if (claim.attemptCount === 0) this.claims.delete(key);
    else claim.state = 'FAILED';
  }

  private outcome(channel: NotificationChannel, key: string, status: NotificationDeliveryStatus, claim: DedupeClaim): ChannelOutcome {
    return {
      channel,
      dedupeKey: key,
      status,
      attemptCount: claim.attemptCount,
      messageId: claim.messageId,
      error: status === 'FAILED' ? claim.lastError : null,
    };
  }

  private log(
    request: NotificationRequest,
    item: { channel: NotificationChannel; key: string },
    claim: DedupeClaim,
    status: 'SENT' | 'FAILED',
    error: string | null,
    at: string,
  ): void {
    this.attemptLog.push({
      dedupeKey: item.key,
      recipientId: request.recipientId,
      templateId: request.templateId,
      channel: item.channel,
      attempt: claim.attemptCount,
      status,
      error,
      at,
    });
  }
}
