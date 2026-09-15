import { NextResponse } from 'next/server';
import { getActor, isSameOrigin, publicUrl } from '@/lib/auth';
import { withNotice } from '@/lib/notices';
import { logError } from '@/lib/log';
import { sql } from '@/lib/db';
import { isProviderError } from '@/modules/payments/providers';
import { PaymentFlowError, completeMockCheckout, mockPaymentsEnabled } from '@/modules/payments/funding';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Local stand-in for a provider-hosted checkout page. It does not mark anything paid: it asks the mock
 * provider to confirm the buyer's payment, and the order changes only when the resulting signed webhook
 * is verified and processed. Returns 404 outside local mock mode.
 */
export async function POST(request: Request) {
  if (!mockPaymentsEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'Origin not allowed' }, { status: 403 });
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  const form = await request.formData();
  const orderId = String(form.get('order_id') ?? '');
  const outcome = form.get('outcome') === 'FAILED' ? 'FAILED' : 'SUCCEEDED';
  const wantsJson = (request.headers.get('accept') ?? '').includes('application/json');
  const respond = (status: number, body: Record<string, unknown>, message: string, kind: 'message' | 'error') =>
    wantsJson
      ? NextResponse.json(body, { status })
      : NextResponse.redirect(publicUrl(request, withNotice(`/orders/${UUID.test(orderId) ? orderId : ''}`, kind, message)), 303);

  if (!UUID.test(orderId)) return respond(400, { error: 'order_id is invalid' }, 'Order reference is invalid', 'error');
  try {
    const { intent, receipts } = await completeMockCheckout(actor.id, orderId, outcome);
    if (intent.state !== 'READY') {
      const message = intent.state === 'RETRY' ? 'The provider did not confirm the payment request; retry to resume the same payment attempt.' : `The provider rejected the payment request (${intent.code}).`;
      return respond(intent.state === 'RETRY' ? 503 : 400, { error: message, state: intent.state, code: intent.code, operationId: intent.operationId }, message, 'error');
    }
    const funded = receipts.some((r) => r.outcome === 'FUNDED');
    // DIGITAL purchases are delivered on payment (XPL-05), so there is no work for the creator to start.
    const [order] = funded ? await sql<{ digital: boolean }[]>`select (terms ? 'digital') as digital from app.orders where id=${orderId}` : [];
    const message = !funded ? 'Payment submitted; waiting for provider confirmation.'
      : order?.digital ? 'Payment confirmed by the provider. Your files are ready to download.' : 'Payment confirmed by the provider. The creator can start work.';
    return respond(200, { state: intent.state, reference: intent.reference, receipts }, message, 'message');
  } catch (error) {
    if (error instanceof PaymentFlowError) return respond(error.code === 'FORBIDDEN' ? 403 : 400, { error: error.message }, error.message, 'error');
    if (isProviderError(error)) return respond(400, { error: 'Provider rejected the request', code: error.code }, 'The provider rejected the payment request.', 'error');
    logError('mock checkout failed', error, { order_id: orderId });
    return respond(500, { error: 'Checkout failed; retry' }, 'Checkout failed; retry.', 'error');
  }
}
