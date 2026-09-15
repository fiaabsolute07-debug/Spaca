/**
 * Payment provider contract + local-only MockPaymentProvider.
 *
 * Ownership: Claude (see docs/COLLABORATION.md). Types are self-contained on purpose to
 * avoid import races with shared contracts that the lead is still building.
 *
 * Non-negotiables encoded here:
 * - Platform fee is always 0 (`PLATFORM_FEE_BPS = 0`); any nonzero fee input is rejected.
 * - Money is `bigint` atomic units. JS numbers are rejected for amounts.
 * - Every mutating call takes a stable `operationId`. Same id + same payload replays the
 *   original response; same id + different payload is `IDEMPOTENCY_CONFLICT`.
 * - A timeout has outcome `UNKNOWN`: callers must look up / retry with the SAME operationId,
 *   never mint a new one.
 * - There is no `markPaid`. Funding only changes through provider-side facts, which the mock
 *   exposes as `simulate*` test-harness methods that must never be wired to a route.
 * - The adapter's in-memory journal imitates provider-side idempotency memory only. It is NOT
 *   the financial ledger; the lead's DB engine persists ProviderOperation records.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// Fee + money primitives
// ---------------------------------------------------------------------------

export const PLATFORM_FEE_BPS = 0 as const;
export const PLATFORM_FEE_ATOMIC: bigint = 0n;

/** Default ceiling for a single fiat operation in minor units (≈ 10 billion USD cents). */
export const DEFAULT_MAX_ATOMIC_AMOUNT: bigint = 1_000_000_000_000n;

export type ProviderMode = 'test' | 'live';
export type AtomicAmount = bigint;

/** Platform fee for any amount, any asset, any pricing mode. Always zero. */
export function platformFeeFor(amount: AtomicAmount): bigint {
  assertAtomicAmount(amount, { allowZero: true, max: null, field: 'amount' });
  return PLATFORM_FEE_ATOMIC;
}

export function assertZeroPlatformFee(fee: unknown, field = 'platformFee'): asserts fee is bigint {
  if (typeof fee !== 'bigint') {
    throw new ProviderError('INVALID_AMOUNT', `${field} must be a bigint (0n)`, { details: { field } });
  }
  if (fee !== PLATFORM_FEE_ATOMIC) {
    throw new ProviderError('NONZERO_PLATFORM_FEE', `${field} must be 0; platform fee is always 0%`, {
      details: { field, received: fee.toString() },
    });
  }
}

export interface AtomicAmountRules {
  allowZero?: boolean;
  /** `null` disables the upper bound. */
  max?: bigint | null;
  field?: string;
}

export function assertAtomicAmount(value: unknown, rules: AtomicAmountRules = {}): asserts value is bigint {
  const field = rules.field ?? 'amount';
  if (typeof value !== 'bigint') {
    throw new ProviderError('INVALID_AMOUNT', `${field} must be a bigint in atomic units`, { details: { field } });
  }
  const min = rules.allowZero ? 0n : 1n;
  if (value < min) {
    throw new ProviderError('INVALID_AMOUNT', `${field} must be ${rules.allowZero ? '>= 0' : '> 0'}`, {
      details: { field, received: value.toString() },
    });
  }
  const max = rules.max === undefined ? DEFAULT_MAX_ATOMIC_AMOUNT : rules.max;
  if (max !== null && value > max) {
    throw new ProviderError('INVALID_AMOUNT', `${field} exceeds maximum ${max.toString()}`, {
      details: { field, received: value.toString() },
    });
  }
}

/** Parses a canonical non-negative integer string (e.g. from JSON/DB) into bigint. No floats, no exponents. */
export function parseAtomicAmount(value: unknown, rules: AtomicAmountRules = {}): bigint {
  const field = rules.field ?? 'amount';
  let parsed: bigint;
  if (typeof value === 'bigint') {
    parsed = value;
  } else if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) {
    parsed = BigInt(value);
  } else {
    throw new ProviderError('INVALID_AMOUNT', `${field} must be a canonical integer string or bigint`, {
      details: { field },
    });
  }
  assertAtomicAmount(parsed, rules);
  return parsed;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ProviderErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_AMOUNT'
  | 'INVALID_OPERATION_ID'
  | 'NONZERO_PLATFORM_FEE'
  | 'CURRENCY_MISMATCH'
  | 'PAYEE_MISMATCH'
  | 'UNSUPPORTED_CAPABILITY'
  | 'PAYEE_NOT_CAPABLE'
  /** The payee's balance cannot cover a transfer reversal. Nothing moved. */
  | 'INSUFFICIENT_BALANCE'
  | 'IDEMPOTENCY_CONFLICT'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'RELEASE_EXCEEDS_AVAILABLE'
  | 'REFUND_EXCEEDS_REFUNDABLE'
  | 'WEBHOOK_SIGNATURE_INVALID'
  | 'WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE'
  | 'WEBHOOK_PAYLOAD_INVALID'
  | 'WEBHOOK_CONTEXT_MISMATCH'
  | 'LIVE_MODE_NOT_SUPPORTED';

/**
 * - `NOT_APPLIED`: the provider definitely did not apply an effect for this attempt.
 * - `UNKNOWN`: the effect may or may not exist. Look up / retry with the same operationId.
 */
export type ProviderErrorOutcome = 'NOT_APPLIED' | 'UNKNOWN';

const RETRYABLE_CODES: ReadonlySet<ProviderErrorCode> = new Set(['PROVIDER_TIMEOUT', 'PROVIDER_UNAVAILABLE']);
/**
 * The mock provider is shared on globalThis, but Next dev bundles this module once per route, so an error it throws can
 * come from another copy of this class. A registry symbol identifies provider errors from every copy.
 */
const PROVIDER_ERROR_BRAND = Symbol.for('spaca.payments.ProviderError');

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly outcome: ProviderErrorOutcome;
  readonly operationId: string | null;
  readonly details: Readonly<Record<string, string>>;

  constructor(
    code: ProviderErrorCode,
    message: string,
    options: {
      outcome?: ProviderErrorOutcome;
      operationId?: string | null;
      details?: Record<string, string>;
    } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
    Object.defineProperty(this, PROVIDER_ERROR_BRAND, { value: true });
    this.code = code;
    this.retryable = RETRYABLE_CODES.has(code);
    this.outcome = options.outcome ?? (code === 'PROVIDER_TIMEOUT' ? 'UNKNOWN' : 'NOT_APPLIED');
    this.operationId = options.operationId ?? null;
    this.details = Object.freeze({ ...(options.details ?? {}) });
  }
}

export function isProviderError(error: unknown, code?: ProviderErrorCode): error is ProviderError {
  const branded = error instanceof ProviderError || (error instanceof Error && (error as unknown as Record<symbol, unknown>)[PROVIDER_ERROR_BRAND] === true);
  return branded && (code === undefined || (error as ProviderError).code === code);
}

// ---------------------------------------------------------------------------
// Contract DTOs
// ---------------------------------------------------------------------------

export interface MerchantAndPayeeContext {
  merchantAccountId: string;
  payeeAccountId?: string;
  currency?: string;
}

export interface Capabilities {
  provider: string;
  mode: ProviderMode;
  platformFeeBps: typeof PLATFORM_FEE_BPS;
  delayedSettlement: boolean;
  partialRefund: boolean;
  /** True only for a real conditional-escrow rail. Delayed transfers are NOT escrow. */
  conditionalEscrow: boolean;
  bankPayout: boolean;
  walletPayout: boolean;
  multiassetRewardPool: boolean;
  supportedCurrencies: readonly string[];
  supportedCountries: readonly string[];
  /** Maximum days funds can be held before release/refund; `null` when not applicable. */
  maxHoldDays: number | null;
  /** `null` when no payee was supplied in the context. */
  payeePayoutsEnabled: boolean | null;
  currencySupported: boolean | null;
}

/** RETURNED: a settled bank transfer that the buyer's bank later sent back. */
export type FundingStatusCode = 'REQUIRES_ACTION' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED' | 'RETURNED';
export type FundingMethod = 'CARD' | 'BANK_TRANSFER';
export type TransferStatusCode = 'PENDING' | 'SUCCEEDED' | 'FAILED';
/** Card payment disputes (chargebacks) raised by the buyer's bank against a captured funding. */
export type DisputeStatusCode = 'OPEN' | 'WON' | 'LOST';
export type RefundReason = 'BUYER_CANCELED_BEFORE_WORK' | 'MUTUAL_CANCELLATION' | 'OPERATOR_RESOLUTION' | 'DUPLICATE' | 'OTHER';

export interface FundingInput {
  orderId: string;
  buyerId: string;
  payeeAccountId: string;
  amount: AtomicAmount;
  currency: string;
  /** Snapshot of the order fee. Must be 0n. */
  platformFee: AtomicAmount;
  description?: string;
  /** Omitted: card. BANK_TRANSFER: the buyer pays by bank transfer; the provider confirms asynchronously, often days later. */
  method?: 'BANK_TRANSFER';
}

export interface FundingIntent {
  reference: string;
  operationId: string;
  orderId: string;
  payeeAccountId: string;
  status: FundingStatusCode;
  amount: AtomicAmount;
  currency: string;
  platformFee: AtomicAmount;
  /** The buyer confirms with the provider (hosted flow) or sends a bank transfer. Browser redirects never mark funding paid. */
  nextAction: 'BUYER_CONFIRMS_WITH_PROVIDER' | 'BUYER_SENDS_BANK_TRANSFER';
  method: FundingMethod;
  createdAt: string;
}

export interface FundingStatus {
  reference: string;
  orderId: string;
  payeeAccountId: string;
  status: FundingStatusCode;
  amount: AtomicAmount;
  currency: string;
  platformFee: AtomicAmount;
  /** Actual provider processing cost from provider evidence; `null` until known. */
  providerFee: AtomicAmount | null;
  releasedSucceeded: AtomicAmount;
  releasePending: AtomicAmount;
  refundedSucceeded: AtomicAmount;
  refundPending: AtomicAmount;
  /** amount - released(pending+succeeded) - refunded(pending+succeeded); 0 unless SUCCEEDED. */
  availablePrincipal: AtomicAmount;
  /** True only when confirmed (SUCCEEDED) refunds equal the funded amount. */
  fullyRefunded: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CancelResult {
  reference: string;
  operationId: string;
  status: 'CANCELED';
  alreadyCanceled: boolean;
  canceledAt: string;
}

export interface ReleaseInput {
  fundingReference: string;
  orderId: string;
  payeeAccountId: string;
  amount: AtomicAmount;
  currency: string;
  platformFee: AtomicAmount;
}

export interface ReleaseResult {
  reference: string;
  operationId: string;
  fundingReference: string;
  orderId: string;
  payeeAccountId: string;
  amount: AtomicAmount;
  currency: string;
  platformFee: AtomicAmount;
  status: TransferStatusCode;
  createdAt: string;
}

export interface ReleaseStatus extends ReleaseResult {
  updatedAt: string;
  failureCode: string | null;
}

export interface RefundInput {
  fundingReference: string;
  orderId: string;
  amount: AtomicAmount;
  currency: string;
  reason: RefundReason;
  /**
   * PLATFORM_BALANCE refunds a charge whose principal was already transferred, from the platform's own balance (an
   * explicit, operator-approved loss). Omitted: the refund must fit the principal still held for the order.
   */
  source?: 'PLATFORM_BALANCE';
}

/** Pulls money back from a creator transfer (a transfer reversal). Fails without moving money if the payee lacks balance. */
export interface ReversalInput {
  releaseReference: string;
  orderId: string;
  amount: AtomicAmount;
  currency: string;
}

export interface ReversalResult {
  reference: string;
  operationId: string;
  releaseReference: string;
  fundingReference: string;
  orderId: string;
  amount: AtomicAmount;
  currency: string;
  status: TransferStatusCode;
  createdAt: string;
}

export interface RefundResult {
  reference: string;
  operationId: string;
  fundingReference: string;
  orderId: string;
  amount: AtomicAmount;
  currency: string;
  reason: RefundReason;
  status: TransferStatusCode;
  createdAt: string;
}

export interface RefundStatus extends RefundResult {
  updatedAt: string;
  failureCode: string | null;
}

export type OperationKind = 'funding.create' | 'funding.cancel' | 'release.create' | 'refund.create' | 'reversal.create';

/** Provider-side view of an operation id, used to recover after an UNKNOWN outcome. */
export interface OperationLookup {
  operationId: string;
  kind: OperationKind;
  requestHash: string;
  state: 'APPLIED' | 'NOT_APPLIED';
  reference: string | null;
  attemptCount: number;
  lastErrorCode: ProviderErrorCode | null;
}

/**
 * Suggested shape for the lead's durable `ProviderOperation` journal (master §8.4).
 * Not persisted by this module.
 */
export interface ProviderOperationRecord {
  operationId: string;
  kind: OperationKind;
  inputHash: string;
  status: 'PENDING' | 'APPLIED' | 'UNKNOWN' | 'REJECTED';
  providerRef: string | null;
  attemptCount: number;
  nextRetryAt: string | null;
  lastError: string | null;
}

export type WebhookEventType =
  | 'funding.processing'
  | 'funding.succeeded'
  | 'funding.failed'
  | 'funding.canceled'
  /** The actual provider cost of a captured funding changed or became known after capture. */
  | 'funding.fee_updated'
  | 'funding.returned'
  | 'release.pending'
  | 'release.succeeded'
  | 'release.failed'
  | 'refund.pending'
  | 'refund.succeeded'
  | 'refund.failed'
  | 'reversal.succeeded'
  | 'dispute.opened'
  | 'dispute.won'
  | 'dispute.lost';

export interface VerifiedEvent {
  eventId: string;
  type: WebhookEventType;
  mode: ProviderMode;
  accountId: string;
  createdAt: string;
  objectType: 'funding' | 'release' | 'refund' | 'reversal' | 'dispute';
  reference: string;
  /** Funding reference for release/refund/dispute objects; equals `reference` for funding. */
  fundingReference: string;
  operationId: string;
  orderId: string;
  status: FundingStatusCode | TransferStatusCode | DisputeStatusCode;
  amount: AtomicAmount;
  currency: string;
  providerFee: AtomicAmount | null;
}

export interface PaymentProvider {
  readonly name: string;
  readonly mode: ProviderMode;
  capabilities(context: MerchantAndPayeeContext): Promise<Capabilities>;
  createFundingIntent(input: FundingInput, operationId: string): Promise<FundingIntent>;
  getFundingStatus(reference: string): Promise<FundingStatus>;
  cancelFunding(reference: string, operationId: string): Promise<CancelResult>;
  verifyWebhook(rawBody: Uint8Array, headers: Headers): Promise<VerifiedEvent>;
  releaseToCreator(input: ReleaseInput, operationId: string): Promise<ReleaseResult>;
  getReleaseStatus(reference: string): Promise<ReleaseStatus>;
  refund(input: RefundInput, operationId: string): Promise<RefundResult>;
  reverseTransfer(input: ReversalInput, operationId: string): Promise<ReversalResult>;
  getRefundStatus(reference: string): Promise<RefundStatus>;
  /** Recovery after timeout: resolves whether the provider applied an operation id. `null` = never seen. */
  lookupOperation(operationId: string): Promise<OperationLookup | null>;
}

// ---------------------------------------------------------------------------
// Idempotency helpers
// ---------------------------------------------------------------------------

const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_.-]{7,254}$/;

export function assertOperationId(operationId: unknown): asserts operationId is string {
  if (typeof operationId !== 'string' || !OPERATION_ID_PATTERN.test(operationId)) {
    throw new ProviderError(
      'INVALID_OPERATION_ID',
      'operationId must be 8-255 chars of [A-Za-z0-9:_.-] starting with an alphanumeric',
    );
  }
}

/**
 * Deterministic, type-tagged canonical encoding used for request hashing.
 * Object keys are sorted; `undefined` object properties are omitted; bigint renders as `123n`
 * so it can never collide with the number 123 or the string "123".
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'bigint':
      return `${value.toString()}n`;
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new ProviderError('INVALID_INPUT', 'non-finite numbers cannot be hashed');
      }
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value
          .map((item) => {
            if (item === undefined) throw new ProviderError('INVALID_INPUT', 'arrays cannot contain undefined');
            return canonicalize(item);
          })
          .join(',')}]`;
      }
      if (value instanceof Date) return JSON.stringify(value.toISOString());
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new ProviderError('INVALID_INPUT', 'only plain objects can be hashed');
      }
      const record = value as Record<string, unknown>;
      const entries = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
      return `{${entries.join(',')}}`;
    }
    default:
      throw new ProviderError('INVALID_INPUT', `cannot hash value of type ${typeof value}`);
  }
}

/** SHA-256 hex over `kind` + canonical payload. The operationId itself is not part of the hash. */
export function computeRequestHash(kind: OperationKind, payload: unknown): string {
  return createHash('sha256').update(kind).update('\n').update(canonicalize(payload)).digest('hex');
}

// ---------------------------------------------------------------------------
// Webhook signing (mock scheme, Stripe-like): header `t=<unix>,v1=<hex hmac-sha256>`
// signed payload = `${t}.` bytes followed by the exact raw body bytes.
// ---------------------------------------------------------------------------

export const MOCK_SIGNATURE_HEADER = 'x-mock-signature';
export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;
const MIN_WEBHOOK_SECRET_LENGTH = 16;

function hmacSha256(secret: string, timestamp: number, rawBody: Uint8Array): Buffer {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest();
}

export function signMockWebhook(rawBody: Uint8Array, secret: string, timestampSeconds: number): string {
  if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds < 0) {
    throw new ProviderError('INVALID_INPUT', 'timestampSeconds must be a non-negative safe integer');
  }
  if (secret.length < MIN_WEBHOOK_SECRET_LENGTH) {
    throw new ProviderError('INVALID_INPUT', `webhook secret must be at least ${MIN_WEBHOOK_SECRET_LENGTH} chars`);
  }
  return `t=${timestampSeconds},v1=${hmacSha256(secret, timestampSeconds, rawBody).toString('hex')}`;
}

export interface VerifySignatureInput {
  rawBody: Uint8Array;
  signatureHeader: string | null;
  /** Accepts any of these (secret rotation). */
  secrets: readonly string[];
  nowSeconds: number;
  toleranceSeconds?: number;
}

/** Throws `WEBHOOK_SIGNATURE_INVALID` or `WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE`. Returns the signed timestamp. */
export function verifyMockWebhookSignature(input: VerifySignatureInput): { timestamp: number } {
  const invalid = (reason: string) =>
    new ProviderError('WEBHOOK_SIGNATURE_INVALID', 'webhook signature verification failed', { details: { reason } });

  if (!(input.rawBody instanceof Uint8Array)) throw invalid('raw body must be bytes');
  if (input.secrets.length === 0) throw invalid('no secrets configured');
  const header = input.signatureHeader;
  if (!header || header.length > 2048) throw invalid('missing signature header');

  let timestamp: number | null = null;
  const candidates: Buffer[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) throw invalid('malformed header');
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') {
      if (timestamp !== null || !/^[0-9]{1,12}$/.test(value)) throw invalid('malformed timestamp');
      timestamp = Number(value);
    } else if (key === 'v1') {
      // Only well-formed 32-byte digests are compared; others are ignored.
      if (/^[0-9a-f]{64}$/.test(value)) candidates.push(Buffer.from(value, 'hex'));
    }
  }
  if (timestamp === null) throw invalid('missing timestamp');
  if (candidates.length === 0) throw invalid('missing v1 signature');

  let matched = false;
  for (const secret of input.secrets) {
    const expected = hmacSha256(secret, timestamp, input.rawBody);
    for (const candidate of candidates) {
      // Lengths are equal by construction (32 bytes); compare without short-circuit.
      if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) matched = true;
    }
  }
  if (!matched) throw invalid('no matching signature');

  const tolerance = input.toleranceSeconds ?? DEFAULT_WEBHOOK_TOLERANCE_SECONDS;
  if (Math.abs(input.nowSeconds - timestamp) > tolerance) {
    throw new ProviderError('WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE', 'webhook timestamp outside tolerance', {
      details: { timestamp: String(timestamp) },
    });
  }
  return { timestamp };
}

// ---------------------------------------------------------------------------
// MockPaymentProvider
// ---------------------------------------------------------------------------

export type FailureEffect =
  /** Provider applies the effect, then the HTTP response is lost. Outcome UNKNOWN. */
  | 'ACCEPT_THEN_TIMEOUT'
  /** Request never reaches the provider, but the caller cannot tell. Outcome UNKNOWN. */
  | 'TIMEOUT_BEFORE_ACCEPT'
  /** Provider rejects with 503 before acceptance. Outcome NOT_APPLIED. */
  | 'UNAVAILABLE';

export interface FailureInjectionRule {
  kind: OperationKind;
  /** When omitted, matches any operation of `kind`. */
  operationId?: string;
  effect: FailureEffect;
  /** How many matching attempts this rule affects (default 1). Rules are consumed in order. */
  times?: number;
}

export interface MockPaymentProviderOptions {
  /** Only 'test' is accepted. The mock refuses to exist in live mode. */
  mode?: ProviderMode;
  accountId?: string;
  /** First secret signs outgoing events; all secrets are accepted when verifying. */
  webhookSecrets: readonly string[];
  now?: () => Date;
  supportedCurrencies?: readonly string[];
  maxAtomicAmount?: bigint;
  partialRefund?: boolean;
  payeesWithoutPayouts?: readonly string[];
  /** Whether buyers may fund by bank transfer on this account (default false). Bank payouts to creators do not imply it. */
  bankTransferFunding?: boolean;
  /** Available balance per payee account for transfer reversals; payees not listed can always be reversed. */
  payeeBalances?: Readonly<Record<string, bigint>>;
  /** 'immediate' settles to SUCCEEDED on creation; 'pending' waits for simulate*Outcome. */
  releaseSettlement?: 'immediate' | 'pending';
  refundSettlement?: 'immediate' | 'pending';
  failureInjection?: readonly FailureInjectionRule[];
  webhookToleranceSeconds?: number;
}

export interface WebhookDelivery {
  eventId: string;
  type: WebhookEventType;
  rawBody: Uint8Array;
  headers: Headers;
}

export interface SimulatedFundingOutcome {
  status: 'PROCESSING' | 'SUCCEEDED' | 'FAILED';
  /** Actual provider cost fixture; only allowed with SUCCEEDED. */
  providerFee?: bigint;
}

interface FundingRecord {
  reference: string;
  operationId: string;
  method: FundingMethod;
  orderId: string;
  buyerId: string;
  payeeAccountId: string;
  amount: bigint;
  currency: string;
  status: FundingStatusCode;
  providerFee: bigint | null;
  createdAt: string;
  updatedAt: string;
}

interface TransferRecord {
  kind: 'release' | 'refund' | 'reversal';
  /** Refunds only: PLATFORM_BALANCE refunds do not draw on the order's principal. */
  source: 'PRINCIPAL' | 'PLATFORM_BALANCE';
  reference: string;
  operationId: string;
  fundingReference: string;
  orderId: string;
  payeeAccountId: string | null;
  reason: RefundReason | null;
  amount: bigint;
  currency: string;
  status: TransferStatusCode;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DisputeRecord {
  reference: string;
  fundingReference: string;
  orderId: string;
  amount: bigint;
  currency: string;
  status: DisputeStatusCode;
}

interface JournalEntry {
  operationId: string;
  kind: OperationKind;
  requestHash: string;
  state: 'APPLIED' | 'NOT_APPLIED';
  reference: string | null;
  result: unknown;
  attemptCount: number;
  lastErrorCode: ProviderErrorCode | null;
}

interface StoredEvent {
  eventId: string;
  type: WebhookEventType;
  rawBody: Uint8Array;
}

const CURRENCY_PATTERN = /^[A-Z][A-Z0-9]{2,9}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,254}$/;
const REFUND_REASONS: ReadonlySet<string> = new Set([
  'BUYER_CANCELED_BEFORE_WORK',
  'MUTUAL_CANCELLATION',
  'OPERATOR_RESOLUTION',
  'DUPLICATE',
  'OTHER',
]);
const WEBHOOK_EVENT_TYPES: ReadonlySet<string> = new Set([
  'funding.processing',
  'funding.succeeded',
  'funding.failed',
  'funding.canceled',
  'funding.fee_updated',
  'funding.returned',
  'release.pending',
  'release.succeeded',
  'release.failed',
  'refund.pending',
  'refund.succeeded',
  'refund.failed',
  'reversal.succeeded',
  'dispute.opened',
  'dispute.won',
  'dispute.lost',
]);
const FUNDING_STATUSES: ReadonlySet<string> = new Set(['REQUIRES_ACTION', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELED', 'RETURNED']);
const TRANSFER_STATUSES: ReadonlySet<string> = new Set(['PENDING', 'SUCCEEDED', 'FAILED']);
const DISPUTE_STATUSES: ReadonlySet<string> = new Set(['OPEN', 'WON', 'LOST']);

function assertId(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new ProviderError('INVALID_INPUT', `${field} must be a non-empty identifier`, { details: { field } });
  }
}

function assertCurrencyCode(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !CURRENCY_PATTERN.test(value)) {
    throw new ProviderError('INVALID_INPUT', 'currency must be an upper-case asset code', {
      details: { field: 'currency' },
    });
  }
}

export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';
  readonly mode: ProviderMode = 'test';
  readonly accountId: string;

  private readonly secrets: readonly string[];
  private readonly now: () => Date;
  private readonly currencies: readonly string[];
  private readonly maxAmount: bigint;
  private readonly partialRefund: boolean;
  private readonly payeesWithoutPayouts: ReadonlySet<string>;
  private readonly bankTransferFunding: boolean;
  private readonly payeeBalances: Map<string, bigint>;
  private readonly releaseSettlement: 'immediate' | 'pending';
  private readonly refundSettlement: 'immediate' | 'pending';
  private readonly failureRules: { rule: FailureInjectionRule; remaining: number }[];
  private readonly toleranceSeconds: number;

  private readonly journal = new Map<string, JournalEntry>();
  private readonly fundings = new Map<string, FundingRecord>();
  private readonly transfers = new Map<string, TransferRecord>();
  private readonly disputes = new Map<string, DisputeRecord>();
  private readonly events: StoredEvent[] = [];
  private undelivered: StoredEvent[] = [];
  private eventSequence = 0;
  /** Event ids must stay unique across instances/restarts, or inbox dedupe would drop new facts. */
  private readonly eventNonce = randomBytes(16).toString('hex');

  constructor(options: MockPaymentProviderOptions) {
    if (options.mode !== undefined && options.mode !== 'test') {
      throw new ProviderError('LIVE_MODE_NOT_SUPPORTED', 'MockPaymentProvider is local/test only');
    }
    if (options.webhookSecrets.length === 0 || options.webhookSecrets.some((s) => s.length < MIN_WEBHOOK_SECRET_LENGTH)) {
      throw new ProviderError(
        'INVALID_INPUT',
        `webhookSecrets must contain at least one secret of ${MIN_WEBHOOK_SECRET_LENGTH}+ chars`,
      );
    }
    this.accountId = options.accountId ?? 'acct_mock_local';
    assertId(this.accountId, 'accountId');
    this.secrets = [...options.webhookSecrets];
    this.now = options.now ?? (() => new Date());
    this.currencies = [...(options.supportedCurrencies ?? ['USD'])];
    this.currencies.forEach((c) => assertCurrencyCode(c));
    this.maxAmount = options.maxAtomicAmount ?? DEFAULT_MAX_ATOMIC_AMOUNT;
    this.partialRefund = options.partialRefund ?? true;
    this.payeesWithoutPayouts = new Set(options.payeesWithoutPayouts ?? []);
    this.bankTransferFunding = options.bankTransferFunding === true;
    this.payeeBalances = new Map(Object.entries(options.payeeBalances ?? {}));
    this.releaseSettlement = options.releaseSettlement ?? 'immediate';
    this.refundSettlement = options.refundSettlement ?? 'immediate';
    this.failureRules = (options.failureInjection ?? []).map((rule) => ({ rule: { ...rule }, remaining: rule.times ?? 1 }));
    this.toleranceSeconds = options.webhookToleranceSeconds ?? DEFAULT_WEBHOOK_TOLERANCE_SECONDS;
  }

  // ---- contract --------------------------------------------------------------------------

  async capabilities(context: MerchantAndPayeeContext): Promise<Capabilities> {
    assertId(context.merchantAccountId, 'merchantAccountId');
    if (context.merchantAccountId !== this.accountId) {
      throw new ProviderError('INVALID_INPUT', 'merchant account does not belong to this provider instance');
    }
    if (context.payeeAccountId !== undefined) assertId(context.payeeAccountId, 'payeeAccountId');
    if (context.currency !== undefined) assertCurrencyCode(context.currency);
    return {
      provider: this.name,
      mode: this.mode,
      platformFeeBps: PLATFORM_FEE_BPS,
      delayedSettlement: true,
      partialRefund: this.partialRefund,
      conditionalEscrow: false,
      bankPayout: true,
      walletPayout: false,
      multiassetRewardPool: false,
      supportedCurrencies: [...this.currencies],
      supportedCountries: ['ZZ'],
      maxHoldDays: 90,
      payeePayoutsEnabled:
        context.payeeAccountId === undefined ? null : !this.payeesWithoutPayouts.has(context.payeeAccountId),
      currencySupported: context.currency === undefined ? null : this.currencies.includes(context.currency),
    };
  }

  async createFundingIntent(input: FundingInput, operationId: string): Promise<FundingIntent> {
    assertOperationId(operationId);
    assertId(input.orderId, 'orderId');
    assertId(input.buyerId, 'buyerId');
    assertId(input.payeeAccountId, 'payeeAccountId');
    assertAtomicAmount(input.amount, { max: this.maxAmount });
    this.assertSupportedCurrency(input.currency);
    assertZeroPlatformFee(input.platformFee);
    if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 500)) {
      throw new ProviderError('INVALID_INPUT', 'description must be a string of at most 500 chars');
    }
    if (input.method !== undefined && input.method !== 'BANK_TRANSFER') throw new ProviderError('INVALID_INPUT', 'method must be BANK_TRANSFER when given');
    if (input.method === 'BANK_TRANSFER' && !this.bankTransferFunding) {
      throw new ProviderError('UNSUPPORTED_CAPABILITY', 'bank transfer funding is not enabled for this account', { details: { method: 'BANK_TRANSFER' } });
    }

    const payload = {
      orderId: input.orderId,
      buyerId: input.buyerId,
      payeeAccountId: input.payeeAccountId,
      amount: input.amount,
      currency: input.currency,
      platformFee: input.platformFee,
      description: input.description,
      method: input.method,
    };
    return this.runIdempotent('funding.create', operationId, payload, () => {
      const at = this.timestamp();
      const record: FundingRecord = {
        reference: this.referenceFor('fund', operationId),
        operationId,
        method: input.method ?? 'CARD',
        orderId: input.orderId,
        buyerId: input.buyerId,
        payeeAccountId: input.payeeAccountId,
        amount: input.amount,
        currency: input.currency,
        status: 'REQUIRES_ACTION',
        providerFee: null,
        createdAt: at,
        updatedAt: at,
      };
      this.fundings.set(record.reference, record);
      const result: FundingIntent = {
        reference: record.reference,
        operationId,
        orderId: record.orderId,
        payeeAccountId: record.payeeAccountId,
        status: record.status,
        amount: record.amount,
        currency: record.currency,
        platformFee: PLATFORM_FEE_ATOMIC,
        nextAction: record.method === 'BANK_TRANSFER' ? 'BUYER_SENDS_BANK_TRANSFER' : 'BUYER_CONFIRMS_WITH_PROVIDER',
        method: record.method,
        createdAt: at,
      };
      return { reference: record.reference, result };
    });
  }

  async getFundingStatus(reference: string): Promise<FundingStatus> {
    return this.fundingSnapshot(this.requireFunding(reference));
  }

  async cancelFunding(reference: string, operationId: string): Promise<CancelResult> {
    assertOperationId(operationId);
    assertId(reference, 'reference');
    return this.runIdempotent<CancelResult>('funding.cancel', operationId, { reference }, () => {
      const funding = this.requireFunding(reference);
      const at = this.timestamp();
      if (funding.status === 'CANCELED') {
        return {
          reference,
          result: { reference, operationId, status: 'CANCELED', alreadyCanceled: true, canceledAt: funding.updatedAt },
        };
      }
      // A bank transfer the buyer already sent cannot be called back; the provider settles or fails it.
      if (funding.status !== 'REQUIRES_ACTION' && !(funding.status === 'PROCESSING' && funding.method === 'CARD')) {
        throw new ProviderError('INVALID_STATE', `cannot cancel funding in status ${funding.status}; use refund`, {
          operationId,
          details: { status: funding.status },
        });
      }
      funding.status = 'CANCELED';
      funding.updatedAt = at;
      this.emitFundingEvent('funding.canceled', funding);
      return {
        reference,
        result: { reference, operationId, status: 'CANCELED', alreadyCanceled: false, canceledAt: at },
      };
    });
  }

  async releaseToCreator(input: ReleaseInput, operationId: string): Promise<ReleaseResult> {
    assertOperationId(operationId);
    assertId(input.fundingReference, 'fundingReference');
    assertId(input.orderId, 'orderId');
    assertId(input.payeeAccountId, 'payeeAccountId');
    assertAtomicAmount(input.amount, { max: this.maxAmount });
    assertCurrencyCode(input.currency);
    assertZeroPlatformFee(input.platformFee);

    const payload = {
      fundingReference: input.fundingReference,
      orderId: input.orderId,
      payeeAccountId: input.payeeAccountId,
      amount: input.amount,
      currency: input.currency,
      platformFee: input.platformFee,
    };
    return this.runIdempotent('release.create', operationId, payload, () => {
      const funding = this.requireFunding(input.fundingReference);
      this.assertTransferAgainst(funding, input.orderId, input.currency, operationId);
      if (funding.payeeAccountId !== input.payeeAccountId) {
        throw new ProviderError('PAYEE_MISMATCH', 'payee does not match the funded payee', { operationId });
      }
      if (this.payeesWithoutPayouts.has(input.payeeAccountId)) {
        throw new ProviderError('PAYEE_NOT_CAPABLE', 'payee account cannot receive transfers yet', { operationId });
      }
      const available = this.availablePrincipal(funding);
      if (input.amount > available) {
        throw new ProviderError('RELEASE_EXCEEDS_AVAILABLE', 'release exceeds available principal', {
          operationId,
          details: { requested: input.amount.toString(), available: available.toString() },
        });
      }
      const record = this.createTransfer('release', operationId, funding, input.amount, input.payeeAccountId, null);
      const result: ReleaseResult = {
        reference: record.reference,
        operationId,
        fundingReference: funding.reference,
        orderId: funding.orderId,
        payeeAccountId: input.payeeAccountId,
        amount: record.amount,
        currency: record.currency,
        platformFee: PLATFORM_FEE_ATOMIC,
        status: record.status,
        createdAt: record.createdAt,
      };
      return { reference: record.reference, result };
    });
  }

  async getReleaseStatus(reference: string): Promise<ReleaseStatus> {
    const record = this.requireTransfer(reference, 'release');
    return {
      reference: record.reference,
      operationId: record.operationId,
      fundingReference: record.fundingReference,
      orderId: record.orderId,
      payeeAccountId: record.payeeAccountId ?? '',
      amount: record.amount,
      currency: record.currency,
      platformFee: PLATFORM_FEE_ATOMIC,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      failureCode: record.failureCode,
    };
  }

  async refund(input: RefundInput, operationId: string): Promise<RefundResult> {
    assertOperationId(operationId);
    assertId(input.fundingReference, 'fundingReference');
    assertId(input.orderId, 'orderId');
    assertAtomicAmount(input.amount, { max: this.maxAmount });
    assertCurrencyCode(input.currency);
    if (typeof input.reason !== 'string' || !REFUND_REASONS.has(input.reason)) {
      throw new ProviderError('INVALID_INPUT', 'reason must be a known RefundReason');
    }
    if (input.source !== undefined && input.source !== 'PLATFORM_BALANCE') {
      throw new ProviderError('INVALID_INPUT', 'source must be PLATFORM_BALANCE when given');
    }

    const payload = {
      fundingReference: input.fundingReference,
      orderId: input.orderId,
      amount: input.amount,
      currency: input.currency,
      reason: input.reason,
      source: input.source,
    };
    return this.runIdempotent('refund.create', operationId, payload, () => {
      const funding = this.requireFunding(input.fundingReference);
      this.assertTransferAgainst(funding, input.orderId, input.currency, operationId);
      if (!this.partialRefund && input.amount !== funding.amount && input.source === undefined) {
        throw new ProviderError('UNSUPPORTED_CAPABILITY', 'partial refunds are not supported', { operationId });
      }
      // A charge can never be refunded beyond what was captured, whichever balance pays for it.
      const refundable = input.source === 'PLATFORM_BALANCE' ? funding.amount - this.refundedTotal(funding) : this.availablePrincipal(funding);
      if (input.amount > refundable) {
        throw new ProviderError('REFUND_EXCEEDS_REFUNDABLE', 'refund exceeds refundable principal', {
          operationId,
          details: { requested: input.amount.toString(), refundable: refundable.toString() },
        });
      }
      const record = this.createTransfer('refund', operationId, funding, input.amount, null, input.reason, input.source ?? 'PRINCIPAL');
      const result: RefundResult = {
        reference: record.reference,
        operationId,
        fundingReference: funding.reference,
        orderId: funding.orderId,
        amount: record.amount,
        currency: record.currency,
        reason: input.reason,
        status: record.status,
        createdAt: record.createdAt,
      };
      return { reference: record.reference, result };
    });
  }

  async reverseTransfer(input: ReversalInput, operationId: string): Promise<ReversalResult> {
    assertOperationId(operationId);
    assertId(input.releaseReference, 'releaseReference');
    assertId(input.orderId, 'orderId');
    assertAtomicAmount(input.amount, { max: this.maxAmount });
    assertCurrencyCode(input.currency);
    const payload = { releaseReference: input.releaseReference, orderId: input.orderId, amount: input.amount, currency: input.currency };
    return this.runIdempotent('reversal.create', operationId, payload, () => {
      const release = this.requireTransfer(input.releaseReference, 'release');
      if (release.status !== 'SUCCEEDED') throw new ProviderError('INVALID_STATE', `release is ${release.status}`, { operationId });
      if (release.orderId !== input.orderId) throw new ProviderError('INVALID_INPUT', 'orderId does not match the transfer', { operationId });
      if (release.currency !== input.currency) throw new ProviderError('CURRENCY_MISMATCH', 'currency does not match the transfer', { operationId });
      let reversed = 0n;
      for (const t of this.transfers.values()) if (t.kind === 'reversal' && t.operationId !== operationId && t.fundingReference === release.fundingReference && t.status === 'SUCCEEDED') reversed += t.amount;
      if (input.amount > release.amount - reversed) {
        throw new ProviderError('INVALID_AMOUNT', 'reversal exceeds the transferred amount', { operationId });
      }
      const payee = release.payeeAccountId as string;
      const balance = this.payeeBalances.get(payee);
      if (balance !== undefined && input.amount > balance) {
        throw new ProviderError('INSUFFICIENT_BALANCE', 'payee balance cannot cover the reversal', {
          operationId,
          details: { requested: input.amount.toString(), available: balance.toString() },
        });
      }
      if (balance !== undefined) this.payeeBalances.set(payee, balance - input.amount);
      const funding = this.requireFunding(release.fundingReference);
      const record = this.createTransfer('reversal', operationId, funding, input.amount, payee, null);
      const result: ReversalResult = {
        reference: record.reference,
        operationId,
        releaseReference: release.reference,
        fundingReference: funding.reference,
        orderId: funding.orderId,
        amount: record.amount,
        currency: record.currency,
        status: record.status,
        createdAt: record.createdAt,
      };
      return { reference: record.reference, result };
    });
  }

  /** Test harness: the payee's available balance changes (for example after new sales). */
  setPayeeBalance(payeeAccountId: string, amount: bigint): void {
    assertId(payeeAccountId, 'payeeAccountId');
    assertAtomicAmount(amount, { allowZero: true, max: null, field: 'amount' });
    this.payeeBalances.set(payeeAccountId, amount);
  }

  async getRefundStatus(reference: string): Promise<RefundStatus> {
    const record = this.requireTransfer(reference, 'refund');
    return {
      reference: record.reference,
      operationId: record.operationId,
      fundingReference: record.fundingReference,
      orderId: record.orderId,
      amount: record.amount,
      currency: record.currency,
      reason: record.reason ?? 'OTHER',
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      failureCode: record.failureCode,
    };
  }

  async lookupOperation(operationId: string): Promise<OperationLookup | null> {
    assertOperationId(operationId);
    const entry = this.journal.get(operationId);
    if (!entry) return null;
    return {
      operationId: entry.operationId,
      kind: entry.kind,
      requestHash: entry.requestHash,
      state: entry.state,
      reference: entry.reference,
      attemptCount: entry.attemptCount,
      lastErrorCode: entry.lastErrorCode,
    };
  }

  async verifyWebhook(rawBody: Uint8Array, headers: Headers): Promise<VerifiedEvent> {
    verifyMockWebhookSignature({
      rawBody,
      signatureHeader: headers.get(MOCK_SIGNATURE_HEADER),
      secrets: this.secrets,
      nowSeconds: Math.floor(this.now().getTime() / 1000),
      toleranceSeconds: this.toleranceSeconds,
    });
    const event = parseMockEventBody(rawBody);
    // Environment/account come from the signed body, never from unsigned headers.
    if (event.mode !== this.mode || event.accountId !== this.accountId) {
      throw new ProviderError('WEBHOOK_CONTEXT_MISMATCH', 'webhook belongs to another environment or account', {
        details: { mode: event.mode },
      });
    }
    return event;
  }

  // ---- test harness (provider-side facts). Never expose via HTTP routes. -------------------

  /** Simulates the buyer completing/failing payment at the provider. Emits a signed webhook. */
  async simulateFundingOutcome(reference: string, outcome: SimulatedFundingOutcome): Promise<FundingStatus> {
    const funding = this.requireFunding(reference);
    const allowed: Record<FundingStatusCode, readonly FundingStatusCode[]> = {
      REQUIRES_ACTION: ['PROCESSING', 'SUCCEEDED', 'FAILED'],
      PROCESSING: ['SUCCEEDED', 'FAILED'],
      SUCCEEDED: [],
      FAILED: [],
      CANCELED: [],
      RETURNED: [],
    };
    if (!allowed[funding.status].includes(outcome.status)) {
      throw new ProviderError('INVALID_STATE', `funding cannot move from ${funding.status} to ${outcome.status}`);
    }
    if (outcome.providerFee !== undefined) {
      if (outcome.status !== 'SUCCEEDED') {
        throw new ProviderError('INVALID_INPUT', 'providerFee is only known for SUCCEEDED funding');
      }
      assertAtomicAmount(outcome.providerFee, { allowZero: true, max: funding.amount, field: 'providerFee' });
    }
    funding.status = outcome.status;
    if (outcome.status === 'SUCCEEDED') funding.providerFee = outcome.providerFee ?? 0n;
    funding.updatedAt = this.timestamp();
    const type: WebhookEventType =
      outcome.status === 'SUCCEEDED' ? 'funding.succeeded' : outcome.status === 'FAILED' ? 'funding.failed' : 'funding.processing';
    this.emitFundingEvent(type, funding);
    return this.fundingSnapshot(funding);
  }

  /**
   * Simulates a capture that completes at the provider even though the platform already cancelled the attempt (the
   * capture was in flight). Emits `funding.succeeded` for a CANCELED funding.
   */
  async simulateLateCapture(reference: string): Promise<FundingStatus> {
    const funding = this.requireFunding(reference);
    if (funding.status !== 'CANCELED') throw new ProviderError('INVALID_STATE', 'only a cancelled attempt can be captured late');
    funding.status = 'SUCCEEDED';
    funding.providerFee = funding.providerFee ?? 0n;
    funding.updatedAt = this.timestamp();
    this.emitFundingEvent('funding.succeeded', funding);
    return this.fundingSnapshot(funding);
  }

  /** Simulates the buyer's bank returning a settled bank transfer (for example a closed account). Emits `funding.returned`. */
  async simulateBankReturn(reference: string): Promise<FundingStatus> {
    const funding = this.requireFunding(reference);
    if (funding.method !== 'BANK_TRANSFER' || funding.status !== 'SUCCEEDED') {
      throw new ProviderError('INVALID_STATE', 'only a settled bank transfer can be returned');
    }
    funding.status = 'RETURNED';
    funding.updatedAt = this.timestamp();
    this.emitFundingEvent('funding.returned', funding);
    return this.fundingSnapshot(funding);
  }

  /** Simulates the provider reporting a different actual cost for a captured funding, possibly after the payout. */
  async simulateFeeAdjustment(reference: string, actualFee: bigint): Promise<FundingStatus> {
    const funding = this.requireFunding(reference);
    if (funding.status !== 'SUCCEEDED') throw new ProviderError('INVALID_STATE', 'only a captured funding has an actual cost');
    assertAtomicAmount(actualFee, { allowZero: true, max: funding.amount, field: 'providerFee' });
    funding.providerFee = actualFee;
    funding.updatedAt = this.timestamp();
    this.emitFundingEvent('funding.fee_updated', funding);
    return this.fundingSnapshot(funding);
  }

  /**
   * Simulates the buyer's bank disputing a captured payment (a chargeback), possibly long after the order completed.
   * Emits a signed `dispute.opened` webhook and returns the dispute reference.
   */
  async simulateChargeback(fundingReference: string, amount?: bigint): Promise<string> {
    const funding = this.requireFunding(fundingReference);
    if (funding.status !== 'SUCCEEDED') throw new ProviderError('INVALID_STATE', 'only a captured funding can be disputed');
    const disputed = amount ?? funding.amount;
    assertAtomicAmount(disputed, { max: funding.amount, field: 'amount' });
    const reference = this.referenceFor('dispute', `${fundingReference}:${this.disputes.size + 1}`);
    const record: DisputeRecord = { reference, fundingReference, orderId: funding.orderId, amount: disputed, currency: funding.currency, status: 'OPEN' };
    this.disputes.set(reference, record);
    this.emitDisputeEvent('dispute.opened', record);
    return reference;
  }

  /** Simulates the card network's decision on a dispute. Emits `dispute.won` or `dispute.lost`. */
  async simulateChargebackOutcome(reference: string, outcome: 'WON' | 'LOST'): Promise<void> {
    assertId(reference, 'reference');
    const record = this.disputes.get(reference);
    if (!record) throw new ProviderError('NOT_FOUND', 'dispute reference not found');
    if (record.status !== 'OPEN') throw new ProviderError('INVALID_STATE', `dispute is already ${record.status}`);
    record.status = outcome;
    this.emitDisputeEvent(outcome === 'WON' ? 'dispute.won' : 'dispute.lost', record);
  }

  async simulateReleaseOutcome(reference: string, status: 'SUCCEEDED' | 'FAILED'): Promise<ReleaseStatus> {
    this.settleTransfer(this.requireTransfer(reference, 'release'), status);
    return this.getReleaseStatus(reference);
  }

  async simulateRefundOutcome(reference: string, status: 'SUCCEEDED' | 'FAILED'): Promise<RefundStatus> {
    this.settleTransfer(this.requireTransfer(reference, 'refund'), status);
    return this.getRefundStatus(reference);
  }

  /** Returns signed deliveries for events not yet handed out, then clears that queue. */
  takeWebhookDeliveries(): WebhookDelivery[] {
    const pending = this.undelivered;
    this.undelivered = [];
    return pending.map((event) => this.sign(event));
  }

  /** Re-sends a previously emitted event (same id, same bytes, fresh signature). */
  redeliverWebhook(eventId: string): WebhookDelivery {
    const event = this.events.find((e) => e.eventId === eventId);
    if (!event) throw new ProviderError('NOT_FOUND', 'unknown event id');
    return this.sign(event);
  }

  // ---- internals ----------------------------------------------------------------------------

  /**
   * The body between the journal check and the journal write is synchronous, so concurrent
   * calls (e.g. Promise.all double-click) serialize on the JS event loop: exactly one applies.
   */
  private runIdempotent<T>(
    kind: OperationKind,
    operationId: string,
    payload: unknown,
    apply: () => { reference: string; result: T },
  ): Promise<T> {
    const requestHash = computeRequestHash(kind, payload);
    let entry = this.journal.get(operationId);
    if (entry && entry.requestHash !== requestHash) {
      return Promise.reject(
        new ProviderError('IDEMPOTENCY_CONFLICT', 'operationId was already used with a different request', {
          operationId,
          details: { existingKind: entry.kind },
        }),
      );
    }
    if (!entry) {
      entry = {
        operationId,
        kind,
        requestHash,
        state: 'NOT_APPLIED',
        reference: null,
        result: undefined,
        attemptCount: 0,
        lastErrorCode: null,
      };
      this.journal.set(operationId, entry);
    }
    entry.attemptCount += 1;

    if (entry.state === 'APPLIED') {
      return Promise.resolve(structuredClone(entry.result) as T);
    }

    const failure = this.consumeFailure(kind, operationId);
    if (failure === 'TIMEOUT_BEFORE_ACCEPT' || failure === 'UNAVAILABLE') {
      const code: ProviderErrorCode = failure === 'UNAVAILABLE' ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_TIMEOUT';
      entry.lastErrorCode = code;
      return Promise.reject(new ProviderError(code, `simulated ${failure}`, { operationId }));
    }

    let applied: { reference: string; result: T };
    try {
      applied = apply();
    } catch (error) {
      entry.lastErrorCode = isProviderError(error) ? error.code : 'INVALID_INPUT';
      return Promise.reject(error);
    }
    entry.state = 'APPLIED';
    entry.reference = applied.reference;
    entry.result = structuredClone(applied.result);
    entry.lastErrorCode = null;

    if (failure === 'ACCEPT_THEN_TIMEOUT') {
      entry.lastErrorCode = 'PROVIDER_TIMEOUT';
      return Promise.reject(
        new ProviderError('PROVIDER_TIMEOUT', 'simulated ACCEPT_THEN_TIMEOUT', { operationId, outcome: 'UNKNOWN' }),
      );
    }
    return Promise.resolve(structuredClone(applied.result));
  }

  private consumeFailure(kind: OperationKind, operationId: string): FailureEffect | null {
    for (const slot of this.failureRules) {
      if (slot.remaining <= 0) continue;
      if (slot.rule.kind !== kind) continue;
      if (slot.rule.operationId !== undefined && slot.rule.operationId !== operationId) continue;
      slot.remaining -= 1;
      return slot.rule.effect;
    }
    return null;
  }

  private assertSupportedCurrency(currency: unknown): asserts currency is string {
    assertCurrencyCode(currency);
    if (!this.currencies.includes(currency)) {
      throw new ProviderError('UNSUPPORTED_CAPABILITY', `currency ${currency} is not supported`, {
        details: { currency },
      });
    }
  }

  private assertTransferAgainst(funding: FundingRecord, orderId: string, currency: string, operationId: string): void {
    if (funding.status !== 'SUCCEEDED') {
      throw new ProviderError('INVALID_STATE', `funding is ${funding.status}, not SUCCEEDED`, {
        operationId,
        details: { status: funding.status },
      });
    }
    if (funding.orderId !== orderId) {
      throw new ProviderError('INVALID_INPUT', 'orderId does not match funding', { operationId });
    }
    if (funding.currency !== currency) {
      throw new ProviderError('CURRENCY_MISMATCH', 'currency does not match funding', { operationId });
    }
  }

  private availablePrincipal(funding: FundingRecord): bigint {
    if (funding.status !== 'SUCCEEDED') return 0n;
    let committed = 0n;
    for (const transfer of this.transfers.values()) {
      if (transfer.fundingReference !== funding.reference || transfer.status === 'FAILED') continue;
      // A reversal returns transferred principal; a platform-balance refund never drew on it.
      if (transfer.kind === 'reversal') committed -= transfer.amount;
      else if (transfer.source === 'PRINCIPAL') committed += transfer.amount;
    }
    return funding.amount - committed;
  }

  private refundedTotal(funding: FundingRecord): bigint {
    let refunded = 0n;
    for (const t of this.transfers.values()) if (t.kind === 'refund' && t.fundingReference === funding.reference && t.status !== 'FAILED') refunded += t.amount;
    return refunded;
  }

  private createTransfer(
    kind: 'release' | 'refund' | 'reversal',
    operationId: string,
    funding: FundingRecord,
    amount: bigint,
    payeeAccountId: string | null,
    reason: RefundReason | null,
    source: 'PRINCIPAL' | 'PLATFORM_BALANCE' = 'PRINCIPAL',
  ): TransferRecord {
    const at = this.timestamp();
    // Reversals settle when the provider accepts them; releases and refunds follow the configured settlement.
    const settlement = kind === 'reversal' ? 'immediate' : kind === 'release' ? this.releaseSettlement : this.refundSettlement;
    const record: TransferRecord = {
      kind,
      source,
      reference: this.referenceFor(kind === 'release' ? 'tr' : kind === 'refund' ? 're' : 'trr', operationId),
      operationId,
      fundingReference: funding.reference,
      orderId: funding.orderId,
      payeeAccountId,
      reason,
      amount,
      currency: funding.currency,
      status: settlement === 'immediate' ? 'SUCCEEDED' : 'PENDING',
      failureCode: null,
      createdAt: at,
      updatedAt: at,
    };
    this.transfers.set(record.reference, record);
    this.emitTransferEvent(record);
    return record;
  }

  private settleTransfer(record: TransferRecord, status: 'SUCCEEDED' | 'FAILED'): void {
    if (record.status !== 'PENDING') {
      throw new ProviderError('INVALID_STATE', `${record.kind} is already ${record.status}`);
    }
    record.status = status;
    record.failureCode = status === 'FAILED' ? 'simulated_failure' : null;
    record.updatedAt = this.timestamp();
    this.emitTransferEvent(record);
  }

  private fundingSnapshot(funding: FundingRecord): FundingStatus {
    const sums = { releasedSucceeded: 0n, releasePending: 0n, refundedSucceeded: 0n, refundPending: 0n };
    for (const t of this.transfers.values()) {
      if (t.fundingReference !== funding.reference) continue;
      if (t.kind === 'release' && t.status === 'SUCCEEDED') sums.releasedSucceeded += t.amount;
      if (t.kind === 'release' && t.status === 'PENDING') sums.releasePending += t.amount;
      if (t.kind === 'refund' && t.status === 'SUCCEEDED') sums.refundedSucceeded += t.amount;
      if (t.kind === 'refund' && t.status === 'PENDING') sums.refundPending += t.amount;
    }
    return {
      reference: funding.reference,
      orderId: funding.orderId,
      payeeAccountId: funding.payeeAccountId,
      status: funding.status,
      amount: funding.amount,
      currency: funding.currency,
      platformFee: PLATFORM_FEE_ATOMIC,
      providerFee: funding.providerFee,
      ...sums,
      availablePrincipal: this.availablePrincipal(funding),
      fullyRefunded: funding.status === 'SUCCEEDED' && sums.refundedSucceeded === funding.amount,
      createdAt: funding.createdAt,
      updatedAt: funding.updatedAt,
    };
  }

  private requireFunding(reference: string): FundingRecord {
    assertId(reference, 'reference');
    const funding = this.fundings.get(reference);
    if (!funding) throw new ProviderError('NOT_FOUND', 'funding reference not found');
    return funding;
  }

  private requireTransfer(reference: string, kind: 'release' | 'refund'): TransferRecord {
    assertId(reference, 'reference');
    const record = this.transfers.get(reference);
    if (!record || record.kind !== kind) throw new ProviderError('NOT_FOUND', `${kind} reference not found`);
    return record;
  }

  private referenceFor(prefix: string, operationId: string): string {
    const digest = createHash('sha256').update(`${this.accountId}\n${prefix}\n${operationId}`).digest('hex');
    return `mock_${prefix}_${digest.slice(0, 24)}`;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private emitFundingEvent(type: WebhookEventType, funding: FundingRecord): void {
    this.emit(type, {
      objectType: 'funding',
      reference: funding.reference,
      fundingReference: funding.reference,
      operationId: funding.operationId,
      orderId: funding.orderId,
      status: funding.status,
      amount: funding.amount.toString(),
      currency: funding.currency,
      providerFee: funding.providerFee === null ? null : funding.providerFee.toString(),
    });
  }

  private emitTransferEvent(record: TransferRecord): void {
    const suffix = record.status === 'PENDING' ? 'pending' : record.status === 'SUCCEEDED' ? 'succeeded' : 'failed';
    this.emit(`${record.kind}.${suffix}` as WebhookEventType, {
      objectType: record.kind,
      reference: record.reference,
      fundingReference: record.fundingReference,
      operationId: record.operationId,
      orderId: record.orderId,
      status: record.status,
      amount: record.amount.toString(),
      currency: record.currency,
      providerFee: null,
    });
  }

  private emitDisputeEvent(type: WebhookEventType, record: DisputeRecord): void {
    this.emit(type, {
      objectType: 'dispute',
      reference: record.reference,
      fundingReference: record.fundingReference,
      // Provider-initiated: there is no platform operation, so the dispute reference stands in for it.
      operationId: `dispute:${record.reference}`,
      orderId: record.orderId,
      status: record.status,
      amount: record.amount.toString(),
      currency: record.currency,
      providerFee: null,
    });
  }

  private emit(type: WebhookEventType, data: Record<string, string | null>): void {
    this.eventSequence += 1;
    const eventId = `evt_${createHash('sha256').update(`${this.accountId}\n${this.eventNonce}\n${this.eventSequence}`).digest('hex').slice(0, 32)}`;
    const body = JSON.stringify({
      id: eventId,
      type,
      mode: this.mode,
      account: this.accountId,
      created: this.timestamp(),
      data,
    });
    const event: StoredEvent = { eventId, type, rawBody: new TextEncoder().encode(body) };
    this.events.push(event);
    this.undelivered.push(event);
  }

  private sign(event: StoredEvent): WebhookDelivery {
    const signingSecret = this.secrets[0] as string;
    const timestamp = Math.floor(this.now().getTime() / 1000);
    const headers = new Headers({
      'content-type': 'application/json',
      [MOCK_SIGNATURE_HEADER]: signMockWebhook(event.rawBody, signingSecret, timestamp),
    });
    return { eventId: event.eventId, type: event.type, rawBody: event.rawBody.slice(), headers };
  }
}

function parseMockEventBody(rawBody: Uint8Array): VerifiedEvent {
  const bad = (reason: string) =>
    new ProviderError('WEBHOOK_PAYLOAD_INVALID', 'webhook payload is invalid', { details: { reason } });
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody));
  } catch {
    throw bad('not valid UTF-8 JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) throw bad('not an object');
  const body = parsed as Record<string, unknown>;
  const data = body.data as Record<string, unknown> | undefined;
  if (typeof data !== 'object' || data === null) throw bad('missing data');

  const str = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || value.length === 0) throw bad(`missing ${field}`);
    return value;
  };
  const type = str(body.type, 'type');
  if (!WEBHOOK_EVENT_TYPES.has(type)) throw bad('unknown type');
  const mode = str(body.mode, 'mode');
  if (mode !== 'test' && mode !== 'live') throw bad('unknown mode');
  const objectType = str(data.objectType, 'objectType');
  if (!['funding', 'release', 'refund', 'reversal', 'dispute'].includes(objectType)) throw bad('unknown objectType');
  if (!type.startsWith(`${objectType}.`)) throw bad('type/objectType mismatch');
  const status = str(data.status, 'status');
  const statuses = objectType === 'funding' ? FUNDING_STATUSES : objectType === 'dispute' ? DISPUTE_STATUSES : TRANSFER_STATUSES;
  if (!statuses.has(status)) throw bad('unknown status');
  const currency = str(data.currency, 'currency');
  if (!CURRENCY_PATTERN.test(currency)) throw bad('invalid currency');
  const createdAt = str(body.created, 'created');
  if (Number.isNaN(Date.parse(createdAt))) throw bad('invalid created');

  let amount: bigint;
  let providerFee: bigint | null;
  try {
    amount = parseAtomicAmount(data.amount, { max: null });
    providerFee = data.providerFee === null ? null : parseAtomicAmount(data.providerFee, { allowZero: true, max: null });
  } catch {
    throw bad('invalid amount');
  }

  return {
    eventId: str(body.id, 'id'),
    type: type as WebhookEventType,
    mode,
    accountId: str(body.account, 'account'),
    createdAt,
    objectType: objectType as VerifiedEvent['objectType'],
    reference: str(data.reference, 'reference'),
    fundingReference: str(data.fundingReference, 'fundingReference'),
    operationId: str(data.operationId, 'operationId'),
    orderId: str(data.orderId, 'orderId'),
    status: status as VerifiedEvent['status'],
    amount,
    currency,
    providerFee,
  };
}
