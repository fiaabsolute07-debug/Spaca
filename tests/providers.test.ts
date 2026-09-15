import { describe, expect, it } from 'vitest';
import {
  MOCK_SIGNATURE_HEADER,
  MockPaymentProvider,
  PLATFORM_FEE_ATOMIC,
  PLATFORM_FEE_BPS,
  ProviderError,
  type FailureInjectionRule,
  type FundingInput,
  type MockPaymentProviderOptions,
  assertZeroPlatformFee,
  canonicalize,
  computeRequestHash,
  isProviderError,
  parseAtomicAmount,
  platformFeeFor,
  signMockWebhook,
  verifyMockWebhookSignature,
} from '../src/modules/payments/providers';
import {
  LocalNotificationSink,
  NOTIFICATION_TEMPLATES,
  NotificationDispatcher,
  NotificationError,
  formatAtomicAmount,
  notificationDedupeKey,
  renderNotification,
  type NotificationTemplateId,
} from '../src/modules/notifications';

const SECRET = 'whsec_local_test_secret_0001';
const FIXED_NOW = new Date('2026-09-13T10:00:00.000Z');

function clock(start = FIXED_NOW) {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advanceSeconds: (s: number) => {
      current += s * 1000;
    },
  };
}

function makeProvider(overrides: Partial<MockPaymentProviderOptions> = {}) {
  const c = clock();
  const provider = new MockPaymentProvider({ webhookSecrets: [SECRET], now: c.now, ...overrides });
  return { provider, clock: c };
}

const fundingInput = (overrides: Partial<FundingInput> = {}): FundingInput => ({
  orderId: 'order_0001',
  buyerId: 'buyer_0001',
  payeeAccountId: 'acct_creator_0001',
  amount: 10_000n,
  currency: 'USD',
  platformFee: 0n,
  ...overrides,
});

async function expectProviderError(promise: Promise<unknown>, code: ProviderError['code']): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).code).toBe(code);
    return error as ProviderError;
  }
  throw new Error(`expected ProviderError ${code}, but promise resolved`);
}

async function fundedOrder(provider: MockPaymentProvider, amount = 10_000n, providerFee = 300n) {
  const intent = await provider.createFundingIntent(fundingInput({ amount }), 'op_fund_order_0001');
  await provider.simulateFundingOutcome(intent.reference, { status: 'SUCCEEDED', providerFee });
  return intent;
}

describe('provider error identity', () => {
  it('recognises provider errors thrown by another bundled copy of the provider module', () => {
    // Next dev bundles providers.ts per route while the mock provider instance is shared, so instanceof alone is not enough.
    class ForeignProviderError extends Error { readonly code = 'NOT_FOUND'; }
    const foreign = new ForeignProviderError('funding reference not found');
    expect(isProviderError(foreign)).toBe(false);
    Object.defineProperty(foreign, Symbol.for('spaca.payments.ProviderError'), { value: true });
    expect(isProviderError(foreign, 'NOT_FOUND')).toBe(true);
    expect(isProviderError(foreign, 'PAYEE_NOT_CAPABLE')).toBe(false);
    expect(isProviderError(new ProviderError('NOT_FOUND', 'x'), 'NOT_FOUND')).toBe(true);
    expect(isProviderError(Object.assign(new Error('x'), { code: 'NOT_FOUND' }))).toBe(false);
  });
});

describe('platform fee is always zero', () => {
  it('exposes zero constants and zero fee for any amount', () => {
    expect(PLATFORM_FEE_BPS).toBe(0);
    expect(PLATFORM_FEE_ATOMIC).toBe(0n);
    for (const amount of [0n, 1n, 10_000n, 999_999_999_999n]) expect(platformFeeFor(amount)).toBe(0n);
    expect(() => assertZeroPlatformFee(1n)).toThrowError(ProviderError);
    expect(() => assertZeroPlatformFee(0)).toThrowError(/bigint/);
  });

  it('rejects nonzero platform fee on funding and release', async () => {
    const { provider } = makeProvider();
    await expectProviderError(
      provider.createFundingIntent(fundingInput({ platformFee: 1n }), 'op_fee_nonzero_1'),
      'NONZERO_PLATFORM_FEE',
    );
    const intent = await fundedOrder(provider);
    await expectProviderError(
      provider.releaseToCreator(
        { fundingReference: intent.reference, orderId: 'order_0001', payeeAccountId: 'acct_creator_0001', amount: 9_700n, currency: 'USD', platformFee: 50n },
        'op_release_fee_1',
      ),
      'NONZERO_PLATFORM_FEE',
    );
  });

  it('reports zero platform fee on every DTO and in capabilities; provider cost is separate (fixture 100 USD, cost 3 USD)', async () => {
    const { provider } = makeProvider();
    const caps = await provider.capabilities({ merchantAccountId: provider.accountId, payeeAccountId: 'acct_creator_0001', currency: 'USD' });
    expect(caps.platformFeeBps).toBe(0);
    expect(caps.conditionalEscrow).toBe(false);
    expect(caps.payeePayoutsEnabled).toBe(true);

    const intent = await fundedOrder(provider, 10_000n, 300n);
    expect(intent.platformFee).toBe(0n);
    const status = await provider.getFundingStatus(intent.reference);
    expect(status.platformFee).toBe(0n);
    expect(status.providerFee).toBe(300n);

    const release = await provider.releaseToCreator(
      { fundingReference: intent.reference, orderId: 'order_0001', payeeAccountId: 'acct_creator_0001', amount: 10_000n - 300n, currency: 'USD', platformFee: 0n },
      'op_release_net_0001',
    );
    expect(release.platformFee).toBe(0n);
    expect(release.amount).toBe(9_700n);
  });
});

describe('money validation', () => {
  it('rejects floats, zero, negative and overrange amounts; roundtrips integer strings exactly', async () => {
    const { provider } = makeProvider({ maxAtomicAmount: 1_000_000n });
    for (const [amount, i] of [
      [0n, 1],
      [-5n, 2],
      [1_000_001n, 3],
    ] as const) {
      await expectProviderError(provider.createFundingIntent(fundingInput({ amount }), `op_bad_amount_${i}`), 'INVALID_AMOUNT');
    }
    await expectProviderError(
      provider.createFundingIntent(fundingInput({ amount: 100.5 as unknown as bigint }), 'op_bad_amount_4'),
      'INVALID_AMOUNT',
    );
    expect(parseAtomicAmount('900719925474099312345', { max: null })).toBe(900719925474099312345n);
    expect(() => parseAtomicAmount('1e3')).toThrowError(ProviderError);
    expect(() => parseAtomicAmount('01')).toThrowError(ProviderError);
    expect(() => parseAtomicAmount(12)).toThrowError(ProviderError);
  });

  it('rejects unsupported currency as typed capability error', async () => {
    const { provider } = makeProvider();
    await expectProviderError(provider.createFundingIntent(fundingInput({ currency: 'EUR' }), 'op_eur_funding_1'), 'UNSUPPORTED_CAPABILITY');
  });

  it('refuses to construct in live mode', () => {
    expect(() => new MockPaymentProvider({ webhookSecrets: [SECRET], mode: 'live' })).toThrowError(/local\/test only/);
  });
});

describe('idempotency', () => {
  it('canonical hash is key-order independent and type-tagged', () => {
    expect(canonicalize({ b: 1, a: 2n })).toBe(canonicalize({ a: 2n, b: 1 }));
    expect(canonicalize(5n)).not.toBe(canonicalize(5));
    expect(canonicalize(5n)).not.toBe(canonicalize('5n'));
    expect(computeRequestHash('funding.create', { a: 1 })).not.toBe(computeRequestHash('refund.create', { a: 1 }));
  });

  it('replays the original response for the same operation id and payload', async () => {
    const { provider, clock: c } = makeProvider();
    const first = await provider.createFundingIntent(fundingInput(), 'op_fund_replay_01');
    c.advanceSeconds(60);
    const second = await provider.createFundingIntent(fundingInput(), 'op_fund_replay_01');
    expect(second).toEqual(first);
    const lookup = await provider.lookupOperation('op_fund_replay_01');
    expect(lookup).toMatchObject({ state: 'APPLIED', attemptCount: 2, reference: first.reference });
  });

  it('replayed results are defensive copies', async () => {
    const { provider } = makeProvider();
    const first = await provider.createFundingIntent(fundingInput(), 'op_fund_copy_0001');
    (first as { amount: bigint }).amount = 1n;
    const second = await provider.createFundingIntent(fundingInput(), 'op_fund_copy_0001');
    expect(second.amount).toBe(10_000n);
  });

  it('concurrent double-submit creates exactly one funding intent', async () => {
    const { provider } = makeProvider();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => provider.createFundingIntent(fundingInput(), 'op_fund_concurrent')),
    );
    expect(new Set(results.map((r) => r.reference)).size).toBe(1);
    expect(provider.takeWebhookDeliveries()).toHaveLength(0);
    const lookup = await provider.lookupOperation('op_fund_concurrent');
    expect(lookup?.attemptCount).toBe(10);
  });

  it('same operation id with a different payload is a conflict and applies nothing', async () => {
    const { provider } = makeProvider();
    await provider.createFundingIntent(fundingInput(), 'op_fund_conflict_1');
    const error = await expectProviderError(
      provider.createFundingIntent(fundingInput({ amount: 20_000n }), 'op_fund_conflict_1'),
      'IDEMPOTENCY_CONFLICT',
    );
    expect(error.retryable).toBe(false);
    expect(error.outcome).toBe('NOT_APPLIED');
  });

  it('same operation id reused for a different operation kind is a conflict', async () => {
    const { provider } = makeProvider();
    const intent = await fundedOrder(provider);
    await expectProviderError(
      provider.refund({ fundingReference: intent.reference, orderId: 'order_0001', amount: 1n, currency: 'USD', reason: 'OTHER' }, 'op_fund_order_0001'),
      'IDEMPOTENCY_CONFLICT',
    );
  });

  it('rejects malformed operation ids', async () => {
    const { provider } = makeProvider();
    for (const bad of ['', 'short', 'has space in it', '-leading-dash', 'x'.repeat(256)]) {
      await expectProviderError(provider.createFundingIntent(fundingInput(), bad), 'INVALID_OPERATION_ID');
    }
  });
});

describe('accepted-but-timeout recovery', () => {
  const rule = (overrides: Partial<FailureInjectionRule> & Pick<FailureInjectionRule, 'kind' | 'effect'>): FailureInjectionRule => overrides;

  it('funding: timeout after acceptance is UNKNOWN, lookup finds the effect, same-key retry returns it without a second charge', async () => {
    const { provider } = makeProvider({
      failureInjection: [rule({ kind: 'funding.create', operationId: 'op_fund_timeout_1', effect: 'ACCEPT_THEN_TIMEOUT' })],
    });
    const error = await expectProviderError(provider.createFundingIntent(fundingInput(), 'op_fund_timeout_1'), 'PROVIDER_TIMEOUT');
    expect(error.outcome).toBe('UNKNOWN');
    expect(error.retryable).toBe(true);

    const lookup = await provider.lookupOperation('op_fund_timeout_1');
    expect(lookup?.state).toBe('APPLIED');
    expect(lookup?.reference).toMatch(/^mock_fund_/);

    const retry = await provider.createFundingIntent(fundingInput(), 'op_fund_timeout_1');
    expect(retry.reference).toBe(lookup?.reference);
    const status = await provider.getFundingStatus(retry.reference);
    expect(status.status).toBe('REQUIRES_ACTION');
  });

  it('timeout before acceptance: lookup reports NOT_APPLIED and same-key retry applies once', async () => {
    const { provider } = makeProvider({
      failureInjection: [rule({ kind: 'funding.create', effect: 'TIMEOUT_BEFORE_ACCEPT', times: 2 })],
    });
    await expectProviderError(provider.createFundingIntent(fundingInput(), 'op_fund_timeout_2'), 'PROVIDER_TIMEOUT');
    await expectProviderError(provider.createFundingIntent(fundingInput(), 'op_fund_timeout_2'), 'PROVIDER_TIMEOUT');
    expect(await provider.lookupOperation('op_fund_timeout_2')).toMatchObject({ state: 'NOT_APPLIED', reference: null, attemptCount: 2 });
    // Key/payload binding holds even though nothing was applied. Conflicts are not attempts.
    await expectProviderError(provider.createFundingIntent(fundingInput({ amount: 1n }), 'op_fund_timeout_2'), 'IDEMPOTENCY_CONFLICT');
    const applied = await provider.createFundingIntent(fundingInput(), 'op_fund_timeout_2');
    expect(await provider.lookupOperation('op_fund_timeout_2')).toMatchObject({ state: 'APPLIED', reference: applied.reference, attemptCount: 3 });
  });

  it('unavailable is NOT_APPLIED and retryable', async () => {
    const { provider } = makeProvider({ failureInjection: [rule({ kind: 'funding.create', effect: 'UNAVAILABLE' })] });
    const error = await expectProviderError(provider.createFundingIntent(fundingInput(), 'op_fund_unavail_1'), 'PROVIDER_UNAVAILABLE');
    expect(error.outcome).toBe('NOT_APPLIED');
    expect(error.retryable).toBe(true);
  });

  it('release: accepted-then-timeout then retry pays exactly once (PAY-11 style)', async () => {
    const { provider } = makeProvider({
      failureInjection: [rule({ kind: 'release.create', effect: 'ACCEPT_THEN_TIMEOUT' })],
    });
    const intent = await fundedOrder(provider);
    const input = { fundingReference: intent.reference, orderId: 'order_0001', payeeAccountId: 'acct_creator_0001', amount: 9_700n, currency: 'USD', platformFee: 0n };
    await expectProviderError(provider.releaseToCreator(input, 'op_release_timeout'), 'PROVIDER_TIMEOUT');
    const retry = await provider.releaseToCreator(input, 'op_release_timeout');
    expect(retry.status).toBe('SUCCEEDED');
    const status = await provider.getFundingStatus(intent.reference);
    expect(status.releasedSucceeded).toBe(9_700n);
    expect(status.availablePrincipal).toBe(300n);
  });

  it('refund: accepted-then-timeout then retry refunds exactly once', async () => {
    const { provider } = makeProvider({ failureInjection: [rule({ kind: 'refund.create', effect: 'ACCEPT_THEN_TIMEOUT' })] });
    const intent = await fundedOrder(provider);
    const input = { fundingReference: intent.reference, orderId: 'order_0001', amount: 10_000n, currency: 'USD', reason: 'BUYER_CANCELED_BEFORE_WORK' as const };
    await expectProviderError(provider.refund(input, 'op_refund_timeout'), 'PROVIDER_TIMEOUT');
    await provider.refund(input, 'op_refund_timeout');
    const status = await provider.getFundingStatus(intent.reference);
    expect(status.refundedSucceeded).toBe(10_000n);
    expect(status.fullyRefunded).toBe(true);
  });
});

describe('funding lifecycle', () => {
  it('there is no markPaid: funding moves only via provider facts', async () => {
    const { provider } = makeProvider();
    expect((provider as unknown as Record<string, unknown>).markPaid).toBeUndefined();
    const intent = await provider.createFundingIntent(fundingInput(), 'op_fund_lifecycle1');
    expect(intent.status).toBe('REQUIRES_ACTION');
    expect(intent.nextAction).toBe('BUYER_CONFIRMS_WITH_PROVIDER');
    // Transfers before SUCCEEDED are rejected.
    await expectProviderError(
      provider.releaseToCreator(
        { fundingReference: intent.reference, orderId: 'order_0001', payeeAccountId: 'acct_creator_0001', amount: 1n, currency: 'USD', platformFee: 0n },
        'op_release_early_1',
      ),
      'INVALID_STATE',
    );
  });

  it('SUCCEEDED never regresses to PROCESSING/FAILED', async () => {
    const { provider } = makeProvider();
    const intent = await fundedOrder(provider);
    await expect(provider.simulateFundingOutcome(intent.reference, { status: 'FAILED' })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(provider.simulateFundingOutcome(intent.reference, { status: 'PROCESSING' })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect((await provider.getFundingStatus(intent.reference)).status).toBe('SUCCEEDED');
  });

  it('cancel before funding is idempotent; cancel after success requires refund', async () => {
    const { provider } = makeProvider();
    const intent = await provider.createFundingIntent(fundingInput(), 'op_fund_cancel_01');
    const cancel = await provider.cancelFunding(intent.reference, 'op_cancel_0000001');
    expect(cancel).toMatchObject({ status: 'CANCELED', alreadyCanceled: false });
    expect(await provider.cancelFunding(intent.reference, 'op_cancel_0000001')).toEqual(cancel);
    expect(await provider.cancelFunding(intent.reference, 'op_cancel_0000002')).toMatchObject({ alreadyCanceled: true });
    await expect(provider.simulateFundingOutcome(intent.reference, { status: 'SUCCEEDED' })).rejects.toMatchObject({ code: 'INVALID_STATE' });

    const funded = await provider.createFundingIntent(fundingInput({ orderId: 'order_0002' }), 'op_fund_cancel_02');
    await provider.simulateFundingOutcome(funded.reference, { status: 'SUCCEEDED' });
    await expectProviderError(provider.cancelFunding(funded.reference, 'op_cancel_0000003'), 'INVALID_STATE');
    await expectProviderError(provider.getFundingStatus('mock_fund_doesnotexist'), 'NOT_FOUND');
  });
});

describe('refund and release principal limits', () => {
  const refundInput = (reference: string, amount: bigint) => ({
    fundingReference: reference,
    orderId: 'order_0001',
    amount,
    currency: 'USD',
    reason: 'MUTUAL_CANCELLATION' as const,
  });

  it('partial refunds sum pending+succeeded and never exceed funded amount', async () => {
    const { provider } = makeProvider({ refundSettlement: 'pending' });
    const intent = await fundedOrder(provider);
    const r1 = await provider.refund(refundInput(intent.reference, 6_000n), 'op_refund_part_001');
    expect(r1.status).toBe('PENDING');
    await expectProviderError(provider.refund(refundInput(intent.reference, 4_001n), 'op_refund_part_002'), 'REFUND_EXCEEDS_REFUNDABLE');
    const r2 = await provider.refund(refundInput(intent.reference, 4_000n), 'op_refund_part_003');
    await expectProviderError(provider.refund(refundInput(intent.reference, 1n), 'op_refund_part_004'), 'REFUND_EXCEEDS_REFUNDABLE');

    let status = await provider.getFundingStatus(intent.reference);
    expect(status).toMatchObject({ refundPending: 10_000n, refundedSucceeded: 0n, availablePrincipal: 0n, fullyRefunded: false });

    await provider.simulateRefundOutcome(r1.reference, 'SUCCEEDED');
    status = await provider.getFundingStatus(intent.reference);
    expect(status.fullyRefunded).toBe(false);

    // A failed refund releases its reservation.
    await provider.simulateRefundOutcome(r2.reference, 'FAILED');
    status = await provider.getFundingStatus(intent.reference);
    expect(status).toMatchObject({ refundedSucceeded: 6_000n, refundPending: 0n, availablePrincipal: 4_000n, fullyRefunded: false });
    expect((await provider.getRefundStatus(r2.reference)).failureCode).toBe('simulated_failure');

    const r3 = await provider.refund(refundInput(intent.reference, 4_000n), 'op_refund_part_005');
    await provider.simulateRefundOutcome(r3.reference, 'SUCCEEDED');
    status = await provider.getFundingStatus(intent.reference);
    expect(status).toMatchObject({ refundedSucceeded: 10_000n, fullyRefunded: true, availablePrincipal: 0n });
    await expect(provider.simulateRefundOutcome(r3.reference, 'FAILED')).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('a rejected refund can be retried with the same key after principal frees up', async () => {
    const { provider } = makeProvider({ refundSettlement: 'pending' });
    const intent = await fundedOrder(provider);
    const big = await provider.refund(refundInput(intent.reference, 10_000n), 'op_refund_block_01');
    await expectProviderError(provider.refund(refundInput(intent.reference, 500n), 'op_refund_retry_01'), 'REFUND_EXCEEDS_REFUNDABLE');
    expect(await provider.lookupOperation('op_refund_retry_01')).toMatchObject({ state: 'NOT_APPLIED', lastErrorCode: 'REFUND_EXCEEDS_REFUNDABLE' });
    await provider.simulateRefundOutcome(big.reference, 'FAILED');
    const retried = await provider.refund(refundInput(intent.reference, 500n), 'op_refund_retry_01');
    expect(retried.amount).toBe(500n);
  });

  it('release and refund compete for the same principal; concurrent attempts cannot overdraw', async () => {
    const { provider } = makeProvider();
    const intent = await fundedOrder(provider);
    const results = await Promise.allSettled([
      provider.releaseToCreator(
        { fundingReference: intent.reference, orderId: 'order_0001', payeeAccountId: 'acct_creator_0001', amount: 10_000n, currency: 'USD', platformFee: 0n },
        'op_release_race_01',
      ),
      provider.refund(refundInput(intent.reference, 10_000n), 'op_refund_race_001'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const status = await provider.getFundingStatus(intent.reference);
    expect(status.releasedSucceeded + status.refundedSucceeded).toBe(10_000n);
    expect(status.availablePrincipal).toBe(0n);
  });

  it('release checks payee, currency, order and payout capability', async () => {
    const { provider } = makeProvider({ payeesWithoutPayouts: ['acct_creator_0001'] });
    const caps = await provider.capabilities({ merchantAccountId: provider.accountId, payeeAccountId: 'acct_creator_0001' });
    expect(caps.payeePayoutsEnabled).toBe(false);
    const intent = await fundedOrder(provider);
    const base = { fundingReference: intent.reference, orderId: 'order_0001', payeeAccountId: 'acct_creator_0001', amount: 100n, currency: 'USD', platformFee: 0n };
    await expectProviderError(provider.releaseToCreator(base, 'op_release_cap_001'), 'PAYEE_NOT_CAPABLE');
    await expectProviderError(provider.releaseToCreator({ ...base, payeeAccountId: 'acct_other_0001' }, 'op_release_cap_002'), 'PAYEE_MISMATCH');
    await expectProviderError(provider.releaseToCreator({ ...base, currency: 'EUR' }, 'op_release_cap_003'), 'CURRENCY_MISMATCH');
    await expectProviderError(provider.releaseToCreator({ ...base, orderId: 'order_9999' }, 'op_release_cap_004'), 'INVALID_INPUT');
  });

  it('partial refund capability off rejects partial amounts with typed error', async () => {
    const { provider } = makeProvider({ partialRefund: false });
    const intent = await fundedOrder(provider);
    await expectProviderError(provider.refund(refundInput(intent.reference, 1n), 'op_refund_nopart1'), 'UNSUPPORTED_CAPABILITY');
    await provider.refund(refundInput(intent.reference, 10_000n), 'op_refund_nopart2');
  });
});

describe('webhooks', () => {
  it('emits signed events that verify, with bigint amounts and signed context', async () => {
    const { provider } = makeProvider();
    const intent = await fundedOrder(provider, 10_000n, 300n);
    const [delivery] = provider.takeWebhookDeliveries();
    expect(delivery).toBeDefined();
    const event = await provider.verifyWebhook(delivery!.rawBody, delivery!.headers);
    expect(event).toMatchObject({
      type: 'funding.succeeded',
      mode: 'test',
      accountId: provider.accountId,
      reference: intent.reference,
      operationId: 'op_fund_order_0001',
      amount: 10_000n,
      providerFee: 300n,
      status: 'SUCCEEDED',
    });
    expect(provider.takeWebhookDeliveries()).toHaveLength(0);
  });

  it('redelivery keeps the same event id and bytes (inbox dedupe is by event id)', async () => {
    const { provider } = makeProvider();
    await fundedOrder(provider);
    const [original] = provider.takeWebhookDeliveries();
    const events = [];
    for (let i = 0; i < 10; i++) {
      const again = provider.redeliverWebhook(original!.eventId);
      expect(Buffer.from(again.rawBody).equals(Buffer.from(original!.rawBody))).toBe(true);
      events.push(await provider.verifyWebhook(again.rawBody, again.headers));
    }
    expect(new Set(events.map((e) => e.eventId)).size).toBe(1);
  });

  it('event ids are unique across provider instances with the same account (restart safety)', async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const { provider } = makeProvider();
      await fundedOrder(provider);
      for (const delivery of provider.takeWebhookDeliveries()) ids.add(delivery.eventId);
    }
    expect(ids.size).toBe(3);
  });

  it('rejects tampered body, tampered signature, missing header and wrong secret', async () => {
    const { provider } = makeProvider();
    await fundedOrder(provider);
    const [delivery] = provider.takeWebhookDeliveries();
    const body = delivery!.rawBody;

    const tampered = Buffer.from(new TextDecoder().decode(body).replace('"10000"', '"99999"'));
    expect(tampered.equals(Buffer.from(body))).toBe(false);
    await expectProviderError(provider.verifyWebhook(tampered, delivery!.headers), 'WEBHOOK_SIGNATURE_INVALID');

    const flipped = new Uint8Array(body);
    flipped[flipped.length - 2] = flipped.at(-2)! ^ 0x01;
    await expectProviderError(provider.verifyWebhook(flipped, delivery!.headers), 'WEBHOOK_SIGNATURE_INVALID');

    const header = delivery!.headers.get(MOCK_SIGNATURE_HEADER)!;
    const lastChar = header.at(-1) === '0' ? '1' : '0';
    const badSig = new Headers({ [MOCK_SIGNATURE_HEADER]: header.slice(0, -1) + lastChar });
    await expectProviderError(provider.verifyWebhook(body, badSig), 'WEBHOOK_SIGNATURE_INVALID');

    await expectProviderError(provider.verifyWebhook(body, new Headers()), 'WEBHOOK_SIGNATURE_INVALID');
    await expectProviderError(provider.verifyWebhook(body, new Headers({ [MOCK_SIGNATURE_HEADER]: 'garbage' })), 'WEBHOOK_SIGNATURE_INVALID');
    await expectProviderError(provider.verifyWebhook(body, new Headers({ [MOCK_SIGNATURE_HEADER]: 't=1,v1=zz' })), 'WEBHOOK_SIGNATURE_INVALID');

    const ts = Math.floor(FIXED_NOW.getTime() / 1000);
    const forged = new Headers({ [MOCK_SIGNATURE_HEADER]: signMockWebhook(body, 'whsec_attacker_secret_xx', ts) });
    await expectProviderError(provider.verifyWebhook(body, forged), 'WEBHOOK_SIGNATURE_INVALID');
  });

  it('rejects stale or future timestamps', async () => {
    const { provider, clock: c } = makeProvider();
    await fundedOrder(provider);
    const [delivery] = provider.takeWebhookDeliveries();
    c.advanceSeconds(301);
    await expectProviderError(provider.verifyWebhook(delivery!.rawBody, delivery!.headers), 'WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE');
    const future = Math.floor(FIXED_NOW.getTime() / 1000) + 10_000;
    expect(() =>
      verifyMockWebhookSignature({
        rawBody: delivery!.rawBody,
        signatureHeader: signMockWebhook(delivery!.rawBody, SECRET, future),
        secrets: [SECRET],
        nowSeconds: Math.floor(FIXED_NOW.getTime() / 1000),
      }),
    ).toThrowError(/tolerance/);
  });

  it('accepts rotated secrets', async () => {
    const newSecret = 'whsec_local_rotated_secret_2';
    const signer = makeProvider({ webhookSecrets: [newSecret] }).provider;
    await fundedOrder(signer);
    const [delivery] = signer.takeWebhookDeliveries();
    const verifier = makeProvider({ webhookSecrets: [SECRET, newSecret] }).provider;
    await expect(verifier.verifyWebhook(delivery!.rawBody, delivery!.headers)).resolves.toMatchObject({ type: 'funding.succeeded' });
  });

  it('rejects correctly signed events from another account (wrong environment/account)', async () => {
    const other = makeProvider({ accountId: 'acct_mock_other' }).provider;
    await fundedOrder(other);
    const [delivery] = other.takeWebhookDeliveries();
    const { provider } = makeProvider();
    await expectProviderError(provider.verifyWebhook(delivery!.rawBody, delivery!.headers), 'WEBHOOK_CONTEXT_MISMATCH');
  });

  it('rejects a signed but malformed payload', async () => {
    const { provider } = makeProvider();
    const body = new TextEncoder().encode(JSON.stringify({ id: 'evt_x', type: 'funding.succeeded', mode: 'test', account: provider.accountId, created: FIXED_NOW.toISOString(), data: { objectType: 'funding', amount: 1.5 } }));
    const headers = new Headers({ [MOCK_SIGNATURE_HEADER]: signMockWebhook(body, SECRET, Math.floor(FIXED_NOW.getTime() / 1000)) });
    await expectProviderError(provider.verifyWebhook(body, headers), 'WEBHOOK_PAYLOAD_INVALID');
  });

  it('emits release/refund lifecycle events', async () => {
    const { provider } = makeProvider({ releaseSettlement: 'pending' });
    const intent = await fundedOrder(provider);
    provider.takeWebhookDeliveries();
    const release = await provider.releaseToCreator(
      { fundingReference: intent.reference, orderId: 'order_0001', payeeAccountId: 'acct_creator_0001', amount: 9_700n, currency: 'USD', platformFee: 0n },
      'op_release_events1',
    );
    await provider.simulateReleaseOutcome(release.reference, 'SUCCEEDED');
    const types = [];
    for (const d of provider.takeWebhookDeliveries()) types.push((await provider.verifyWebhook(d.rawBody, d.headers)).type);
    expect(types).toEqual(['release.pending', 'release.succeeded']);
    expect((await provider.getReleaseStatus(release.reference)).status).toBe('SUCCEEDED');
  });
});

describe('notifications', () => {
  const clockNow = () => FIXED_NOW;

  it('formats atomic money without floating point', () => {
    expect(formatAtomicAmount(10_000n, 'USD')).toBe('100.00 USD');
    expect(formatAtomicAmount(5n, 'USD')).toBe('0.05 USD');
    expect(formatAtomicAmount(123_456_789n, 'USDC')).toBe('123.456789 USDC');
    expect(formatAtomicAmount(1_234_567n, 'VND')).toBe('1,234,567 VND');
    expect(formatAtomicAmount(900719925474099312345n, 'USD')).toBe('9,007,199,254,740,993,123.45 USD');
    expect(() => formatAtomicAmount(1n, 'XYZ')).toThrowError(NotificationError);
  });

  it('every template renders with static subject and internal link', () => {
    const samples: { [K in NotificationTemplateId]: unknown } = {
      'auth.email_verification_requested': {},
      'auth.password_reset_requested': {},
      'payment.pending': { orderRef: 'ord_1', amount: 10_000n, currency: 'USD' },
      'payment.confirmed': { orderRef: 'ord_1', amount: 10_000n, currency: 'USD' },
      'order.new': { orderRef: 'ord_1', serviceTitle: 'Launch thread' },
      'order.brief_missing': { orderRef: 'ord_1' },
      'order.due_soon': { orderRef: 'ord_1', dueAt: '2026-09-14T10:00:00Z' },
      'order.delivered': { orderRef: 'ord_1', reviewDeadlineAt: '2026-09-16T10:00:00.000Z' },
      'order.revision_requested': { orderRef: 'ord_1' },
      'order.approved': { orderRef: 'ord_1' },
      'order.review_reminder': { orderRef: 'ord_1', reviewDeadlineAt: '2026-09-16T10:00:00Z' },
      'order.overdue': { orderRef: 'ord_1' },
      'order.completed': { orderRef: 'ord_1' },
      'order.cancellation_requested': { orderRef: 'ord_1' },
      'order.cancellation_resolved': { orderRef: 'ord_1', outcome: 'ACCEPTED' },
      'order.deadline_extension_requested': { orderRef: 'ord_1', newDueAt: '2026-09-20T10:00:00Z' },
      'order.deadline_extension_resolved': { orderRef: 'ord_1', outcome: 'REJECTED' },
      'payment.disputed': { orderRef: 'ord_1', stage: 'LOST' },
      'payout.succeeded': { orderRef: 'ord_1', amount: 9_700n, currency: 'USD' },
      'payout.failed': { orderRef: 'ord_1' },
      'refund.updated': { orderRef: 'ord_1', amount: 10_000n, currency: 'USD', refundStatus: 'PENDING' },
      'dispute.opened': { orderRef: 'ord_1' },
      'dispute.resolved': { orderRef: 'ord_1' },
      'request.application_received': { requestRef: 'req_1' },
      'request.hire_offer': { requestRef: 'req_1' },
      'auction.outbid': { auctionRef: 'auc_1', amount: 5_000n, currency: 'USD' },
      'auction.won': { auctionRef: 'auc_1', amount: 5_000n, currency: 'USD', paymentDueAt: '2026-09-14T10:00:00Z' },
      'auction.expired': { auctionRef: 'auc_1' },
      'pool.asset_missing': { poolRef: 'pool_1', assetCode: 'USDC' },
      'marketing.new_offers': {},
    };
    for (const id of Object.keys(NOTIFICATION_TEMPLATES) as NotificationTemplateId[]) {
      const rendered = renderNotification(id, samples[id] as never);
      expect(rendered.subject).toBe(NOTIFICATION_TEMPLATES[id].subject);
      expect(rendered.linkPath).toMatch(/^\/[A-Za-z0-9_\-/]*$/);
      expect(rendered.body.length).toBeGreaterThan(0);
    }
    expect(renderNotification('payment.confirmed', { orderRef: 'ord_1', amount: 10_000n, currency: 'USD' }).body).toContain('Platform fee: 0');
  });

  it('rejects undeclared params, unsafe refs and control characters', () => {
    expect(() => renderNotification('order.approved', { orderRef: 'ord_1', brief: 'secret brief' } as never)).toThrowError(/not declared/);
    expect(() => renderNotification('order.approved', { orderRef: '../admin?x=1' })).toThrowError(NotificationError);
    expect(() => renderNotification('order.new', { orderRef: 'ord_1', serviceTitle: 'a\nb' })).toThrowError(NotificationError);
    expect(() => renderNotification('order.due_soon', { orderRef: 'ord_1', dueAt: 'tomorrow' })).toThrowError(NotificationError);
    expect(() => renderNotification('nope' as NotificationTemplateId, {} as never)).toThrowError(/unknown template/);
  });

  it('dedupes on recipient + semantic event + channel, including concurrent dispatch', async () => {
    const sink = new LocalNotificationSink();
    const dispatcher = new NotificationDispatcher({ sink, now: clockNow });
    const request = {
      recipientId: 'user_buyer_1',
      templateId: 'payment.confirmed' as const,
      semanticEventKey: 'order:ord_1:payment_confirmed',
      params: { orderRef: 'ord_1', amount: 10_000n, currency: 'USD' },
    };
    const all = await Promise.all(Array.from({ length: 10 }, () => dispatcher.dispatch(request)));
    const statuses = all.flat().map((o) => o.status);
    expect(statuses.filter((s) => s === 'SENT')).toHaveLength(2); // one per channel
    expect(statuses.filter((s) => s === 'DUPLICATE_SUPPRESSED')).toHaveLength(18);
    expect(sink.messages({ recipientId: 'user_buyer_1', channel: 'email' })).toHaveLength(1);
    expect(sink.messages({ recipientId: 'user_buyer_1', channel: 'in_app' })).toHaveLength(1);

    // Different recipient or semantic event is not a duplicate.
    await dispatcher.dispatch({ ...request, recipientId: 'user_buyer_2' });
    await dispatcher.dispatch({ ...request, semanticEventKey: 'order:ord_1:payment_confirmed:v2' });
    expect(sink.messages()).toHaveLength(6);
    expect(notificationDedupeKey('a', 'b', 'email')).not.toBe(notificationDedupeKey('a', 'b', 'in_app'));
  });

  it('adding a channel later only sends the new channel', async () => {
    const sink = new LocalNotificationSink();
    const dispatcher = new NotificationDispatcher({ sink, now: clockNow });
    const base = { recipientId: 'user_c_1', templateId: 'order.approved' as const, semanticEventKey: 'order:ord_9:approved', params: { orderRef: 'ord_9' } };
    await dispatcher.dispatch({ ...base, channels: ['in_app'] });
    const second = await dispatcher.dispatch({ ...base, channels: ['in_app', 'email'] });
    expect(second.map((o) => [o.channel, o.status])).toEqual([
      ['in_app', 'DUPLICATE_SUPPRESSED'],
      ['email', 'SENT'],
    ]);
  });

  it('rejects reusing a semantic key for a different notification', async () => {
    const dispatcher = new NotificationDispatcher({ sink: new LocalNotificationSink(), now: clockNow });
    await dispatcher.dispatch({ recipientId: 'user_1', templateId: 'order.approved', semanticEventKey: 'order:ord_1:evt', params: { orderRef: 'ord_1' } });
    await expect(
      dispatcher.dispatch({ recipientId: 'user_1', templateId: 'order.revision_requested', semanticEventKey: 'order:ord_1:evt', params: { orderRef: 'ord_1' } }),
    ).rejects.toMatchObject({ code: 'DEDUPE_KEY_REUSED' });
  });

  it('records failed attempts, retries the same dedupe key and stops at maxAttempts', async () => {
    const sink = new LocalNotificationSink();
    const dispatcher = new NotificationDispatcher({ sink, now: clockNow, maxAttempts: 3 });
    const request = { recipientId: 'user_2', templateId: 'order.brief_missing' as const, semanticEventKey: 'order:ord_2:brief_missing', params: { orderRef: 'ord_2' }, channels: ['email'] as const };

    sink.failNext(1);
    expect((await dispatcher.dispatch(request))[0]).toMatchObject({ status: 'FAILED', attemptCount: 1 });
    expect((await dispatcher.dispatch(request))[0]).toMatchObject({ status: 'SENT', attemptCount: 2 });
    expect((await dispatcher.dispatch(request))[0]).toMatchObject({ status: 'DUPLICATE_SUPPRESSED' });
    expect(dispatcher.attempts().map((a) => a.status)).toEqual(['FAILED', 'SENT']);
    expect(sink.messages()).toHaveLength(1);

    const stuck = { ...request, semanticEventKey: 'order:ord_2:brief_missing:stuck' };
    sink.failNext(10);
    for (let i = 0; i < 3; i++) expect((await dispatcher.dispatch(stuck))[0]?.status).toBe('FAILED');
    expect((await dispatcher.dispatch(stuck))[0]).toMatchObject({ status: 'FAILED', error: 'MAX_ATTEMPTS_EXCEEDED', attemptCount: 3 });
  });

  it('marketing requires opt-in; transactional ignores marketing preference', async () => {
    const sink = new LocalNotificationSink();
    const optedIn = new Set(['user_yes']);
    const dispatcher = new NotificationDispatcher({ sink, now: clockNow, preferences: (id) => ({ marketingOptIn: optedIn.has(id) }) });
    const promo = { templateId: 'marketing.new_offers' as const, semanticEventKey: 'marketing:2026-09-13', params: {} };
    expect((await dispatcher.dispatch({ ...promo, recipientId: 'user_no' }))[0]?.status).toBe('SUPPRESSED_BY_PREFERENCE');
    expect((await dispatcher.dispatch({ ...promo, recipientId: 'user_yes' }))[0]?.status).toBe('SENT');
    optedIn.add('user_no');
    expect((await dispatcher.dispatch({ ...promo, recipientId: 'user_no' }))[0]?.status).toBe('SENT');
    const tx = await dispatcher.dispatch({ recipientId: 'user_other', templateId: 'dispute.opened', semanticEventKey: 'order:o1:dispute', params: { orderRef: 'o1' } });
    expect(tx.every((o) => o.status === 'SENT')).toBe(true);
  });

  it('rejects channels not allowed by the template', async () => {
    const dispatcher = new NotificationDispatcher({ sink: new LocalNotificationSink(), now: clockNow });
    await expect(
      dispatcher.dispatch({ recipientId: 'user_1', templateId: 'auth.password_reset_requested', semanticEventKey: 'auth:reset:1', params: {}, channels: ['in_app'] }),
    ).rejects.toMatchObject({ code: 'CHANNEL_NOT_ALLOWED' });
  });
});
