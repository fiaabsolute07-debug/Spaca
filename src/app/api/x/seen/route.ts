import { jsonRoute, readInput } from '@/lib/json-route';
import { requestXRefresh } from '@/modules/x/service';

/**
 * POST creator_id → { queued }. Explore calls this when a buyer opens a creator whose saved X profile is older than the
 * refresh age; the copy joins the next background refresh. Open to visitors: it never reads X by itself and a copy is
 * queued at most once until it is refreshed.
 */
export async function POST(request: Request) {
  return jsonRoute(request, async () => {
    const input = await readInput(request);
    return { queued: (await requestXRefresh([input.creator_id ?? ''])) > 0 };
  }, { anonymous: true });
}
