import { NextResponse } from 'next/server';
import { getActor, isSameOrigin } from '@/lib/auth';
import { UUID_PATTERN, type Row } from '@/lib/commands';
import { sql } from '@/lib/db';
import { mockPaymentsEnabled } from '@/modules/payments/funding';

/**
 * Local testing only: brings a performance checkpoint (or its checking period) forward so the measurement jobs can run
 * now instead of a week from now. It never invents a view count and never changes a measured fact; it only moves the
 * clock fields the jobs read. 404 outside local mock mode, and only for someone on the order.
 */
export async function POST(request: Request) {
  if (!mockPaymentsEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (request.headers.get('origin') && !isSameOrigin(request)) return NextResponse.json({ error: 'Origin not allowed' }, { status: 403 });
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: 'Sign in first' }, { status: 401 });
  const input = (await request.json().catch(() => ({}))) as { order_id?: string };
  const orderId = String(input.order_id ?? '');
  if (!UUID_PATTERN.test(orderId)) return NextResponse.json({ error: 'order_id is required' }, { status: 400 });
  const [order] = await sql<Row[]>`select id from app.orders where id=${orderId} and (buyer_id=${actor.id} or creator_id=${actor.id})`;
  if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 });
  const [measurement] = await sql<Row[]>`select * from app.performance_measurements where order_id=${orderId}`;
  if (!measurement) return NextResponse.json({ error: 'This order has no performance measurement' }, { status: 404 });

  if (measurement.status === 'SCHEDULED') {
    // measure_at is immutable, so the pending checkpoint is rewritten as a whole row; nothing was measured yet.
    await sql.begin(async (tx) => {
      await tx`delete from app.performance_measurements where order_id=${orderId} and status='SCHEDULED'`;
      await tx`insert into app.performance_measurements (order_id,baseline_id,baseline_median,views_cap,rpm_rate_minor,bonus_cap_minor,post_url,published_at,measure_at,source)
        values (${orderId},${String(measurement.baseline_id)},${String(measurement.baseline_median)},${String(measurement.views_cap)},${String(measurement.rpm_rate_minor)},
          ${String(measurement.bonus_cap_minor)},${String(measurement.post_url)},${new Date(String(measurement.published_at)).toISOString()},now() - interval '1 minute',${String(measurement.source)})`;
    });
    return NextResponse.json({ moved: 'checkpoint', next: 'POST /api/dev/jobs to measure the post' });
  }
  if (measurement.status === 'MEASURED') {
    await sql`update app.performance_measurements set verify_until=now() - interval '1 minute' where order_id=${orderId} and status='MEASURED'`;
    return NextResponse.json({ moved: 'verification', next: 'POST /api/dev/jobs to settle the bonus' });
  }
  return NextResponse.json({ moved: null, status: measurement.status });
}
