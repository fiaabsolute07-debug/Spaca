import { NextResponse } from 'next/server';
import { isSameOrigin, publicUrl } from '@/lib/auth';
import { googleMode, mockGoogleCode } from '@/modules/google/provider';

/**
 * The sandbox Google account chooser's answer: redirects to the callback the way Google does, with a sandbox code for the
 * chosen address on approval or `error=access_denied`. 404 unless the local Google sandbox is on.
 */
export async function POST(request: Request) {
  if (process.env.NODE_ENV === 'production' || googleMode() !== 'mock') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'Origin not allowed' }, { status: 403 });
  const form = await request.formData();
  const state = String(form.get('state') ?? '').slice(0, 200);
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  const params = new URLSearchParams({ state });
  if (form.get('decision') === 'approve' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254) params.set('code', mockGoogleCode(email));
  else params.set('error', 'access_denied');
  return NextResponse.redirect(publicUrl(request, `/api/auth/google/callback?${params.toString()}`), 303);
}
