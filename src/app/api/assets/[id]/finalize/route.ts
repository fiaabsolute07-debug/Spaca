import { NextResponse } from 'next/server';
import { finalizeUpload } from '@/modules/storage/service';
import { jsonRoute } from '@/lib/json-route';

/** POST → { id, state: READY | QUARANTINED | REJECTED }. Non-READY outcomes answer 422 with the recorded state. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const response = await jsonRoute(request, (actor) => finalizeUpload(actor!, id));
  if (response.status !== 200) return response;
  const body = (await response.clone().json()) as { state: string; detail?: string };
  if (body.state === 'READY') return response;
  return NextResponse.json({ ...body, error: body.detail ?? 'The file was not accepted', code: 'UNSUPPORTED_ASSET' }, { status: 422, headers: { 'cache-control': 'no-store' } });
}
