import { NextResponse } from 'next/server';
import { runJobsOnce } from '@/modules/jobs';
import { mockPaymentsEnabled } from '@/modules/payments/funding';

/**
 * Local scheduler hook: runs every durable job once inside the Next.js process (where the in-memory
 * mock provider lives). Deployed environments schedule the same functions from Inngest/cron instead.
 * 404 outside local mock mode; browser requests must be same-origin.
 */
export async function POST(request: Request) {
  if (!mockPaymentsEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return NextResponse.json({ error: 'Origin not allowed' }, { status: 403 });
  return NextResponse.json({ reports: await runJobsOnce() });
}
