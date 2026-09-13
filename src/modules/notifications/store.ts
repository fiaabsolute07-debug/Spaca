/**
 * PostgreSQL-backed notification sink. In-app rows are the durable timeline; email rows are captured
 * locally with status EMAIL_SINK and never sent. The unique dedupe key keeps delivery idempotent
 * across processes and retries.
 */
import { sql } from '@/lib/db';
import type { NotificationSink, OutboundNotification } from './index';

export class DatabaseNotificationSink implements NotificationSink {
  readonly kind = 'database';

  async deliver(message: OutboundNotification): Promise<{ messageId: string }> {
    const status = message.channel === 'email' ? 'EMAIL_SINK' : 'DELIVERED';
    const [inserted] = await sql<{ id: string }[]>`insert into app.notifications
      (recipient_id,channel,template_id,category,subject,body,link_path,dedupe_key,semantic_key,status)
      values (${message.recipientId},${message.channel},${message.templateId},${message.category},${message.subject},
        ${message.body},${message.linkPath},${message.dedupeKey},${message.semanticEventKey},${status})
      on conflict (dedupe_key) do nothing returning id`;
    if (inserted) return { messageId: inserted.id };
    const [existing] = await sql<{ id: string }[]>`select id from app.notifications where dedupe_key=${message.dedupeKey}`;
    if (!existing) throw new Error('notification dedupe row missing');
    return { messageId: existing.id };
  }
}

export type InAppNotification = { id: string; subject: string; body: string; link_path: string; read_at: string | null; created_at: string };

export async function listInAppNotifications(recipientId: string, limit = 10): Promise<InAppNotification[]> {
  return sql<InAppNotification[]>`select id,subject,body,link_path,read_at,created_at from app.notifications
    where recipient_id=${recipientId} and channel='in_app' order by created_at desc limit ${Math.min(Math.max(limit, 1), 50)}`;
}
