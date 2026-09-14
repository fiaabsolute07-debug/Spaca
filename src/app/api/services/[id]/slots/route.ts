import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { isFlagEnabled } from '@/modules/admin/policy';
import { MAX_SLOT_QUERY_DAYS, freeSlots } from '@/modules/access';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET free session starts for a published ACCESS service (XPL-03). Returns UTC instants only; the page renders them
 * in the viewer's time zone. No booked-by data is exposed, just which starts are still free.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!UUID.test(id)) return NextResponse.json({ error: 'Service not found' }, { status: 404 });
  const url = new URL(request.url);
  const fromValue = url.searchParams.get('from');
  const from = fromValue ? new Date(fromValue) : new Date();
  const days = Number(url.searchParams.get('days') ?? 7);
  if (Number.isNaN(from.getTime()) || !Number.isInteger(days) || days < 1 || days > MAX_SLOT_QUERY_DAYS) {
    return NextResponse.json({ error: `from must be an ISO time and days 1–${MAX_SLOT_QUERY_DAYS}` }, { status: 400 });
  }
  const [service] = await sql<Record<string, unknown>[]>`select s.creator_id,v.taxonomy,v.access_session_minutes,v.access_buffer_minutes
    from app.services s join app.service_versions v on v.id=s.published_version_id join app.users u on u.id=s.creator_id
    where s.id=${id} and s.status='PUBLISHED' and u.status='ACTIVE'`;
  if (!service || service.taxonomy !== 'ACCESS') return NextResponse.json({ error: 'Service not found' }, { status: 404 });
  if (!(await isFlagEnabled(sql, 'ACCESS_BOOKING_ENABLED'))) return NextResponse.json({ error: 'Session booking is switched off', slots: [] }, { status: 503 });
  const slots = await freeSlots(sql, {
    creatorId: String(service.creator_id), sessionMinutes: Number(service.access_session_minutes), bufferMinutes: Number(service.access_buffer_minutes), from, days,
  });
  return NextResponse.json(
    { session_minutes: Number(service.access_session_minutes), slots: slots.map((slot) => new Date(slot).toISOString()) },
    { headers: { 'cache-control': 'no-store' } },
  );
}
