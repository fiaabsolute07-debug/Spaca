/**
 * Connect Google and Continue with Google (drizzle/0036). Accounts are created by signing up with X (drizzle/0035); a
 * Google account (Gmail) is connected afterwards from settings and from then on signs in to that account. One Google
 * account belongs to one spaca account. Signing in with a Google account nobody connected points to sign-up with X.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Actor } from '@/lib/auth';
import { CommandError, type CommandHandler, type Row, type Tx } from '@/lib/commands';
import { sql } from '@/lib/db';
import { logError } from '@/lib/log';
import { onboardingPath } from '@/lib/onboarding';
import { codeChallengeFor } from '@/modules/x/provider';
import { GoogleProviderError, getGoogleProvider, type GoogleProfile, type GoogleProvider } from './provider';

const STATE_TTL_MINUTES = 10;
const MAX_CONNECTS_PER_WINDOW = 10;
/** Sign-in attempts not yet tied to an account, across everyone, per 10 minutes. */
const MAX_ANONYMOUS_STARTS = 300;

export type GoogleIntent = 'CONNECT' | 'SIGN_IN';

const hashState = (state: string) => createHash('sha256').update(state).digest('hex');
const safeReturn = (value: unknown, fallback: string) => {
  const path = String(value ?? '');
  return /^\/[^/]/.test(path) && path.length < 300 && !path.startsWith('/api/') && !path.startsWith('/sign-') ? path : fallback;
};

export const googleAvailable = () => getGoogleProvider() !== null;

function requireProvider(): GoogleProvider {
  const provider = getGoogleProvider();
  if (!provider) throw new CommandError('Google is not available in this environment', 'DOMAIN_RULE');
  return provider;
}

/** Starts Connect Google (signed in) or Continue with Google (signed out) and returns where to send the browser. */
export async function startGoogle(input: { intent: GoogleIntent; actor: Actor | null; returnTo: unknown }, redirectUri: string): Promise<string> {
  const provider = requireProvider();
  const connect = input.intent === 'CONNECT';
  if (connect) {
    if (!input.actor) throw new CommandError('Sign in first, then connect Google from your account settings', 'FORBIDDEN');
    if (input.actor.status !== 'ACTIVE') throw new CommandError('This account is suspended; only existing orders can be handled', 'ACCOUNT_SUSPENDED');
    const [recent] = await sql<{ n: number }[]>`select count(*)::int as n from app.google_oauth_states where user_id=${input.actor.id} and created_at > now() - interval '10 minutes'`;
    if (Number(recent?.n ?? 0) >= MAX_CONNECTS_PER_WINDOW) throw new CommandError('Too many attempts to connect Google. Try again in a few minutes.', 'RATE_LIMITED');
  } else {
    const [recent] = await sql<{ n: number }[]>`select count(*)::int as n from app.google_oauth_states where user_id is null and created_at > now() - interval '10 minutes'`;
    if (Number(recent?.n ?? 0) >= MAX_ANONYMOUS_STARTS) throw new CommandError('Too many people are signing in with Google right now. Try again in a few minutes.', 'RATE_LIMITED');
  }
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  await sql`insert into app.google_oauth_states (user_id,purpose,source,state_hash,code_verifier,return_to,expires_at)
    values (${connect ? input.actor!.id : null},${input.intent},${provider.source},${hashState(state)},${verifier},
      ${safeReturn(input.returnTo, connect ? '/settings/profile' : '/dashboard')},now() + make_interval(mins => ${STATE_TTL_MINUTES}))`;
  return provider.authorizeUrl({ state, codeChallenge: codeChallengeFor(verifier), redirectUri });
}

/** What a Google callback's state was started for. */
export async function googleStatePurpose(state: string): Promise<GoogleIntent | null> {
  if (!state) return null;
  const [row] = await sql<{ purpose: string }[]>`select purpose from app.google_oauth_states where state_hash=${hashState(state)}`;
  return row ? row.purpose as GoogleIntent : null;
}

/** `userId` is set when the browser should be signed in to that account; `path` is where to go next, with the notice. */
export type GoogleOutcome = { path: string; userId?: string; message?: string; error?: string };

/**
 * Finishes either flow. Connecting needs the account that started it to still be the one signed in; signing in needs a
 * spaca account that connected this Google account.
 */
export async function completeGoogle(actor: Actor | null, input: { state: string; code: string; error: string }, redirectUri: string): Promise<GoogleOutcome> {
  const provider = requireProvider();
  const claimed = input.state ? await sql.begin(async (tx) => {
    const [row] = await tx<Row[]>`select id,user_id,purpose,source,code_verifier,return_to,used_at,expires_at < now() as expired
      from app.google_oauth_states where state_hash=${hashState(input.state)} for update`;
    if (!row || row.used_at || row.expired || row.source !== provider.source) return null;
    if (row.purpose === 'CONNECT' && String(row.user_id) !== actor?.id) return null;
    await tx`update app.google_oauth_states set used_at=now() where id=${String(row.id)}`;
    return row;
  }) : null;
  if (!claimed) return { path: actor ? '/settings/profile' : '/sign-in', error: 'This Google sign-in expired or was already used. Try again.' };
  const connect = claimed.purpose === 'CONNECT';
  const retry = connect ? '/settings/profile' : '/sign-in';
  const returnTo = safeReturn(claimed.return_to, connect ? '/settings/profile' : '/dashboard');
  if (input.error || !input.code) {
    return { path: retry, error: input.error === 'access_denied' ? `Google sign-in was cancelled.${connect ? ' Nothing was connected.' : ''}` : 'Google did not complete the sign-in. Try again.' };
  }

  let profile: GoogleProfile;
  try {
    profile = await provider.signedInProfile({ code: input.code, codeVerifier: String(claimed.code_verifier), redirectUri });
  } catch (error) {
    if (error instanceof GoogleProviderError) return { path: retry, error: error.message };
    logError('google sign-in failed', error);
    return { path: retry, error: 'Google could not be reached. Try again later.' };
  }

  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`google:${provider.source}:${profile.sub}`}, 0))`;
    const [owner] = await tx<Row[]>`select i.user_id,u.status,u.onboarded_at is not null as onboarded from app.user_identities i join app.users u on u.id=i.user_id
      where i.provider='GOOGLE' and i.source=${provider.source} and i.subject=${profile.sub}`;

    if (connect) {
      if (owner && String(owner.user_id) !== actor!.id) {
        return { path: retry, error: `${profile.email} is already connected to another spaca account. Contact support if it is yours.` };
      }
      // Connecting a different Google account replaces the previous one.
      await tx`insert into app.user_identities (user_id,provider,source,subject,email) values (${actor!.id},'GOOGLE',${provider.source},${profile.sub},${profile.email})
        on conflict (user_id,provider) do update set source=excluded.source,subject=excluded.subject,email=excluded.email,
          created_at=case when app.user_identities.subject=excluded.subject then app.user_identities.created_at else now() end`;
      return { path: returnTo, message: `Google account ${profile.email} connected. You can now sign in with Google.` };
    }

    if (!owner) {
      return { path: '/sign-up', error: `No spaca account signs in with ${profile.email} yet. Sign up with X, then connect Google from your account settings.` };
    }
    if (!['ACTIVE', 'SUSPENDED'].includes(String(owner.status))) return { path: '/sign-in', error: 'This account is closed.' };
    await tx`update app.user_identities set last_sign_in_at=now(),email=${profile.email} where user_id=${String(owner.user_id)} and provider='GOOGLE'`;
    return { userId: String(owner.user_id), path: owner.onboarded ? returnTo : onboardingPath(returnTo) };
  });
}

/**
 * Whether an account keeps a way in after removing one provider: another connected provider, or an email (added with its
 * password under Sign-in, or held by accounts from before sign-up with X), or an external auth user.
 */
export async function keepsAnotherSignIn(tx: Tx, userId: string, removing: 'X' | 'GOOGLE'): Promise<boolean> {
  const [row] = await tx<Row[]>`select (u.email is not null or u.auth_user_id is not null
      or exists(select 1 from app.user_identities i where i.user_id=u.id and i.provider<>${removing})) as other
    from app.users u where u.id=${userId}`;
  return Boolean(row?.other);
}

/** Disconnect Google: it stops signing in to the account, unless it is the account's only way in. */
export const disconnectGoogle: CommandHandler = async ({ tx, actor }) => {
  await tx`select 1 from app.users where id=${actor.id} for update`;
  const [identity] = await tx<Row[]>`select email from app.user_identities where user_id=${actor.id} and provider='GOOGLE'`;
  if (!identity) throw new CommandError('No Google account is connected', 'NOT_FOUND');
  if (!(await keepsAnotherSignIn(tx, actor.id, 'GOOGLE'))) {
    throw new CommandError('Google is how you sign in to this account. Connect X or add an email and password first, then disconnect Google.', 'DOMAIN_RULE');
  }
  await tx`delete from app.user_identities where user_id=${actor.id} and provider='GOOGLE'`;
  return { path: '/settings/profile', message: `${String(identity.email)} disconnected. It no longer signs in to this account.` };
};
