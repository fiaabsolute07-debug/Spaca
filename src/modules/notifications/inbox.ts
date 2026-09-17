/**
 * The in-app inbox behind the header's bell (2026-09-17): how many notifications are unread, the latest ones, and
 * marking them read. Only the recipient's own in-app rows are ever read or changed.
 */
import { UUID_PATTERN } from '@/lib/commands';
import { sql } from '@/lib/db';

/** Counting stops here; the bell shows "99+" beyond it. */
export const UNREAD_COUNT_CAP = 100;

export type InboxItem = { id: string; subject: string; body: string; linkPath: string; read: boolean; createdAt: string };

export async function unreadCount(userId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`select count(*)::int as n from (select 1 from app.notifications
    where recipient_id=${userId} and channel='in_app' and read_at is null limit ${UNREAD_COUNT_CAP}) unread`;
  return Number(row?.n ?? 0);
}

export async function listInbox(userId: string, limit = 12): Promise<InboxItem[]> {
  const rows = await sql<{ id: string; subject: string; body: string; link_path: string; read_at: Date | null; created_at: Date }[]>`
    select id,subject,body,link_path,read_at,created_at from app.notifications
    where recipient_id=${userId} and channel='in_app' order by created_at desc limit ${Math.min(Math.max(limit, 1), 100)}`;
  return rows.map((row) => ({
    id: row.id, subject: row.subject, body: row.body,
    // Links come from templates; anything that is not a path on this site goes to the overview instead.
    linkPath: /^\/[^/]/.test(row.link_path) ? row.link_path : '/dashboard',
    read: row.read_at !== null, createdAt: new Date(row.created_at).toISOString(),
  }));
}

/** Marks one notification, or all of them, read. Returns the unread count after. */
export async function markRead(userId: string, target: { id: string } | { all: true }): Promise<number> {
  if ('all' in target) {
    await sql`update app.notifications set read_at=now() where recipient_id=${userId} and channel='in_app' and read_at is null`;
  } else if (UUID_PATTERN.test(target.id)) {
    await sql`update app.notifications set read_at=now() where id=${target.id} and recipient_id=${userId} and channel='in_app' and read_at is null`;
  }
  return unreadCount(userId);
}
