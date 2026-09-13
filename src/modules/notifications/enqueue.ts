/** Transactional outbox writer: notifications are enqueued in the same transaction as the domain change. */
import type { Tx } from '@/lib/commands';
import type { NotificationTemplateId } from './index';

export async function enqueueNotification(
  tx: Tx,
  aggregateId: string,
  semanticKey: string,
  message: { templateId: NotificationTemplateId; recipientId: string; params: Record<string, string> },
): Promise<void> {
  await tx`insert into app.outbox (topic,aggregate_id,semantic_key,payload) values ('notification',${aggregateId},${semanticKey},${JSON.stringify(message)}::jsonb)
    on conflict (semantic_key) do nothing`;
}
