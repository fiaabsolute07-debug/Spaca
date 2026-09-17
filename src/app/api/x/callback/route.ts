import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { SESSION_COOKIE, createSession, getActor, hashSessionToken, publicUrl } from '@/lib/auth';
import { CommandError } from '@/lib/commands';
import { sql } from '@/lib/db';
import { logError } from '@/lib/log';
import { withNotice } from '@/lib/notices';
import { completeXConnect, completeXSignIn, xStatePurpose } from '@/modules/x/service';

/** Keeps the authorization code in this URL out of caches and out of Referer headers on the next page. */
const HEADERS = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };

/**
 * X redirects here after the consent screen with `state` and `code` (or `error`). A state started from the sign-in or
 * sign-up dialog signs the browser in (creating the account on sign-up); a state started from settings connects X to the
 * signed-in account it belongs to. Either way the next page gets a notice.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const input = {
    state: (params.get('state') ?? '').slice(0, 200),
    code: (params.get('code') ?? '').slice(0, 1000),
    error: (params.get('error') ?? '').slice(0, 100),
  };
  const redirectUri = publicUrl(request, '/api/x/callback').toString();
  const purpose = await xStatePurpose(input.state).catch(() => null);

  if (purpose === 'SIGN_IN' || purpose === 'SIGN_UP') {
    try {
      const outcome = await completeXSignIn(input, redirectUri);
      if (outcome.userId) {
        const jar = await cookies();
        const previous = jar.get(SESSION_COOKIE)?.value;
        if (previous) await sql`delete from app.sessions where token_hash=${hashSessionToken(previous)}`;
        jar.set(SESSION_COOKIE, await createSession(outcome.userId), { httpOnly: true, sameSite: 'lax', secure: publicUrl(request, '/').protocol === 'https:', path: '/', maxAge: 604800 });
      }
      const notice = outcome.error ? withNotice(outcome.path, 'error', outcome.error) : outcome.message ? withNotice(outcome.path, 'message', outcome.message) : outcome.path;
      return NextResponse.redirect(publicUrl(request, notice), { status: 303, headers: HEADERS });
    } catch (error) {
      logError('x sign-in callback failed', error);
      return NextResponse.redirect(publicUrl(request, withNotice('/sign-in', 'error', 'Signing in with X failed. Try again.')), { status: 303, headers: HEADERS });
    }
  }

  const actor = await getActor();
  if (!actor) {
    return NextResponse.redirect(publicUrl(request, withNotice('/sign-in?return_to=%2Fsettings%2Fprofile', 'error', 'Sign in again, then connect X from your profile.')), { status: 303, headers: HEADERS });
  }
  try {
    const outcome = await completeXConnect(actor, input, redirectUri);
    const notice = outcome.error ? withNotice(outcome.returnTo, 'error', outcome.error) : withNotice(outcome.returnTo, 'message', outcome.message ?? 'X account connected.');
    return NextResponse.redirect(publicUrl(request, notice), { status: 303, headers: HEADERS });
  } catch (error) {
    if (!(error instanceof CommandError)) logError('x connect callback failed', error);
    const message = error instanceof CommandError ? error.message : 'Connecting X failed. Try again.';
    return NextResponse.redirect(publicUrl(request, withNotice('/settings/profile', 'error', message)), { status: 303, headers: HEADERS });
  }
}
