/** Order page side effects that are evidence, not user decisions (§7.5 buyer_viewed_delivery_at). */
import type { Actor } from '@/lib/auth';
import { sql } from '@/lib/db';
import type { Row } from '@/lib/commands';
import { recordBuyerView } from './lifecycle';

/** Records that the buyer opened the latest delivery. Idempotent; creators and non-participants record nothing. */
export async function recordOrderPageView(actor: Actor, orderId: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) return;
  await sql.begin(async (tx) => {
    const [order] = await tx<Row[]>`select * from app.orders where id=${orderId} and buyer_id=${actor.id} for update`;
    if (!order) return;
    await recordBuyerView(tx, order);
  });
}
