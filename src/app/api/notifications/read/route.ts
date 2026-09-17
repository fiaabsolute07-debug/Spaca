import { NextResponse } from 'next/server';
import { getActor, isSameOrigin, publicUrl } from '@/lib/auth';
import { jsonRoute, readInput } from '@/lib/json-route';
import { markRead } from '@/modules/notifications/inbox';

/**
 * POST id=<notification> or all=true → { unread }. A plain form post (the notifications page without JavaScript)
 * marks everything read and returns to /notifications.
 */
export async function POST(request: Request) {
  if (!(request.headers.get('accept') ?? '').includes('application/json')) {
    if (!isSameOrigin(request)) return NextResponse.json({ error: 'Origin not allowed' }, { status: 403 });
    const actor = await getActor();
    if (actor) await markRead(actor.id, { all: true });
    return NextResponse.redirect(publicUrl(request, actor ? '/notifications' : '/sign-in'), 303);
  }
  return jsonRoute(request, async (actor) => {
    const input = await readInput(request);
    return { unread: await markRead(actor!.id, input.all === 'true' ? { all: true } : { id: input.id ?? '' }) };
  });
}
