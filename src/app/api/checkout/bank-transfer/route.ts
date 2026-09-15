import { NextResponse } from 'next/server';
import { getActor, isSameOrigin, publicUrl } from '@/lib/auth';
import { withNotice } from '@/lib/notices';
import { PaymentFlowError, mockPaymentsEnabled, startBankTransfer } from '@/modules/payments/funding';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * BNK-01: the buyer chooses to pay by bank transfer. Returns the provider's transfer reference; the order stays awaiting
 * payment until the provider confirms the money arrived. Refused while BANK_FUNDING_ENABLED is off or the provider
 * account cannot take bank transfers (BNK-03). Only the mock provider exists locally.
 */
export async function POST(request: Request) {
  if (!mockPaymentsEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'Origin not allowed' }, { status: 403 });
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  const form = await request.formData();
  const orderId = String(form.get('order_id') ?? '');
  const wantsJson = (request.headers.get('accept') ?? '').includes('application/json');
  const respond = (status: number, body: Record<string, unknown>, message: string, kind: 'message' | 'error') => wantsJson
    ? NextResponse.json(body, { status })
    : NextResponse.redirect(publicUrl(request, withNotice(`/orders/${UUID.test(orderId) ? orderId : ''}`, kind, message)), 303);
  if (!UUID.test(orderId)) return respond(400, { error: 'order_id is invalid' }, 'Order reference is invalid', 'error');
  try {
    const { intent, holdUntil } = await startBankTransfer(actor.id, orderId);
    if (intent.state === 'READY') {
      const message = 'Bank transfer details are ready. Work starts only after the bank confirms the transfer.';
      return respond(200, { state: intent.state, reference: intent.reference, hold_until: holdUntil }, message, 'message');
    }
    if (intent.state === 'RETRY') return respond(503, { error: 'The provider did not confirm; retry', state: intent.state }, 'The provider did not confirm the bank transfer request; retry.', 'error');
    const unsupported = intent.code === 'UNSUPPORTED_CAPABILITY';
    const message = unsupported ? 'Bank transfer is not supported for this payment.' : `The provider rejected the bank transfer request (${intent.code}).`;
    return respond(400, { error: message, code: intent.code }, message, 'error');
  } catch (error) {
    if (error instanceof PaymentFlowError) {
      const status = error.code === 'FORBIDDEN' ? 403 : error.code === 'UNAVAILABLE' ? 422 : 409;
      return respond(status, { error: error.message, code: error.code === 'UNAVAILABLE' ? 'FEATURE_DISABLED' : error.code }, error.message, 'error');
    }
    console.error('bank transfer start failed', error);
    return respond(500, { error: 'Bank transfer request failed; retry' }, 'Bank transfer request failed; retry.', 'error');
  }
}
