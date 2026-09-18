import { createHash } from 'node:crypto';
import { cookies } from 'next/headers';
import { withNotice } from '../../../lib/notices';
import { NextResponse } from 'next/server';
import { sql } from '../../../lib/db';
import { onboardingPath } from '../../../lib/onboarding';
import { createSession, getActor, hashPassword, hashSessionToken, isSameOrigin, appSessionsEnabled, SESSION_COOKIE, supabaseAuth, verifyPassword, publicUrl } from '../../../lib/auth';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Failed password sign-ins allowed per address in the window before sign-in with that address waits (drizzle/0037). */
const MAX_FAILED_SIGN_INS = 10;
const SIGN_IN_WINDOW_MINUTES = 15;
const emailHash = (email: string) => createHash('sha256').update(`sign-in:${email}`).digest('hex');
const validCredentials = (email: string, password: string) => EMAIL_PATTERN.test(email) && email.length <= 254 && password.length >= 12 && password.length <= 256;

/**
 * Email and password: sign in, log out, and add an email to an account created with X or Google. New accounts are made
 * by signing up with X (/api/auth/x, drizzle/0035) or Google (/api/auth/google, drizzle/0038), so `signup` is refused here.
 */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'Origin not allowed' }, { status: 403 });
  const form = await request.formData();
  const action = String(form.get('action') ?? '');
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  const password = String(form.get('password') ?? '');
  // The sign-in dialog asks for JSON so it can show errors in place; plain form posts get redirects.
  const wantsJson = (request.headers.get('accept') ?? '').includes('application/json');
  const requested = String(form.get('return_to') ?? '');
  const returnTo = requested.startsWith('/') && !requested.startsWith('//') && !requested.startsWith('/sign-') ? requested : '/dashboard';
  const go = (path: string) => wantsJson && action !== 'logout'
    ? NextResponse.json({ redirect: publicUrl(request, path).pathname + publicUrl(request, path).search })
    : NextResponse.redirect(publicUrl(request, path), 303);
  const refuse = (path: string, message: string) => wantsJson ? NextResponse.json({ error: message }, { status: 400 }) : go(withNotice(path, 'error', message));
  const failure = () => refuse(`/sign-in?return_to=${encodeURIComponent(returnTo)}`, 'The email or password is not correct.');
  try {
    if (!['login', 'signup', 'logout', 'add_email'].includes(action)) return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    if (action === 'signup') return refuse('/sign-up', 'New accounts sign up with X or Google. You can add an email and password later from your account settings.');

    if (action === 'add_email') {
      const actor = await getActor();
      if (!actor) return refuse('/sign-in?return_to=%2Fsettings%2Fprofile', 'Sign in first, then add an email from your account settings.');
      if (!appSessionsEnabled()) return refuse('/settings/profile', 'Adding an email is not available in this environment yet.');
      if (!validCredentials(email, password)) return refuse('/settings/profile', 'Enter a valid email address and a password of at least 12 characters.');
      try {
        const [updated] = await sql`update app.users set email=${email},password_hash=${hashPassword(password)} where id=${actor.id} and email is null returning id`;
        if (!updated) return refuse('/settings/profile', 'This account already has an email.');
      } catch (error) {
        if ((error as { code?: string }).code === '23505') return refuse('/settings/profile', 'That email already belongs to another spaca account.');
        throw error;
      }
      return go(withNotice('/settings/profile', 'message', 'Email added. You can now sign in with it as well as with X.'));
    }

    if (action !== 'logout' && !validCredentials(email, password)) return failure();
    if (!appSessionsEnabled()) {
      const client = await supabaseAuth();
      if (action === 'logout') { await client.auth.signOut(); return go('/'); }
      const result = await client.auth.signInWithPassword({ email, password });
      if (result.error) return failure();
      // Mapping occurs only after a verified authenticated response, never from browser IDs/roles.
      if (result.data.session && result.data.user) {
        const user = result.data.user;
        await sql`insert into app.users (id,auth_user_id,email,display_name,roles,is_test,status,onboarded_at) values (gen_random_uuid(),${user.id},${user.email!},${String(user.user_metadata.display_name ?? 'Member').slice(0,100)},${[user.user_metadata.account_type === 'creator' ? 'creator' : 'buyer']},false,'ACTIVE',null) on conflict (auth_user_id) do nothing`;
        const [mapped] = await sql`select onboarded_at is not null as onboarded from app.users where auth_user_id=${user.id}`;
        return go(mapped?.onboarded ? returnTo : onboardingPath(returnTo));
      }
      return refuse('/sign-in', 'Check your email to verify your account, then sign in.');
    }
    const jar = await cookies();
    if (action === 'logout') {
      const token = jar.get(SESSION_COOKIE)?.value;
      if (token) await sql`delete from app.sessions where token_hash=${hashSessionToken(token)}`;
      jar.delete(SESSION_COOKIE);
      // Logging out leaves the product: the landing is what a visitor sees, and offering the sign-in form again
      // reads as "that did not work". `homePath(false)` is the same `/` the logo points visitors at.
      return go('/');
    }
    const hashed = emailHash(email);
    const [recent] = await sql<{ n: number }[]>`select count(*)::int as n from app.sign_in_attempts
      where email_hash=${hashed} and not succeeded and created_at > now() - make_interval(mins => ${SIGN_IN_WINDOW_MINUTES})`;
    if (Number(recent?.n ?? 0) >= MAX_FAILED_SIGN_INS) {
      return refuse(`/sign-in?return_to=${encodeURIComponent(returnTo)}`, `Too many sign-in attempts for this email. Try again in ${SIGN_IN_WINDOW_MINUTES} minutes, or continue with X or Google.`);
    }
    const [user] = await sql`select id,password_hash,onboarded_at is not null as onboarded from app.users where email=${email} and status in ('ACTIVE','SUSPENDED')`;
    const verified = Boolean(user?.password_hash) && verifyPassword(password, user!.password_hash);
    await sql`insert into app.sign_in_attempts (email_hash,succeeded) values (${hashed},${verified})`;
    // Only the window matters; older attempts for this address are dropped as it is used.
    await sql`delete from app.sign_in_attempts where email_hash=${hashed} and created_at < now() - interval '1 day'`;
    if (!verified) return failure();
    const previous = jar.get(SESSION_COOKIE)?.value;
    if (previous) await sql`delete from app.sessions where token_hash=${hashSessionToken(previous)}`;
    jar.set(SESSION_COOKIE, await createSession(user.id), { httpOnly: true, sameSite: 'lax', secure: publicUrl(request, '/').protocol === 'https:', path: '/', maxAge: 604800 });
    return go(user.onboarded ? returnTo : onboardingPath(returnTo));
  } catch { return action === 'add_email' ? refuse('/settings/profile', 'The email could not be added. Try again.') : failure(); }
}
