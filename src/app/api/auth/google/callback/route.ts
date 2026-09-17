import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { SESSION_COOKIE, createSession, getActor, hashSessionToken, publicUrl } from '@/lib/auth';
import { sql } from '@/lib/db';
import { logError } from '@/lib/log';
import { withNotice } from '@/lib/notices';
import { completeGoogle, googleStatePurpose } from '@/modules/google/service';

/** Keeps the authorization code in this URL out of caches and out of Referer headers on the next page. */
const HEADERS = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };

/**
 * Google redirects here after its account chooser with `state` and `code` (or `error`). A connection is saved on the
 * signed-in account that started it; a sign-in signs the browser in to the account that connected this Google account.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const input = {
    state: (params.get('state') ?? '').slice(0, 200),
    code: (params.get('code') ?? '').slice(0, 1000),
    error: (params.get('error') ?? '').slice(0, 100),
  };
  try {
    const purpose = await googleStatePurpose(input.state);
    const actor = purpose === 'CONNECT' ? await getActor() : null;
    const outcome = await completeGoogle(actor, input, publicUrl(request, '/api/auth/google/callback').toString());
    if (outcome.userId) {
      const jar = await cookies();
      const previous = jar.get(SESSION_COOKIE)?.value;
      if (previous) await sql`delete from app.sessions where token_hash=${hashSessionToken(previous)}`;
      jar.set(SESSION_COOKIE, await createSession(outcome.userId), { httpOnly: true, sameSite: 'lax', secure: publicUrl(request, '/').protocol === 'https:', path: '/', maxAge: 604800 });
    }
    const notice = outcome.error ? withNotice(outcome.path, 'error', outcome.error) : outcome.message ? withNotice(outcome.path, 'message', outcome.message) : outcome.path;
    return NextResponse.redirect(publicUrl(request, notice), { status: 303, headers: HEADERS });
  } catch (error) {
    logError('google callback failed', error);
    return NextResponse.redirect(publicUrl(request, withNotice('/sign-in', 'error', 'Google sign-in failed. Try again.')), { status: 303, headers: HEADERS });
  }
}
