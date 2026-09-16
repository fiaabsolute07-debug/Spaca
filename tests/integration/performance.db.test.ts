import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockPaymentProvider } from '@/modules/payments/providers';
import { baselineFor, postViews } from '@/modules/publish/metrics';
import { MIN_ELIGIBLE_POSTS, settleMeasurement, viewsCap } from '@/modules/publish/performance';
import { RUN_DB, callRoute, commandInstant, createPublishedService, createUser, key, linkXAccount, sessionState, xHandle, type TestUser } from './harness';

vi.mock('next/headers', () => ({
  cookies: async () => {
    const token = sessionState.token;
    return { get: (name: string) => (token && name === 'creator_session' ? { name, value: token } : undefined), getAll: () => [], set: () => {}, delete: () => {} };
  },
}));

const commands = await import('@/app/api/commands/route');
const checkout = await import('@/app/api/dev/mock-checkout/route');
const funding = await import('@/modules/payments/funding');
const jobs = await import('@/modules/jobs');
const { sql } = await import('@/lib/db');

const command = (actor: TestUser | null, fields: Record<string, string>) => callRoute(commands.POST, '/api/commands', actor, fields);
const pay = (actor: TestUser, orderId: string) => callRoute(checkout.POST, '/api/dev/mock-checkout', actor, { order_id: orderId });
const wallClock = (date: Date) => date.toISOString().slice(0, 16);
const brief = 'Post your own testnet walkthrough for builders, with the disclosure and a link to our docs.';
const setFlag = (enabled: boolean) => sql`update app.feature_flags set enabled=${enabled} where key='PERFORMANCE_CAMPAIGNS_ENABLED'`;

/** A handle the mock metrics treat as having enough recent posts to price a bonus from. */
function eligibleHandle(): string {
  for (let attempt = 0; attempt < 200; attempt++) {
    const handle = xHandle();
    if (baselineFor({ handle, accountId: handle }).eligible) return handle;
  }
  throw new Error('no eligible handle');
}

/** A post link on the creator's own channel whose mock metrics either look earned or raise a signal. */
function postUrlFor(handle: string, baselineMedian: bigint, wantSignals: boolean): string {
  for (let n = 1; n < 2000; n++) {
    const url = `https://x.com/${handle}/status/${1834567890000 + n}`;
    if ((postViews({ postUrl: url, baselineMedian }).signals.length > 0) === wantSignals) return url;
  }
  throw new Error(`no post url with signals=${wantSignals}`);
}

const campaignFields = (extra: Record<string, string> = {}) => ({
  command: 'create_request', idempotency_key: key('req'), title: 'Performance launch threads', taxonomy: 'PUBLISH', brief,
  budget: '500', target_hires: '2', deadline: commandInstant(new Date(Date.now() + 14 * 86_400_000)),
  publish_platform: 'X', publish_format: 'POST', min_live_hours: '72', disclosure_text: '#ad',
  payment_model: 'PERFORMANCE', base_fee: '20', rpm_rate: '2', bonus_cap: '80', measure_after_days: '7', verify_days: '7', median_multiplier: '3',
  ...extra,
});

/** Hires one creator on a performance campaign and funds the order, which holds fee + bonus cap. */
async function hirePerformance(label: string) {
  const buyer = await createUser(`${label}-buyer`);
  const creator = await createUser(`${label}-creator`);
  await createPublishedService(command, creator, { capacity: 3 });
  const handle = eligibleHandle();
  const channel = await linkXAccount(command, creator, handle);
  const created = await command(buyer, campaignFields());
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const requestId = String(created.body.id);
  const applied = await command(creator, {
    command: 'apply', idempotency_key: key('ap'), request_id: requestId, quote: '20', turnaround_hours: '48',
    note: 'I post weekly testnet walkthroughs for builders on my own account.', publish_account_id: channel.accountId,
  });
  expect(applied.status, JSON.stringify(applied.body)).toBe(200);
  const [application] = await sql`select id,version from app.applications where request_id=${requestId}`;
  const offer = await command(buyer, { command: 'select_application', idempotency_key: key('sel'), application_id: String(application!.id), application_version: String(application!.version) });
  expect(offer.status, JSON.stringify(offer.body)).toBe(200);
  const accepted = await command(creator, { command: 'accept_offer', idempotency_key: key('acc'), offer_id: String(offer.body.id) });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  const orderId = String(accepted.body.id);
  expect((await pay(buyer, orderId)).status).toBe(200);
  expect((await command(creator, { command: 'start', idempotency_key: key('st'), order_id: orderId })).status).toBe(200);
  return { buyer, creator, handle, requestId, orderId };
}

/** Delivers the post and approves it, leaving the order waiting on its checkpoint. */
async function deliverAndApprove(hire: { buyer: TestUser; creator: TestUser; orderId: string }, postUrl: string) {
  const delivered = await command(hire.creator, {
    command: 'deliver', idempotency_key: key('del'), order_id: hire.orderId, post_url: postUrl,
    published_at: wallClock(new Date()), disclosure_attested: 'on',
  });
  expect(delivered.status, JSON.stringify(delivered.body)).toBe(200);
  const approved = await command(hire.buyer, { command: 'approve', idempotency_key: key('app'), order_id: hire.orderId, delivery_version: '1' });
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
}

/** The checkpoint is days away; re-scheduling it into the past never rewrites anything already measured. */
async function bringCheckpointForward(orderId: string) {
  const [row] = await sql`select * from app.performance_measurements where order_id=${orderId} and status='SCHEDULED'`;
  expect(row).toBeTruthy();
  await sql`delete from app.performance_measurements where order_id=${orderId} and status='SCHEDULED'`;
  await sql`insert into app.performance_measurements (order_id,baseline_id,baseline_median,views_cap,rpm_rate_minor,bonus_cap_minor,post_url,published_at,measure_at,source)
    values (${orderId},${String(row!.baseline_id)},${String(row!.baseline_median)},${String(row!.views_cap)},${String(row!.rpm_rate_minor)},${String(row!.bonus_cap_minor)},
      ${String(row!.post_url)},${new Date(String(row!.published_at)).toISOString()},now() - interval '1 hour',${String(row!.source)})`;
  return row!;
}

beforeEach(async () => {
  if (!RUN_DB) return;
  funding.setMockPaymentProviderForTests(new MockPaymentProvider({ accountId: 'acct_mock_local', webhookSecrets: ['whsec_performance_suite_1'] }));
  await setFlag(true);
});
afterAll(async () => {
  if (!RUN_DB) return;
  await setFlag(false);
  funding.setMockPaymentProviderForTests(undefined);
  await sql.end({ timeout: 5 });
});

describe.skipIf(!RUN_DB)('§9.6 — a performance hire holds the maximum and pays for measured reach', () => {
  it('freezes the creator median at hire, holds fee plus bonus cap, and refuses quotes that are not the fixed fee', async () => {
    const hire = await hirePerformance('perf-hold');
    const [order] = await sql`select amount_minor,terms from app.orders where id=${hire.orderId}`;
    // 20 USD fee + 80 USD cap: the campaign can never be charged more than 100 USD for this hire.
    expect(String(order!.amount_minor)).toBe('10000');
    const terms = (order!.terms as { performance: Record<string, string | number> }).performance;
    const baseline = baselineFor({ handle: hire.handle, accountId: hire.handle });
    expect(terms).toMatchObject({
      policy_version: 'performance-v1', base_fee_minor: '2000', rpm_rate_minor: '200', bonus_cap_minor: '8000',
      max_payout_minor: '10000', measure_after_days: 7, verify_days: 7, baseline_source: 'mock-metrics-v1',
      baseline_median: baseline.median_views.toString(), views_cap: viewsCap(baseline.median_views, 3).toString(),
    });
    const [frozen] = await sql`select creator_id,eligible_posts,median_views from app.performance_baselines where id=${String(terms.baseline_id)}`;
    expect(frozen).toMatchObject({ creator_id: hire.creator.id, eligible_posts: baseline.eligible_posts });
    expect(String(frozen!.median_views)).toBe(baseline.median_views.toString());
    await expect(sql`update app.performance_baselines set median_views=999999 where id=${String(terms.baseline_id)}`).rejects.toThrow();

    // A creator who quotes anything but the fixed fee has to re-apply at it.
    const other = await createUser('perf-hold-other');
    await createPublishedService(command, other, { capacity: 2 });
    const channel = await linkXAccount(command, other, eligibleHandle());
    expect((await command(other, {
      command: 'apply', idempotency_key: key('ap2'), request_id: hire.requestId, quote: '35', turnaround_hours: '48',
      note: 'I would post this for a higher fixed fee than the campaign offers.', publish_account_id: channel.accountId,
    })).status).toBe(200);
    const [second] = await sql`select id,version from app.applications where request_id=${hire.requestId} and creator_id=${other.id}`;
    const refused = await command(hire.buyer, { command: 'select_application', idempotency_key: key('sel2'), application_id: String(second!.id), application_version: String(second!.version) });
    expect(refused.status).toBe(409);
    expect(String(refused.body.error)).toMatch(/pays its fixed fee/);
  });

  it('measures the post once at its checkpoint, pays capped views, and returns the unused hold to the buyer', async () => {
    const hire = await hirePerformance('perf-pay');
    const baseline = baselineFor({ handle: hire.handle, accountId: hire.handle });
    const postUrl = postUrlFor(hire.handle, baseline.median_views, false);
    await deliverAndApprove(hire, postUrl);

    const scheduled = await sql`select status,measure_at,published_at,views_cap from app.performance_measurements where order_id=${hire.orderId}`;
    expect(scheduled[0]).toMatchObject({ status: 'SCHEDULED' });
    expect(new Date(String(scheduled[0]!.measure_at)).getTime() - new Date(String(scheduled[0]!.published_at)).getTime()).toBe(7 * 86_400_000);

    // Nothing is released while the bonus is unknown, even though the buyer approved the work.
    await jobs.releaseReadySettlements({ orderId: hire.orderId });
    expect((await sql`select count(*)::int as n from app.provider_operations where order_id=${hire.orderId} and kind='release.create'`)[0]!.n).toBe(0);

    await bringCheckpointForward(hire.orderId);
    const measured = await jobs.measurePerformancePosts({ orderId: hire.orderId });
    expect(measured.outcomes).toMatchObject({ MEASURED: 1 });
    const metrics = postViews({ postUrl, baselineMedian: baseline.median_views });
    const expected = settleMeasurement({
      measuredViews: metrics.views, viewsCap: viewsCap(baseline.median_views, 3),
      rpmRateMinor: 200n, bonusCapMinor: 8000n, baseFeeMinor: 2000n,
    });
    const [row] = await sql`select status,measured_views,views_payable,bonus_minor,verify_until from app.performance_measurements where order_id=${hire.orderId}`;
    expect(row).toMatchObject({ status: 'MEASURED' });
    expect([String(row!.measured_views), String(row!.views_payable), String(row!.bonus_minor)])
      .toEqual([metrics.views.toString(), expected.viewsPayable.toString(), expected.bonusMinor.toString()]);
    // A measured count is a fact: it never changes afterwards.
    await expect(sql`update app.performance_measurements set measured_views=1 where order_id=${hire.orderId}`).rejects.toThrow(/never changes/);

    // Still nothing released while the verification window runs.
    await jobs.releaseReadySettlements({ orderId: hire.orderId });
    expect((await sql`select count(*)::int as n from app.provider_operations where order_id=${hire.orderId} and kind='release.create'`)[0]!.n).toBe(0);

    await sql`update app.performance_measurements set verify_until=now() - interval '1 minute' where order_id=${hire.orderId}`;
    const settled = await jobs.settlePerformanceBonuses({ orderId: hire.orderId });
    expect(Object.keys(settled.outcomes)[0]).toMatch(/UNUSED_HOLD_REFUNDED|BONUS_FULLY_EARNED/);
    const [afterSettle] = await sql`select performance_refund_minor,payment_status from app.orders where id=${hire.orderId}`;
    expect(String(afterSettle!.performance_refund_minor)).toBe(expected.refundMinor.toString());

    await jobs.releaseReadySettlements({ orderId: hire.orderId });
    const [release] = await sql`select operation_id,outcome from app.provider_operations where order_id=${hire.orderId} and kind='release.create'`;
    expect(String(release!.operation_id)).toBe(expected.refundMinor > 0n ? `release:${hire.orderId}:performance` : `release:${hire.orderId}:full`);
    const [order] = await sql`select provider_fee_minor,amount_minor from app.orders where id=${hire.orderId}`;
    const providerFee = order!.provider_fee_minor == null ? 0n : BigInt(String(order!.provider_fee_minor));
    // The creator receives the fixed fee plus the earned bonus, minus the provider's own cost.
    expect(String((release!.outcome as Record<string, string>).netAmount)).toBe((expected.payoutMinor - providerFee).toString());
    if (expected.refundMinor > 0n) {
      const [refund] = await sql`select operation_id,status from app.provider_operations where order_id=${hire.orderId} and kind='refund.create'`;
      expect(refund).toMatchObject({ operation_id: `refund:${hire.orderId}:performance`, status: 'SUCCEEDED' });
    }
  });

  it('holds a bonus that does not look earned, and keeps the money until a person decides', async () => {
    const hire = await hirePerformance('perf-hold-review');
    const baseline = baselineFor({ handle: hire.handle, accountId: hire.handle });
    const postUrl = postUrlFor(hire.handle, baseline.median_views, true);
    await deliverAndApprove(hire, postUrl);
    await bringCheckpointForward(hire.orderId);

    const measured = await jobs.measurePerformancePosts({ orderId: hire.orderId });
    expect(measured.outcomes).toMatchObject({ HELD: 1 });
    const [row] = await sql`select status,hold_reason,verify_until,bonus_minor from app.performance_measurements where order_id=${hire.orderId}`;
    expect(row!.status).toBe('HELD');
    expect(String(row!.hold_reason)).toMatch(/VIEWS_FAR_ABOVE_MEDIAN|ENGAGEMENT_TOO_LOW_FOR_VIEWS/);
    expect(row!.verify_until).toBeNull();
    // An operator picks it up, and nothing settles on its own.
    const [openCase] = await sql`select kind,status from app.reconciliation_cases where order_id=${hire.orderId} and kind='PERFORMANCE_BONUS_REVIEW'`;
    expect(openCase).toBeTruthy();
    await jobs.settlePerformanceBonuses({ orderId: hire.orderId });
    await jobs.releaseReadySettlements({ orderId: hire.orderId });
    expect((await sql`select count(*)::int as n from app.provider_operations where order_id=${hire.orderId} and kind in ('release.create','refund.create')`)[0]!.n).toBe(0);
    expect((await sql`select performance_refund_minor from app.orders where id=${hire.orderId}`)[0]!.performance_refund_minor).toBeNull();
  });

  it('refuses performance terms that are off, not PUBLISH, unaffordable, or for a creator without enough posts', async () => {
    const buyer = await createUser('perf-guard-buyer');
    await setFlag(false);
    const disabled = await command(buyer, campaignFields());
    expect(disabled.status).toBe(422);
    expect(String(disabled.body.error)).toMatch(/temporarily unavailable/);
    await setFlag(true);

    const wrongKind = await command(buyer, campaignFields({ taxonomy: 'CREATE' }));
    expect(wrongKind.status).toBe(400);
    expect(String(wrongKind.body.error)).toMatch(/PUBLISH category/);

    const tooSmall = await command(buyer, campaignFields({ budget: '60' }));
    expect(tooSmall.status).toBe(422);
    expect(String(tooSmall.body.error)).toMatch(/fixed fee plus the bonus cap/);

    // A creator the metrics show as too new for a priced bonus cannot be hired on this model.
    const created = await command(buyer, campaignFields());
    expect(created.status).toBe(200);
    const requestId = String(created.body.id);
    const newcomer = await createUser('perf-guard-newcomer');
    await createPublishedService(command, newcomer, { capacity: 2 });
    let thinHandle = xHandle();
    for (let attempt = 0; attempt < 200 && baselineFor({ handle: thinHandle, accountId: thinHandle }).eligible; attempt++) thinHandle = xHandle();
    const thin = baselineFor({ handle: thinHandle, accountId: thinHandle });
    expect(thin.eligible_posts).toBeLessThan(MIN_ELIGIBLE_POSTS);
    const channel = await linkXAccount(command, newcomer, thinHandle);
    expect((await command(newcomer, {
      command: 'apply', idempotency_key: key('ap'), request_id: requestId, quote: '20', turnaround_hours: '48',
      note: 'I am new here but post about testnets every week for builders.', publish_account_id: channel.accountId,
    })).status).toBe(200);
    const [application] = await sql`select id,version from app.applications where request_id=${requestId} and creator_id=${newcomer.id}`;
    const refused = await command(buyer, { command: 'select_application', idempotency_key: key('sel'), application_id: String(application!.id), application_version: String(application!.version) });
    expect(refused.status).toBe(422);
    expect(String(refused.body.error)).toMatch(new RegExp(`at least ${MIN_ELIGIBLE_POSTS}`));
  });
});
