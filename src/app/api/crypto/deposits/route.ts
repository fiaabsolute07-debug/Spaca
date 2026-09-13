import { jsonRoute, readInput } from '@/lib/json-route';
import { verifyDepositForBuyer } from '@/modules/crypto/deposits';

/** POST intent_id, tx_hash → per-event results. The hash is only a hint; the chain reader decides. */
export async function POST(request: Request) {
  return jsonRoute(request, async (actor) => {
    const input = await readInput(request);
    return { results: await verifyDepositForBuyer(actor!.id, input.intent_id ?? '', input.tx_hash ?? '') };
  });
}
