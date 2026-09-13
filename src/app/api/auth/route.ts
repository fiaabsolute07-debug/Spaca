import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { sql } from '../../../lib/db';
import { createSession, hashPassword, hashSessionToken, isSameOrigin, localAuthEnabled, SESSION_COOKIE, supabaseAuth, verifyPassword } from '../../../lib/auth';

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'Origin not allowed' }, { status: 403 });
  const form = await request.formData();
  const action = String(form.get('action') ?? '');
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  const password = String(form.get('password') ?? '');
  const displayName = String(form.get('display_name') ?? '').trim();
  const go = (path: string) => NextResponse.redirect(new URL(path, request.url), 303);
  const failure = () => go(action === 'signup' ? '/sign-up?error=Unable%20to%20create%20account' : '/sign-in?error=Invalid%20credentials%20or%20authentication%20unavailable');
  try {
    if (!['login','signup','logout'].includes(action)) return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    if (action !== 'logout' && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || password.length < 12 || password.length > 256)) return failure();
    if (action === 'signup' && (!displayName || displayName.length > 100)) return failure();
    if (!localAuthEnabled()) {
      const client = await supabaseAuth();
      if (action === 'logout') { await client.auth.signOut(); return go('/sign-in'); }
      const result = action === 'signup'
        ? await client.auth.signUp({ email, password, options: { data: { display_name: displayName } } })
        : await client.auth.signInWithPassword({ email, password });
      if (result.error) return failure();
      // Mapping occurs only after a verified authenticated response, never from browser IDs/roles.
      if (result.data.session && result.data.user) {
        const user = result.data.user;
        await sql`insert into app.users (id,auth_user_id,email,display_name,roles,is_test,status) values (gen_random_uuid(),${user.id},${user.email!},${String(user.user_metadata.display_name ?? 'Member').slice(0,100)},ARRAY['buyer','creator'],false,'ACTIVE') on conflict (auth_user_id) do nothing`;
        return go('/dashboard');
      }
      return go('/sign-in?message=Check%20your%20email%20to%20verify%20your%20account');
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
      const [user] = await sql`insert into app.users (id,email,display_name,password_hash,roles,is_test,status) values (gen_random_uuid(),${email},${displayName},${hashPassword(password)},ARRAY['buyer','creator'],true,'ACTIVE') returning id`;
      userId = user!.id;
    } else {
      const [user] = await sql`select id,password_hash from app.users where email=${email} and status='ACTIVE'`;
      if (!user?.password_hash || !verifyPassword(password,user.password_hash)) return failure();
      userId = user.id;
    }
    const previous = jar.get(SESSION_COOKIE)?.value;
    if (previous) await sql`delete from app.sessions where token_hash=${hashSessionToken(previous)}`;
    jar.set(SESSION_COOKIE, await createSession(userId), { httpOnly: true, sameSite: 'lax', secure: new URL(request.url).protocol === 'https:', path: '/', maxAge: 604800 });
    return go('/dashboard');
  } catch { return failure(); }
}
