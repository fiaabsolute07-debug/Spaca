import { NextResponse } from 'next/server';
import { getActor, isSameOrigin } from '@/lib/auth';
import { recordServiceView } from '@/modules/discovery/views';

/** POST from the service page: counts at most one eligible view per viewer per day (hashed; owner excluded). */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'Origin not allowed' }, { status: 403 });
  const { id } = await context.params;
  const clientKey = `${request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? request.headers.get('x-real-ip') ?? ''}|${request.headers.get('user-agent') ?? ''}`;
  const result = await recordServiceView({ serviceId: id, actor: await getActor(), clientKey });
  return NextResponse.json(result, { status: result.reason === 'NOT_FOUND' ? 404 : 200, headers: { 'cache-control': 'no-store' } });
}
