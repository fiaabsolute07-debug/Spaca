import { NextResponse } from 'next/server';
import { SESSION_COOKIE, createSession, isSameOrigin, localAuthEnabled, publicUrl, requestHostname } from '@/lib/auth';
import { sql } from '@/lib/db';
import { FIXTURE_PERSONAS, isFixturePersonaKey } from '@/lib/fixtures';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Local-only fixture sign-in for E2E and manual QA (no password entry). Creates a real DB session for
 * a seeded `is_test` persona. 404 in production, with Supabase auth, with DEV_SESSIONS=off, or on any
 * non-loopback host. Browser calls must be same-origin.
 */
export async function POST(request: Request) {
  const url = new URL(request.url);
  if (process.env.NODE_ENV === 'production' || !localAuthEnabled() || process.env.DEV_SESSIONS === 'off' || !LOOPBACK.has(requestHostname(request)) || !LOOPBACK.has(url.hostname)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (request.headers.get('origin') && !isSameOrigin(request)) return NextResponse.json({ error: 'Origin not allowed' }, { status: 403 });

  const contentType = request.headers.get('content-type') ?? '';
  const input = contentType.includes('application/json')
    ? ((await request.json().catch(() => ({}))) as Record<string, unknown>)
    : Object.fromEntries((await request.formData()).entries());
  const persona = String(input.persona ?? '');
  if (!isFixturePersonaKey(persona)) return NextResponse.json({ error: 'Unknown fixture persona' }, { status: 400 });
  const fixture = FIXTURE_PERSONAS[persona];

  const [user] = await sql<{ id: string }[]>`select id from app.users where id=${fixture.id} and email=${fixture.email} and is_test=true`;
  if (!user) return NextResponse.json({ error: 'Fixture persona is not seeded; run db:seed' }, { status: 404 });

  const token = await createSession(user.id);
  const returnTo = String(input.return_to ?? '');
  const wantsJson = (request.headers.get('accept') ?? '').includes('application/json');
  const response = wantsJson
    ? NextResponse.json({ persona, userId: user.id })
    : NextResponse.redirect(publicUrl(request, returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/dashboard'), 303);
  response.cookies.set(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: url.protocol === 'https:', path: '/', maxAge: 604800 });
  return response;
}
