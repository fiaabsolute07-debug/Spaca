import { NextResponse } from 'next/server';
import { getActor, publicUrl } from '@/lib/auth';
import { CommandError } from '@/lib/commands';
import { logError } from '@/lib/log';
import { withNotice } from '@/lib/notices';
import { completeXConnect } from '@/modules/x/service';

/** Keeps the authorization code in this URL out of caches and out of Referer headers on the next page. */
const HEADERS = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };

/**
 * X redirects here after the consent screen with `state` and `code` (or `error`). The state must belong to the signed-in
 * account; the page the creator came from gets a notice either way.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const actor = await getActor();
  if (!actor) {
    return NextResponse.redirect(publicUrl(request, withNotice('/sign-in?return_to=%2Fsettings%2Fprofile', 'error', 'Sign in again, then connect X from your profile.')), { status: 303, headers: HEADERS });
  }
  try {
    const outcome = await completeXConnect(actor, {
      state: (params.get('state') ?? '').slice(0, 200),
      code: (params.get('code') ?? '').slice(0, 1000),
      error: (params.get('error') ?? '').slice(0, 100),
    }, publicUrl(request, '/api/x/callback').toString());
    const notice = outcome.error ? withNotice(outcome.returnTo, 'error', outcome.error) : withNotice(outcome.returnTo, 'message', outcome.message ?? 'X account connected.');
    return NextResponse.redirect(publicUrl(request, notice), { status: 303, headers: HEADERS });
  } catch (error) {
    if (!(error instanceof CommandError)) logError('x connect callback failed', error);
    const message = error instanceof CommandError ? error.message : 'Connecting X failed. Try again.';
    return NextResponse.redirect(publicUrl(request, withNotice('/settings/profile', 'error', message)), { status: 303, headers: HEADERS });
  }
}
