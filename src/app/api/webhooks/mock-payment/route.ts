import { NextResponse } from 'next/server';
import { logError } from '@/lib/log';
import { isProviderError } from '@/modules/payments/providers';
import { mockPaymentsEnabled, receivePaymentWebhook } from '@/modules/payments/funding';

const MAX_WEBHOOK_BYTES = 64_000;

/** Signed provider webhooks. 2xx only after the event is durably stored; invalid signatures never reach the inbox. */
export async function POST(request: Request) {
  if (!mockPaymentsEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const rawBody = new Uint8Array(await request.arrayBuffer());
  if (rawBody.byteLength > MAX_WEBHOOK_BYTES) return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  try {
    const receipt = await receivePaymentWebhook(rawBody, request.headers);
    return NextResponse.json({ received: true, duplicate: receipt.duplicate });
  } catch (error) {
    if (isProviderError(error)) return NextResponse.json({ error: 'Invalid webhook' }, { status: 400 });
    logError('mock payment webhook processing failed', error);
    return NextResponse.json({ error: 'Temporarily unable to process webhook', retryable: true }, { status: 500 });
  }
}
