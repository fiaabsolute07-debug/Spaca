import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { getActor, isSameOrigin, publicUrl } from '@/lib/auth';
import { deliverPendingMockWebhooks, getMockPaymentProvider, mockPaymentsEnabled } from '@/modules/payments/funding';
import { isProviderError } from '@/modules/payments/providers';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OUTCOMES = ['SENT', 'SETTLED', 'FAILED', 'RETURNED'] as const;

/**
 * Local sandbox stand-in for the buyer's bank and the provider. It never marks anything paid itself: the mock provider
 * changes the transfer and the order changes only when the resulting signed webhook is verified. 404 outside mock mode.
 */
export async function POST(request: Request) {
  if (!mockPaymentsEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'Origin not allowed' }, { status: 403 });
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  const form = await request.formData();
  const orderId = String(form.get('order_id') ?? '');
  const outcome = String(form.get('outcome') ?? '') as (typeof OUTCOMES)[number];
  const back = (kind: 'message' | 'error', message: string) => NextResponse.redirect(publicUrl(request, `/orders/${UUID.test(orderId) ? orderId : ''}?${kind}=${encodeURIComponent(message)}`), 303);
  if (!UUID.test(orderId) || !OUTCOMES.includes(outcome)) return back('error', 'Unknown sandbox bank action');
  const [transfer] = await sql`select p.provider_reference from app.provider_operations p join app.orders o on o.id=p.order_id
    where p.order_id=${orderId} and o.buyer_id=${actor.id} and p.kind='funding.create' and p.outcome->>'method'='BANK_TRANSFER' and p.provider_reference is not null
    order by p.created_at desc limit 1`;
  if (!transfer) return back('error', 'No bank transfer was requested for this order');
  const provider = getMockPaymentProvider();
  const reference = String(transfer.provider_reference);
  try {
    if (outcome === 'RETURNED') await provider.simulateBankReturn(reference);
    else await provider.simulateFundingOutcome(reference, { status: outcome === 'SENT' ? 'PROCESSING' : outcome === 'SETTLED' ? 'SUCCEEDED' : 'FAILED' });
  } catch (error) {
    if (isProviderError(error)) return back('error', `The sandbox bank cannot do that now (${error.code})`);
    throw error;
  }
  await deliverPendingMockWebhooks();
  return back('message', { SENT: 'Sandbox: the bank transfer is on its way.', SETTLED: 'Sandbox: the bank settled the transfer.', FAILED: 'Sandbox: the bank transfer failed.', RETURNED: 'Sandbox: the bank returned the transfer.' }[outcome]);
}
