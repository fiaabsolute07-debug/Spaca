/** Eligible service views for trending (P5-04): hashed viewer, one per service per day, owner excluded, daily cap. */
import { createHash } from 'node:crypto';
import type { Actor } from '@/lib/auth';
import { UUID_PATTERN, type Row } from '@/lib/commands';
import { sql } from '@/lib/db';

export const MAX_COUNTED_SERVICES_PER_VIEWER_PER_DAY = 50;

export function viewerHashFor(identity: string): string {
  const salt = process.env.VIEW_HASH_SALT || (process.env.NODE_ENV === 'production' ? '' : 'local_dev_only_view_salt');
  if (!salt) throw new Error('VIEW_HASH_SALT is required to count views');
  return createHash('sha256').update(`${salt}:${identity}`).digest('hex');
}

export async function recordServiceView(input: { serviceId: string; actor: Actor | null; clientKey: string }): Promise<{ counted: boolean; reason?: string }> {
  if (!UUID_PATTERN.test(input.serviceId)) return { counted: false, reason: 'NOT_FOUND' };
  const identity = input.actor ? `user:${input.actor.id}` : `anon:${input.clientKey}`;
  if (!input.actor && input.clientKey.length < 8) return { counted: false, reason: 'NO_VIEWER_KEY' };
  const hash = viewerHashFor(identity);
  return sql.begin(async (tx) => {
    const [service] = await tx<Row[]>`select creator_id from app.services where id=${input.serviceId} and status='PUBLISHED'`;
    if (!service) return { counted: false, reason: 'NOT_FOUND' };
    if (input.actor && String(service.creator_id) === input.actor.id) return { counted: false, reason: 'OWNER' };
    await tx`select pg_advisory_xact_lock(hashtextextended(${`views:${hash}`}, 0))`;
    const [{ today }] = await tx<{ today: number }[]>`select count(*)::int as today from app.service_views where viewer_hash=${hash} and view_date=current_date`;
    if (today >= MAX_COUNTED_SERVICES_PER_VIEWER_PER_DAY) return { counted: false, reason: 'DAILY_CAP' };
    const inserted = await tx`insert into app.service_views (service_id,viewer_hash,view_date) values (${input.serviceId},${hash},current_date) on conflict do nothing returning service_id`;
    return inserted.length ? { counted: true } : { counted: false, reason: 'ALREADY_COUNTED_TODAY' };
  });
}
