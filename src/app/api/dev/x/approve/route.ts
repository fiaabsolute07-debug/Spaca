import { NextResponse } from 'next/server';
import { isSameOrigin, publicUrl } from '@/lib/auth';
import { xMode } from '@/modules/x/provider';

/**
 * The sandbox consent screen's answer: redirects to the callback the way X does, with `code=mock.<username>` on approval
 * or `error=access_denied`. 404 unless the local X sandbox is on.
 */
export async function POST(request: Request) {
  if (xMode() !== 'mock') return new NextResponse(null, { status: 404 });
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'Origin not allowed' }, { status: 403 });
  const form = await request.formData();
  const state = String(form.get('state') ?? '').slice(0, 200);
  const username = String(form.get('username') ?? '').trim().replace(/^@/, '');
  const params = new URLSearchParams({ state });
  if (form.get('decision') === 'approve' && /^[A-Za-z0-9_]{1,15}$/.test(username)) params.set('code', `mock.${username}`);
  else params.set('error', 'access_denied');
  return NextResponse.redirect(publicUrl(request, `/api/x/callback?${params.toString()}`), 303);
}
