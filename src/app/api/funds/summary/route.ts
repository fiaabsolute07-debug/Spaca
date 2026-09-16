import { jsonRoute } from '@/lib/json-route';
import { getFundsSummary } from '@/modules/funds/queries';

/** POST → the signed-in account's money at a glance, for the header's Fund menu. POST so the same-origin check applies. */
export async function POST(request: Request) {
  return jsonRoute(request, async (actor) => getFundsSummary(actor!));
}
