import { NextResponse } from 'next/server';
import { getActor, isSameOrigin, appSessionsEnabled, publicUrl } from '@/lib/auth';
import { CommandError } from '@/lib/commands';
import { logError } from '@/lib/log';
import { withNotice } from '@/lib/notices';
import { googleAvailable, startGoogle } from '@/modules/google/service';

/**
 * Form post, intent `connect` (settings, signed in), `signup` (the sign-up dialog, with the chosen account type) or
 * `signin` (the sign-in dialog), with return_to → 303 to Google's account chooser, or the local sandbox's. Google comes
 * back to /api/auth/google/callback.
 */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'Origin not allowed' }, { status: 403 });
  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');
  const connect = intent === 'connect';
  const signup = intent === 'signup';
  const role = String(form.get('role') ?? '');
  // Separate accounts: anything but "creator" is a buyer account, as in the sign-up form and in Continue with X.
  const accountType = role === 'creator' ? 'creator' : 'buyer';
  const retry = connect ? '/settings/profile' : signup ? `/sign-up${role ? `?role=${accountType}` : ''}` : '/sign-in';
  const fail = (message: string) => NextResponse.redirect(publicUrl(request, withNotice(retry, 'error', message)), 303);
  const actor = connect ? await getActor() : null;
  if (connect && !actor) return NextResponse.redirect(publicUrl(request, '/sign-in?return_to=%2Fsettings%2Fprofile'), 303);
  if (!googleAvailable()) return fail('Google is not available in this environment.');
  if (!connect && !appSessionsEnabled()) return fail('Signing in with Google is not available in this environment yet.');
  if (signup && role !== 'creator' && role !== 'buyer') return fail('Choose Buyer or Creator first.');
  try {
    const destination = await startGoogle({ intent: connect ? 'CONNECT' : signup ? 'SIGN_UP' : 'SIGN_IN', actor,
      accountType: signup ? accountType : null, returnTo: form.get('return_to') },
      publicUrl(request, '/api/auth/google/callback').toString());
    return NextResponse.redirect(destination.startsWith('/') ? publicUrl(request, destination) : destination, { status: 303, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (!(error instanceof CommandError)) logError('google start failed', error);
    return fail(error instanceof CommandError ? error.message : 'Google sign-in failed. Try again.');
  }
}
