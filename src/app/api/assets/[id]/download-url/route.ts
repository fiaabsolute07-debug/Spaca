import { createDownloadUrl } from '@/modules/storage/service';
import { jsonRoute } from '@/lib/json-route';

/** POST → { url, expires_at } (5 minutes). Anonymous callers only reach approved public sample files. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return jsonRoute(request, (actor) => createDownloadUrl(actor, id), { anonymous: true });
}
