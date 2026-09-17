import { NextResponse } from 'next/server';
import { getActor, isSameOrigin, localAuthEnabled, publicUrl } from '@/lib/auth';
import { CommandError } from '@/lib/commands';
import { logError } from '@/lib/log';
import { withNotice } from '@/lib/notices';
import { googleAvailable, startGoogle } from '@/modules/google/service';

/**
 * Form post, intent `connect` (settings, signed in) or `signin` (the sign-in dialog), with return_to → 303 to Google's
 * account chooser, or the local sandbox's. Google comes back to /api/auth/google/callback.
 */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'Origin not allowed' }, { status: 403 });
  const form = await request.formData();
  const connect = String(form.get('intent') ?? '') === 'connect';
  const retry = connect ? '/settings/profile' : '/sign-in';
  const fail = (message: string) => NextResponse.redirect(publicUrl(request, withNotice(retry, 'error', message)), 303);
  const actor = connect ? await getActor() : null;
  if (connect && !actor) return NextResponse.redirect(publicUrl(request, '/sign-in?return_to=%2Fsettings%2Fprofile'), 303);
  if (!googleAvailable()) return fail('Google is not available in this environment.');
  if (!connect && !localAuthEnabled()) return fail('Signing in with Google is not available in this environment yet.');
  try {
    const destination = await startGoogle({ intent: connect ? 'CONNECT' : 'SIGN_IN', actor, returnTo: form.get('return_to') },
      publicUrl(request, '/api/auth/google/callback').toString());
    return NextResponse.redirect(destination.startsWith('/') ? publicUrl(request, destination) : destination, { status: 303, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (!(error instanceof CommandError)) logError('google start failed', error);
    return fail(error instanceof CommandError ? error.message : 'Google sign-in failed. Try again.');
  }
}
