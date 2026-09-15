import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { sql } from '../../../lib/db';
import { createSession, hashPassword, hashSessionToken, isSameOrigin, localAuthEnabled, SESSION_COOKIE, supabaseAuth, verifyPassword, publicUrl } from '../../../lib/auth';

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'Origin not allowed' }, { status: 403 });
  const form = await request.formData();
  const action = String(form.get('action') ?? '');
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  const password = String(form.get('password') ?? '');
  const displayName = String(form.get('display_name') ?? '').trim();
  // Separate accounts: a new account is a buyer or a creator, never both.
  const accountType = String(form.get('role') ?? '') === 'creator' ? 'creator' : 'buyer';
  // The sign-in dialog asks for JSON so it can show errors in place; plain form posts get redirects.
  const wantsJson = (request.headers.get('accept') ?? '').includes('application/json');
  const requested = String(form.get('return_to') ?? '');
  const returnTo = requested.startsWith('/') && !requested.startsWith('//') && !requested.startsWith('/sign-') ? requested : '/dashboard';
  const go = (path: string) => wantsJson && action !== 'logout'
    ? NextResponse.json({ redirect: publicUrl(request, path).pathname + publicUrl(request, path).search })
    : NextResponse.redirect(publicUrl(request, path), 303);
  const failure = () => {
    const message = action === 'signup' ? 'Unable to create the account. Check the details or sign in instead.' : 'The email or password is not correct.';
    return wantsJson ? NextResponse.json({ error: message }, { status: 400 })
      : go(`${action === 'signup' ? '/sign-up' : '/sign-in'}?error=${encodeURIComponent(message)}&return_to=${encodeURIComponent(returnTo)}`);
  };
  try {
    if (!['login','signup','logout'].includes(action)) return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    if (action !== 'logout' && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || password.length < 12 || password.length > 256)) return failure();
    if (action === 'signup' && (!displayName || displayName.length > 100)) return failure();
    if (!localAuthEnabled()) {
      const client = await supabaseAuth();
      if (action === 'logout') { await client.auth.signOut(); return go('/sign-in'); }
      const result = action === 'signup'
        ? await client.auth.signUp({ email, password, options: { data: { display_name: displayName, account_type: accountType } } })
        : await client.auth.signInWithPassword({ email, password });
      if (result.error) return failure();
      // Mapping occurs only after a verified authenticated response, never from browser IDs/roles.
      if (result.data.session && result.data.user) {
        const user = result.data.user;
        await sql`insert into app.users (id,auth_user_id,email,display_name,roles,is_test,status) values (gen_random_uuid(),${user.id},${user.email!},${String(user.user_metadata.display_name ?? 'Member').slice(0,100)},${[user.user_metadata.account_type === 'creator' ? 'creator' : 'buyer']},false,'ACTIVE') on conflict (auth_user_id) do nothing`;
        return go(returnTo);
      }
      return wantsJson ? NextResponse.json({ error: 'Check your email to verify your account, then sign in.' }, { status: 400 })
        : go('/sign-in?message=Check%20your%20email%20to%20verify%20your%20account');
    }
    const jar = await cookies();
    if (action === 'logout') {
      const token = jar.get(SESSION_COOKIE)?.value;
      if (token) await sql`delete from app.sessions where token_hash=${hashSessionToken(token)}`;
      jar.delete(SESSION_COOKIE);
      return go('/sign-in');
    }
    let userId: string;
    if (action === 'signup') {
      const [user] = await sql`insert into app.users (id,email,display_name,password_hash,roles,is_test,status) values (gen_random_uuid(),${email},${displayName},${hashPassword(password)},${[accountType]},true,'ACTIVE') returning id`;
      userId = user!.id;
    } else {
      const [user] = await sql`select id,password_hash from app.users where email=${email} and status in ('ACTIVE','SUSPENDED')`;
      if (!user?.password_hash || !verifyPassword(password,user.password_hash)) return failure();
      userId = user.id;
    }
    const previous = jar.get(SESSION_COOKIE)?.value;
    if (previous) await sql`delete from app.sessions where token_hash=${hashSessionToken(previous)}`;
    jar.set(SESSION_COOKIE, await createSession(userId), { httpOnly: true, sameSite: 'lax', secure: publicUrl(request, '/').protocol === 'https:', path: '/', maxAge: 604800 });
    return go(returnTo);
  } catch { return failure(); }
}
