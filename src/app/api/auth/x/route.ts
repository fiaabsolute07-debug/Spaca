import { NextResponse } from 'next/server';
import { isSameOrigin, localAuthEnabled, publicUrl } from '@/lib/auth';
import { CommandError } from '@/lib/commands';
import { logError } from '@/lib/log';
import { withNotice } from '@/lib/notices';
import { startXSignIn, xConnectAvailable } from '@/modules/x/service';

/**
 * "Continue with X" from the sign-in and sign-up dialogs (form post: intent signin|signup, role, return_to) → 303 to X's
 * consent screen, or the local sandbox's. Signing up is only possible this way; X comes back to /api/x/callback.
 */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'Origin not allowed' }, { status: 403 });
  const form = await request.formData();
  const signup = String(form.get('intent') ?? '') === 'signup';
  const role = String(form.get('role') ?? '');
  // Separate accounts: anything but "creator" is a buyer account, as with the earlier sign-up form.
  const accountType = role === 'creator' ? 'creator' : 'buyer';
  const retry = signup ? `/sign-up${role ? `?role=${accountType}` : ''}` : '/sign-in';
  const fail = (message: string) => NextResponse.redirect(publicUrl(request, withNotice(retry, 'error', message)), 303);
  if (!localAuthEnabled()) return fail('Signing in with X is not available in this environment yet.');
  if (!xConnectAvailable()) return fail('Signing in with X is not available in this environment.');
  if (signup && role !== 'creator' && role !== 'buyer') return fail('Choose Buyer or Creator first.');
  try {
    const destination = await startXSignIn({ intent: signup ? 'SIGN_UP' : 'SIGN_IN', accountType: signup ? accountType : null, returnTo: form.get('return_to') },
      publicUrl(request, '/api/x/callback').toString());
    return NextResponse.redirect(destination.startsWith('/') ? publicUrl(request, destination) : destination, { status: 303, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (!(error instanceof CommandError)) logError('x sign-in start failed', error);
    return fail(error instanceof CommandError ? error.message : 'Signing in with X failed. Try again.');
  }
}
