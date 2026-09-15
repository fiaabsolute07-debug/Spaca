import { NextResponse } from 'next/server';
import { getActor } from '@/lib/auth';
import { UUID_PATTERN } from '@/lib/commands';
import { sql } from '@/lib/db';
import { applicationsCsv } from '@/modules/requests/compare';

/** GET → CSV of a campaign's applications, for its buyer only (REQ-11). Anyone else gets 404. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!UUID_PATTERN.test(id)) return new NextResponse(null, { status: 404 });
  const actor = await getActor();
  if (!actor) return new NextResponse(null, { status: 404 });
  const [owned] = await sql`select id from app.requests where id=${id} and buyer_id=${actor.id}`;
  if (!owned) return new NextResponse(null, { status: 404 });
  const rows = await sql<Record<string, unknown>[]>`select a.status,a.quote_minor,a.turnaround_hours,a.version,a.valid_until,a.note,a.created_at,a.updated_at,
      u.display_name as creator_name,p.handle as creator_handle,o.status as offer_status
    from app.applications a join app.users u on u.id=a.creator_id left join app.profiles p on p.user_id=a.creator_id
    left join lateral (select h.status from app.hire_offers h where h.application_id=a.id order by h.created_at desc limit 1) o on true
    where a.request_id=${id} order by a.created_at asc, a.id asc`;
  return new NextResponse(applicationsCsv(rows), {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="campaign-${id.slice(0, 8)}-applications.csv"`,
      'cache-control': 'no-store',
    },
  });
}
