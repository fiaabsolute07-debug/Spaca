import { jsonRoute, readInput } from '@/lib/json-route';
import { CommandError } from '@/lib/commands';
import { createEntitlementDownload } from '@/modules/digital';

/** POST { version? } → { url, expires_at, version }: a 5-minute link for the entitled buyer, counted against the download limit (XPL-06). */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const input = await readInput(request);
  return jsonRoute(request, (actor) => {
    const value = (input.version ?? '').trim();
    if (value && !/^\d{1,6}$/.test(value)) throw new CommandError('version must be a whole number');
    return createEntitlementDownload(actor!, id, value ? Number(value) : null);
  });
}
