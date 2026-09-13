import { createDownloadUrl } from '@/modules/storage/service';
import { assetRoute } from '@/modules/storage/http';

/** POST → { url, expires_at } (5 minutes). Anonymous callers only reach approved public sample files. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return assetRoute(request, (actor) => createDownloadUrl(actor, id), { anonymous: true });
}
