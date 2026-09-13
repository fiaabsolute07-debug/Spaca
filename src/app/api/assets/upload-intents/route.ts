import { createUploadIntent } from '@/modules/storage/service';
import { assetRoute, readInput } from '@/modules/storage/http';

/** POST purpose, filename, mime, size, order_id? → { id, upload: { url, method, headers, expires_at } }. */
export async function POST(request: Request) {
  return assetRoute(request, async (actor) => {
    const input = await readInput(request);
    return createUploadIntent(actor!, {
      purpose: input.purpose ?? '',
      filename: input.filename ?? '',
      mime: input.mime ?? '',
      size: Number(input.size ?? ''),
      orderId: input.order_id ?? null,
    });
  });
}
