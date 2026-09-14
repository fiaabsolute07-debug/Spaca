import { NextResponse } from 'next/server';
import { sql } from '../../../lib/db';
import { deliverWelcomeEmail } from '../../../lib/email/send';
import { renderWelcomeEmail } from '../../../lib/email/welcome';
import { RATE_LIMIT, ipHashOf, isSameOrigin, newUpdateToken, sha256 } from '../../../lib/security';
import { normalizeXHandle, parseSignup } from '../../../lib/validate';

const HANDLE_TOKEN_DAYS = 7;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > 4096) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** Public origin for links in emails: configured URL in production, the request origin locally. */
function publicBaseUrl(request: Request): string {
  const configured = process.env.WAITLIST_PUBLIC_URL?.trim();
  if (configured) return configured;
  // Vercel sets the production domain (e.g. spaca-waitlist.vercel.app) until a custom domain is configured.
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercel) return `https://${vercel}`;
  if (process.env.NODE_ENV === 'production') throw new Error('WAITLIST_PUBLIC_URL is required in production');
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  const proto = request.headers.get('x-forwarded-proto') ?? new URL(request.url).protocol.replace(':', '');
  return host ? `${proto}://${host}` : new URL(request.url).origin;
}

/**
 * Step 1: email + role + consent. The response is identical for new and existing emails, so the endpoint
 * never reveals who is already on the list; only a new signup receives a token and the welcome email.
 */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return json({ error: 'Origin not allowed.' }, 403);
  const parsed = parseSignup(await readJson(request));
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  const { email, role, honeypot, source } = parsed.value;
  if (honeypot) return json({ ok: true, token: null });

  let signup: { id: string; token: string } | null = null;
  try {
    const ipHash = ipHashOf(request);
    if (ipHash) {
      const [{ recent }] = await sql<{ recent: number }[]>`select count(*)::int as recent from waitlist.signups
        where ip_hash=${ipHash} and created_at > now() - (${RATE_LIMIT.windowMinutes} * interval '1 minute')`;
      if (recent >= RATE_LIMIT.max) return json({ error: 'Too many signups from this network. Try again in a few minutes.' }, 429);
    }
    const { token, hash } = newUpdateToken();
    const inserted = await sql<{ id: string }[]>`insert into waitlist.signups (email, role, consent_at, source, ip_hash, update_token_hash)
      values (${email}, ${role}, now(), ${sql.json(source)}, ${ipHash}, ${hash})
      on conflict (email) do nothing returning id`;
    if (inserted[0]) signup = { id: inserted[0].id, token };
  } catch (error) {
    console.error('waitlist signup failed', error instanceof Error ? error.name : 'unknown');
    return json({ error: 'Something went wrong on our side. Please try again.' }, 503);
  }

  if (signup) {
    // The signup is already saved; an email problem is recorded for follow-up and never fails the request.
    try {
      const message = renderWelcomeEmail({ role, email, baseUrl: publicBaseUrl(request), handleToken: signup.token, mailingAddress: process.env.WAITLIST_MAILING_ADDRESS });
      const result = await deliverWelcomeEmail(email, message, signup.id);
      await sql`update waitlist.signups set welcome_email_status=${result.status}, welcome_email_id=${result.id}, welcome_email_error=${result.error},
        welcome_email_sent_at=${result.status === 'SENT' ? sql`now()` : null}, updated_at=now() where id=${signup.id}`;
      if (result.status === 'FAILED') console.error('waitlist welcome email failed', result.error);
    } catch (error) {
      console.error('waitlist welcome email error', error instanceof Error ? error.message : 'unknown');
    }
  }
  return json({ ok: true, token: signup?.token ?? null });
}

/** Step 2 (optional): attach an X handle with the token from step 1 or from the welcome email link. */
export async function PATCH(request: Request) {
  if (!isSameOrigin(request)) return json({ error: 'Origin not allowed.' }, 403);
  const body = (await readJson(request)) as { token?: unknown; x_handle?: unknown } | null;
  const token = typeof body?.token === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(body.token) ? body.token : null;
  const handle = normalizeXHandle(body?.x_handle);
  if (!token) return json({ error: 'This link has expired. You are still on the list.' }, 400);
  if (!handle) return json({ error: 'Enter an X handle like @yourname.' }, 400);
  try {
    const updated = await sql`update waitlist.signups set x_handle=${handle}, updated_at=now()
      where update_token_hash=${sha256(token)} and x_handle is null and created_at > now() - (${HANDLE_TOKEN_DAYS} * interval '1 day') returning id`;
    if (!updated.length) return json({ error: 'This link has expired or was already used. You are still on the list.' }, 400);
    return json({ ok: true, x_handle: handle });
  } catch (error) {
    console.error('waitlist handle update failed', error instanceof Error ? error.name : 'unknown');
    return json({ error: 'Something went wrong on our side. Please try again.' }, 503);
  }
}
