/**
 * Connect X (drizzle/0032): sign in once, keep a copy of the public profile, refresh it rarely.
 *
 * Cost model: X bills every profile it returns. spaca reads a profile when the creator connects, when the creator asks
 * for a refresh (at most once a day), and in a background batch only for copies that someone viewed after they became
 * older than X_REFRESH_AFTER_DAYS (7 by default). Buyers looking at a profile never cause a read by themselves, and a
 * monthly ceiling (X_READS_MONTHLY_CAP, 1000 profiles by default) stops all reads once reached. Every read is logged
 * in app.x_api_usage.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Actor } from '@/lib/auth';
import { isCreator } from '@/lib/account';
import { CommandError, UUID_PATTERN, type CommandHandler, type Row, type Tx } from '@/lib/commands';
import { sql } from '@/lib/db';
import { logError } from '@/lib/log';
import { xProfileUrl, type XProfileView, type XSource } from '@/lib/x-profile';
import { onboardingPath } from '@/lib/onboarding';
import { keepsAnotherSignIn } from '@/modules/google/service';
import { canonicalizeSocialAccount } from '@/modules/publish';
import { XProviderError, codeChallengeFor, getXProvider, type XProfile, type XProvider } from './provider';

const STATE_TTL_MINUTES = 10;
const MAX_STARTS_PER_WINDOW = 10;
const OWN_REFRESH_HOURS = 24;
const MAX_REFRESH_FAILURES = 5;
const MAX_LINKED_ACCOUNTS = 10;

const positive = (value: string | undefined, fallback: number) => (value && /^\d+$/.test(value) && Number(value) > 0 ? Number(value) : fallback);
export const xRefreshAfterDays = () => positive(process.env.X_REFRESH_AFTER_DAYS, 7);
export const xReadsMonthlyCap = () => positive(process.env.X_READS_MONTHLY_CAP, 1000);

const hashState = (state: string) => createHash('sha256').update(state).digest('hex');
const safeReturn = (value: unknown) => {
  const path = String(value ?? '');
  return /^\/[^/]/.test(path) && path.length < 300 && !path.startsWith('/api/') ? path : '/settings/profile';
};

export const xConnectAvailable = () => getXProvider() !== null;

function requireProvider(): XProvider {
  const provider = getXProvider();
  if (!provider) throw new CommandError('Connecting X is not available in this environment', 'DOMAIN_RULE');
  return provider;
}

async function readsThisMonth(source: XSource): Promise<number> {
  const [row] = await sql<{ n: number }[]>`select coalesce(sum(resources),0)::int as n from app.x_api_usage
    where source=${source} and created_at >= date_trunc('month', now())`;
  return Number(row?.n ?? 0);
}

async function recordUsage(source: XSource, operation: 'USERS_ME' | 'USERS_LOOKUP', resources: number, userId: string | null) {
  await sql`insert into app.x_api_usage (source,operation,resources,user_id) values (${source},${operation},${resources},${userId})`;
}

async function assertBudget(source: XSource, needed: number) {
  if ((await readsThisMonth(source)) + needed > xReadsMonthlyCap()) {
    throw new CommandError('X reads are paused until next month: spaca reached its monthly limit. Your saved X profile still shows.', 'DOMAIN_RULE');
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Connect

/** Starts sign-in with X and returns where to send the browser. The state is single-use and bound to this account. */
export async function startXConnect(actor: Actor, returnTo: unknown, redirectUri: string): Promise<string> {
  const provider = requireProvider();
  if (!isCreator(actor)) throw new CommandError('Connecting X is for creator accounts', 'FORBIDDEN');
  if (actor.status !== 'ACTIVE') throw new CommandError('This account is suspended; only existing orders can be handled', 'ACCOUNT_SUSPENDED');
  const [recent] = await sql<{ n: number }[]>`select count(*)::int as n from app.x_oauth_states where user_id=${actor.id} and created_at > now() - interval '10 minutes'`;
  if (Number(recent?.n ?? 0) >= MAX_STARTS_PER_WINDOW) throw new CommandError('Too many attempts to connect X. Try again in a few minutes.', 'RATE_LIMITED');
  await assertBudget(provider.source, 1);
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  await sql`insert into app.x_oauth_states (user_id,source,state_hash,code_verifier,return_to,expires_at)
    values (${actor.id},${provider.source},${hashState(state)},${verifier},${safeReturn(returnTo)},now() + make_interval(mins => ${STATE_TTL_MINUTES}))`;
  return provider.authorizeUrl({ state, codeChallenge: codeChallengeFor(verifier), redirectUri });
}

export type ConnectOutcome = { returnTo: string; message?: string; error?: string };

/** Finishes sign-in: claims the state, reads the X account once, saves it and marks the linked X account verified. */
export async function completeXConnect(actor: Actor, input: { state: string; code: string; error: string }, redirectUri: string): Promise<ConnectOutcome> {
  const provider = requireProvider();
  const claimed = input.state ? await sql.begin(async (tx) => {
    const [row] = await tx<Row[]>`select id,user_id,source,code_verifier,return_to,used_at,expires_at < now() as expired
      from app.x_oauth_states where state_hash=${hashState(input.state)} for update`;
    if (!row || String(row.user_id) !== actor.id || row.used_at || row.expired || row.source !== provider.source) return null;
    await tx`update app.x_oauth_states set used_at=now() where id=${String(row.id)}`;
    return row;
  }) : null;
  if (!claimed) return { returnTo: '/settings/profile', error: 'This X sign-in expired or was already used. Start again from your profile.' };
  const returnTo = safeReturn(claimed.return_to);
  if (input.error || !input.code) {
    return { returnTo, error: input.error === 'access_denied' ? 'X sign-in was cancelled. Nothing was connected.' : 'X did not complete the sign-in. Nothing was connected.' };
  }

  let profile: XProfile;
  try {
    profile = await provider.signedInProfile({ code: input.code, codeVerifier: String(claimed.code_verifier), redirectUri });
  } catch (error) {
    if (error instanceof XProviderError) return { returnTo, error: error.message };
    logError('x sign-in failed', error);
    return { returnTo, error: 'X could not be reached. Try again later.' };
  }
  await recordUsage(provider.source, 'USERS_ME', 1, actor.id);
  if (profile.protected) return { returnTo, error: `@${profile.username} is a protected account. Buyers cannot see protected posts, so it cannot be connected.` };
  try {
    const note = await sql.begin((tx) => saveConnection(tx, { id: actor.id, creator: true }, profile, provider.source));
    return { returnTo, message: `X account @${profile.username} connected.${note}` };
  } catch (error) {
    if (error instanceof CommandError) return { returnTo, error: error.message };
    throw error;
  }
}

async function unverifyLinkedAccount(tx: Tx, userId: string, socialAccountId: string) {
  await tx`update app.social_accounts set verification_status='SELF_REPORTED',verified_at=null,verified_by=null,verification_method=null,updated_at=now()
    where id=${socialAccountId} and creator_id=${userId} and verification_method='X_OAUTH'`;
}

/** The linked X account for this username, verified by the sign-in; created when the creator had not listed it yet. */
async function linkSocialAccount(tx: Tx, actor: { id: string }, username: string): Promise<{ id: string | null; note: string }> {
  const { handle, canonicalUrl } = canonicalizeSocialAccount('X', username);
  const [live] = await tx<Row[]>`select id,creator_id,verification_status from app.social_accounts
    where platform='X' and lower(canonical_url)=lower(${canonicalUrl}) and removed_at is null for update`;
  if (live && String(live.creator_id) !== actor.id) {
    throw new CommandError(`Another spaca account listed @${handle} as its own. Contact support if this X account is yours.`, 'ORDER_STATE_CONFLICT');
  }
  if (live) {
    if (live.verification_status !== 'VERIFIED') {
      await tx`update app.social_accounts set verification_status='VERIFIED',verified_at=now(),verified_by=${actor.id},verification_method='X_OAUTH',updated_at=now()
        where id=${String(live.id)}`;
    }
    return { id: String(live.id), note: '' };
  }
  const [linked] = await tx<{ n: number }[]>`select count(*)::int as n from app.social_accounts where creator_id=${actor.id} and removed_at is null`;
  if (Number(linked?.n ?? 0) >= MAX_LINKED_ACCOUNTS) return { id: null, note: ' It was not added to your linked accounts because you already have 10.' };
  const [created] = await tx<Row[]>`insert into app.social_accounts (creator_id,platform,handle,canonical_url,verification_status,verified_at,verified_by,verification_method)
    values (${actor.id},'X',${handle},${canonicalUrl},'VERIFIED',now(),${actor.id},'X_OAUTH') returning id`;
  return { id: String(created!.id), note: '' };
}

/**
 * Saves the X account on a spaca account: the profile copy, the identity it signs in with, and for creators the verified
 * linked account. One X account belongs to one spaca account.
 */
/**
 * A new creator account starts out as its X account: the same @handle, bio, location and link, and (through
 * `app.x_profiles`) the same photo. Account setup still shows every field and can change any of it. A handle that is
 * already taken, or too short to be a spaca handle, leaves the profile unwritten and setup asks for one.
 *
 * Buyers are skipped on purpose: a buyer account is a project, not the person whose X account opened it, so its
 * handle comes from the project name given in setup and its introduction describes the project.
 */
async function seedProfileFromX(tx: Tx, userId: string, profile: XProfile) {
  const handle = profile.username.toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(handle)) return;
  await tx`insert into app.profiles (user_id,handle,bio,niche,social_url,location)
    values (${userId},${handle},${profile.description.slice(0, 600)},'',${xProfileUrl(profile.username)},${profile.location.slice(0, 120)})
    on conflict do nothing`;
}

async function saveConnection(tx: Tx, actor: { id: string; creator: boolean }, profile: XProfile, source: XSource): Promise<string> {
  await tx`select pg_advisory_xact_lock(hashtextextended(${`x-profile:${source}:${profile.xUserId}`}, 0))`;
  const [owner] = await tx<Row[]>`select 1 from app.x_profiles where source=${source} and x_user_id=${profile.xUserId} and user_id<>${actor.id}
    union all select 1 from app.user_identities where provider='X' and source=${source} and subject=${profile.xUserId} and user_id<>${actor.id}`;
  if (owner) throw new CommandError(`@${profile.username} is already connected to another spaca account. Contact support if it is yours.`, 'ORDER_STATE_CONFLICT');
  const [previous] = await tx<Row[]>`select x_user_id,social_account_id from app.x_profiles where user_id=${actor.id} for update`;
  // Connecting a different X account replaces the previous one, whose linked account goes back to self-reported.
  if (previous && String(previous.x_user_id) !== profile.xUserId && previous.social_account_id) {
    await unverifyLinkedAccount(tx, actor.id, String(previous.social_account_id));
  }
  await tx`insert into app.user_identities (user_id,provider,source,subject) values (${actor.id},'X',${source},${profile.xUserId})
    on conflict (user_id,provider) do update set source=excluded.source,subject=excluded.subject,
      created_at=case when app.user_identities.subject=excluded.subject then app.user_identities.created_at else now() end`;
  const linked = actor.creator ? await linkSocialAccount(tx, actor, profile.username) : { id: null, note: '' };
  await tx`insert into app.x_profiles (user_id,source,x_user_id,username,name,profile_image_url,description,location,verified,verified_type,protected,
      followers_count,following_count,tweet_count,listed_count,x_created_at,social_account_id,connected_at,fetched_at)
    values (${actor.id},${source},${profile.xUserId},${profile.username},${profile.name},${profile.profileImageUrl},${profile.description},${profile.location},
      ${profile.verified},${profile.verifiedType},${profile.protected},${profile.followers},${profile.following},${profile.posts},${profile.listed},
      ${profile.createdAt},${linked.id},now(),now())
    on conflict (user_id) do update set source=excluded.source,x_user_id=excluded.x_user_id,username=excluded.username,name=excluded.name,
      profile_image_url=excluded.profile_image_url,description=excluded.description,location=excluded.location,verified=excluded.verified,
      verified_type=excluded.verified_type,protected=excluded.protected,followers_count=excluded.followers_count,following_count=excluded.following_count,
      tweet_count=excluded.tweet_count,listed_count=excluded.listed_count,x_created_at=excluded.x_created_at,social_account_id=excluded.social_account_id,
      connected_at=case when app.x_profiles.x_user_id=excluded.x_user_id then app.x_profiles.connected_at else now() end,
      fetched_at=now(),refresh_requested_at=null,unavailable_at=null,refresh_failures=0,last_refresh_error=null,updated_at=now()`;
  return linked.note;
}

/**
 * Disconnect: the saved copy and the X sign-in are deleted; the linked X account stays, as self-reported, because services
 * may post on it. An account that signs in only with X keeps it until an email and password are added.
 */
export const disconnectX: CommandHandler = async ({ tx, actor }) => {
  const [account] = await tx<Row[]>`select exists(select 1 from app.x_profiles where user_id=${actor.id}) as connected from app.users where id=${actor.id} for update`;
  if (!account?.connected) throw new CommandError('No X account is connected', 'NOT_FOUND');
  // An account made with X has no email until one is added (with its password) under Sign-in, and may have connected Google.
  if (!(await keepsAnotherSignIn(tx, actor.id, 'X'))) {
    throw new CommandError('X is how you sign in to this account. Add an email and password under Sign-in first, then disconnect X.', 'DOMAIN_RULE');
  }
  const [removed] = await tx<Row[]>`delete from app.x_profiles where user_id=${actor.id} returning username,social_account_id`;
  await tx`delete from app.user_identities where user_id=${actor.id} and provider='X'`;
  if (!removed) throw new CommandError('No X account is connected', 'NOT_FOUND');
  if (removed.social_account_id) await unverifyLinkedAccount(tx, actor.id, String(removed.social_account_id));
  return { path: '/settings/profile', message: `@${String(removed.username)} disconnected. The linked account shows as self-reported again.` };
};

// ---------------------------------------------------------------------------------------------------------------------
// Sign in and sign up with X (drizzle/0035)
//
// New accounts are created by signing in with X; an email and password can be added later from settings. A sign-in reads
// the X account once (X bills that read like any other), but never waits on the monthly read ceiling: nobody is locked
// out of their account because the budget ran out. The read is still recorded.

export type XSignInIntent = 'SIGN_IN' | 'SIGN_UP';
export type AccountTypeChoice = 'buyer' | 'creator';

/** Sign-in attempts not yet tied to an account, across everyone, per 10 minutes. */
const MAX_ANONYMOUS_STARTS = 300;

const signInReturn = (value: unknown) => {
  const path = String(value ?? '');
  return /^\/[^/]/.test(path) && path.length < 300 && !path.startsWith('/api/') && !path.startsWith('/sign-') ? path : '/dashboard';
};

/** Starts "Continue with X" from the sign-in or sign-up dialog and returns where to send the browser. */
export async function startXSignIn(input: { intent: XSignInIntent; accountType: AccountTypeChoice | null; returnTo: unknown }, redirectUri: string): Promise<string> {
  const provider = requireProvider();
  if (input.intent === 'SIGN_UP' && !input.accountType) throw new CommandError('Choose Buyer or Creator first', 'INVALID_INPUT');
  const [recent] = await sql<{ n: number }[]>`select count(*)::int as n from app.x_oauth_states where user_id is null and created_at > now() - interval '10 minutes'`;
  if (Number(recent?.n ?? 0) >= MAX_ANONYMOUS_STARTS) throw new CommandError('Too many people are signing in with X right now. Try again in a few minutes.', 'RATE_LIMITED');
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  await sql`insert into app.x_oauth_states (user_id,source,state_hash,code_verifier,return_to,expires_at,purpose,account_type)
    values (null,${provider.source},${hashState(state)},${verifier},${signInReturn(input.returnTo)},now() + make_interval(mins => ${STATE_TTL_MINUTES}),
      ${input.intent},${input.intent === 'SIGN_UP' ? input.accountType : null})`;
  return provider.authorizeUrl({ state, codeChallenge: codeChallengeFor(verifier), redirectUri });
}

/** What an X callback's state was started for, so the callback can finish a connection or a sign-in. */
export async function xStatePurpose(state: string): Promise<'CONNECT' | XSignInIntent | null> {
  if (!state) return null;
  const [row] = await sql<{ purpose: string }[]>`select purpose from app.x_oauth_states where state_hash=${hashState(state)}`;
  return row ? row.purpose as 'CONNECT' | XSignInIntent : null;
}

/** `userId` is set when the browser should be signed in to that account; `path` is where to go next, with the notice. */
export type XSignInOutcome = { path: string; userId?: string; message?: string; error?: string };

/**
 * Finishes "Continue with X": an X account already used by a spaca account signs in to it (from either dialog); from the
 * sign-up dialog an unknown X account becomes a new account of the chosen type, without an email, headed to setup.
 */
export async function completeXSignIn(input: { state: string; code: string; error: string }, redirectUri: string): Promise<XSignInOutcome> {
  const provider = requireProvider();
  const claimed = input.state ? await sql.begin(async (tx) => {
    const [row] = await tx<Row[]>`select id,source,code_verifier,return_to,purpose,account_type,used_at,expires_at < now() as expired
      from app.x_oauth_states where state_hash=${hashState(input.state)} and purpose in ('SIGN_IN','SIGN_UP') for update`;
    if (!row || row.used_at || row.expired || row.source !== provider.source) return null;
    await tx`update app.x_oauth_states set used_at=now() where id=${String(row.id)}`;
    return row;
  }) : null;
  if (!claimed) return { path: '/sign-in', error: 'This X sign-in expired or was already used. Try again.' };
  const intent = claimed.purpose as XSignInIntent;
  const accountType = claimed.account_type === 'creator' ? 'creator' : 'buyer';
  const returnTo = signInReturn(claimed.return_to);
  const retry = intent === 'SIGN_UP' ? `/sign-up?role=${accountType}` : '/sign-in';
  if (input.error || !input.code) {
    return { path: retry, error: input.error === 'access_denied' ? 'X sign-in was cancelled.' : 'X did not complete the sign-in. Try again.' };
  }

  let profile: XProfile;
  try {
    profile = await provider.signedInProfile({ code: input.code, codeVerifier: String(claimed.code_verifier), redirectUri });
  } catch (error) {
    if (error instanceof XProviderError) return { path: retry, error: error.message };
    logError('x sign-in failed', error);
    return { path: retry, error: 'X could not be reached. Try again later.' };
  }
  await recordUsage(provider.source, 'USERS_ME', 1, null);

  try {
    return await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`x-profile:${provider.source}:${profile.xUserId}`}, 0))`;
      const [known] = await tx<Row[]>`select u.id,u.status,u.onboarded_at is not null as onboarded from app.user_identities i join app.users u on u.id=i.user_id
        where i.provider='X' and i.source=${provider.source} and i.subject=${profile.xUserId}`;
      if (known) {
        if (!['ACTIVE', 'SUSPENDED'].includes(String(known.status))) return { path: '/sign-in', error: 'This account is closed.' };
        await tx`update app.user_identities set last_sign_in_at=now() where user_id=${String(known.id)} and provider='X'`;
        // The sign-in already read the account, so the saved copy is brought up to date at no extra cost.
        await tx`update app.x_profiles set username=${profile.username},name=${profile.name},profile_image_url=${profile.profileImageUrl},description=${profile.description},
            location=${profile.location},verified=${profile.verified},verified_type=${profile.verifiedType},protected=${profile.protected},
            followers_count=${profile.followers},following_count=${profile.following},tweet_count=${profile.posts},listed_count=${profile.listed},
            x_created_at=${profile.createdAt},fetched_at=now(),refresh_requested_at=null,unavailable_at=null,refresh_failures=0,last_refresh_error=null,updated_at=now()
          where user_id=${String(known.id)} and source=${provider.source} and x_user_id=${profile.xUserId}`;
        return {
          userId: String(known.id),
          path: known.onboarded ? returnTo : onboardingPath(returnTo),
          message: intent === 'SIGN_UP' ? `@${profile.username} already has a spaca account, so you are signed in to it.` : undefined,
        };
      }
      if (intent === 'SIGN_IN') {
        return { path: '/sign-up', error: `No spaca account signs in with @${profile.username} yet. Choose Buyer or Creator to create one.` };
      }
      if (accountType === 'creator' && profile.protected) {
        return { path: retry, error: `@${profile.username} is a protected account. Buyers cannot see protected posts, so a creator account needs a public X account.` };
      }
      // Accounts made in a local build or with the sandbox X are test data; in production they are real supply.
      const testData = process.env.NODE_ENV !== 'production' || provider.source === 'MOCK';
      const [created] = await tx<Row[]>`insert into app.users (id,email,display_name,password_hash,roles,is_test,status,onboarded_at)
        values (gen_random_uuid(),null,${profile.name.slice(0, 100)},null,${[accountType]},${testData},'ACTIVE',null) returning id`;
      const userId = String(created!.id);
      await saveConnection(tx, { id: userId, creator: accountType === 'creator' }, profile, provider.source);
      if (accountType === 'creator') await seedProfileFromX(tx, userId, profile);
      await tx`update app.user_identities set last_sign_in_at=now() where user_id=${userId} and provider='X'`;
      return { userId, path: onboardingPath(returnTo), message: `Signed up with X as @${profile.username}.` };
    });
  } catch (error) {
    if (error instanceof CommandError) return { path: retry, error: error.message };
    throw error;
  }
}

/** How an account can sign in: its X account (with the saved username), its Google account, and its email and password. */
export async function getSignInMethods(userId: string): Promise<{ xUsername: string | null; xSource: XSource | null; googleEmail: string | null; googleSandbox: boolean; email: string | null; hasPassword: boolean }> {
  const [row] = await sql<Row[]>`select u.email,u.password_hash is not null as has_password,i.source,x.username,g.email as google_email,g.source as google_source
    from app.users u left join app.user_identities i on i.user_id=u.id and i.provider='X' left join app.x_profiles x on x.user_id=u.id
      left join app.user_identities g on g.user_id=u.id and g.provider='GOOGLE'
    where u.id=${userId}`;
  return {
    xUsername: row?.source ? String(row.username ?? '') || null : null,
    xSource: row?.source ? row.source as XSource : null,
    googleEmail: row?.google_email ? String(row.google_email) : null,
    googleSandbox: row?.google_source === 'MOCK',
    email: row?.email ? String(row.email) : null,
    hasPassword: Boolean(row?.has_password),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Refresh

type Candidate = { user_id: string; x_user_id: string; username: string; social_account_id: string | null };

/** Keeps the linked account's handle in step when the creator renamed their X account, unless the new name is taken. */
async function followRename(tx: Tx, userId: string, socialAccountId: string | null, username: string) {
  if (!socialAccountId) return;
  const { handle, canonicalUrl } = canonicalizeSocialAccount('X', username);
  const [taken] = await tx<Row[]>`select 1 from app.social_accounts where platform='X' and lower(canonical_url)=lower(${canonicalUrl}) and removed_at is null and id<>${socialAccountId}`;
  if (taken) return;
  await tx`update app.social_accounts set handle=${handle},canonical_url=${canonicalUrl},updated_at=now()
    where id=${socialAccountId} and creator_id=${userId} and verification_method='X_OAUTH' and lower(canonical_url)<>lower(${canonicalUrl})`;
}

async function applyLookup(candidates: Candidate[], result: { found: XProfile[]; missing: string[] }) {
  const outcomes = { REFRESHED: 0, UNAVAILABLE: 0 };
  await sql.begin(async (tx) => {
    for (const candidate of candidates) {
      const profile = result.found.find((found) => found.xUserId === candidate.x_user_id);
      if (profile) {
        await tx`update app.x_profiles set username=${profile.username},name=${profile.name},profile_image_url=${profile.profileImageUrl},description=${profile.description},
            location=${profile.location},verified=${profile.verified},verified_type=${profile.verifiedType},protected=${profile.protected},
            followers_count=${profile.followers},following_count=${profile.following},tweet_count=${profile.posts},listed_count=${profile.listed},
            x_created_at=${profile.createdAt},fetched_at=now(),refresh_requested_at=null,unavailable_at=null,refresh_failures=0,last_refresh_error=null,updated_at=now()
          where user_id=${candidate.user_id} and x_user_id=${candidate.x_user_id}`;
        if (profile.username.toLowerCase() !== candidate.username.toLowerCase()) await followRename(tx, candidate.user_id, candidate.social_account_id, profile.username);
        outcomes.REFRESHED += 1;
      } else if (result.missing.includes(candidate.x_user_id)) {
        await tx`update app.x_profiles set unavailable_at=now(),refresh_requested_at=null,updated_at=now() where user_id=${candidate.user_id} and x_user_id=${candidate.x_user_id}`;
        outcomes.UNAVAILABLE += 1;
      }
    }
  });
  return outcomes;
}

/** The creator's own "Refresh from X", at most once a day. */
export async function refreshOwnXProfile(actor: Actor): Promise<string> {
  const provider = requireProvider();
  const [row] = await sql<(Candidate & { source: string; hours: number })[]>`select user_id,x_user_id,username,social_account_id,source,
      extract(epoch from (now() - fetched_at))/3600 as hours from app.x_profiles where user_id=${actor.id}`;
  if (!row) throw new CommandError('No X account is connected', 'NOT_FOUND');
  if (row.source !== provider.source) throw new CommandError('This X account was connected in a different environment. Connect it again.', 'DOMAIN_RULE');
  const hours = Number(row.hours);
  if (hours < OWN_REFRESH_HOURS) {
    const wait = Math.max(1, Math.ceil(OWN_REFRESH_HOURS - hours));
    throw new CommandError(`Your X profile was updated less than a day ago. You can refresh again in ${wait} ${wait === 1 ? 'hour' : 'hours'}.`, 'DOMAIN_RULE');
  }
  await assertBudget(provider.source, 1);
  let result: { found: XProfile[]; missing: string[] };
  try {
    result = await provider.lookup([{ xUserId: row.x_user_id, username: row.username }]);
  } catch (error) {
    if (error instanceof XProviderError) throw new CommandError(error.message, error.code === 'RATE_LIMITED' ? 'RATE_LIMITED' : 'DOMAIN_RULE');
    throw error;
  }
  await recordUsage(provider.source, 'USERS_LOOKUP', result.found.length, actor.id);
  const outcome = await applyLookup([row], result);
  return outcome.REFRESHED ? 'X profile updated' : 'X no longer shows this account. It stays connected with its last saved details.';
}

/**
 * Called when someone looks at creators' X profiles: copies older than the refresh age are queued for the background
 * refresh. Cheap and idempotent — a copy already queued, unavailable or fresh is left alone.
 */
export async function requestXRefresh(userIds: string[]): Promise<number> {
  const ids = [...new Set(userIds.filter((id) => UUID_PATTERN.test(id)))];
  if (!ids.length) return 0;
  const queued = await sql`update app.x_profiles set refresh_requested_at=now()
    where user_id = any(${ids}::uuid[]) and refresh_requested_at is null and unavailable_at is null
      and fetched_at < now() - make_interval(days => ${xRefreshAfterDays()}) returning user_id`;
  return queued.length;
}

/** Background job: one X lookup for up to 100 queued copies, within the monthly ceiling. */
export async function refreshRequestedXProfiles(options: { limit?: number } = {}): Promise<{ examined: number; outcomes: Record<string, number> }> {
  const provider = getXProvider();
  if (!provider) return { examined: 0, outcomes: {} };
  const room = xReadsMonthlyCap() - (await readsThisMonth(provider.source));
  const limit = Math.min(options.limit ?? 100, 100);
  if (room <= 0) {
    const [queued] = await sql<{ n: number }[]>`select count(*)::int as n from app.x_profiles where source=${provider.source} and refresh_requested_at is not null and unavailable_at is null`;
    const n = Number(queued?.n ?? 0);
    return { examined: n, outcomes: n ? { SKIPPED_MONTHLY_CAP: n } : {} };
  }
  const candidates = await sql<Candidate[]>`select user_id,x_user_id,username,social_account_id from app.x_profiles
    where source=${provider.source} and refresh_requested_at is not null and unavailable_at is null and refresh_failures < ${MAX_REFRESH_FAILURES}
    order by refresh_requested_at limit ${Math.min(limit, room)}`;
  if (!candidates.length) return { examined: 0, outcomes: {} };
  let result: { found: XProfile[]; missing: string[] };
  try {
    result = await provider.lookup(candidates.map((candidate) => ({ xUserId: candidate.x_user_id, username: candidate.username })));
  } catch (error) {
    if (!(error instanceof XProviderError)) logError('x profile refresh failed', error);
    const message = error instanceof XProviderError ? error.message : 'X refresh failed';
    await sql`update app.x_profiles set refresh_failures=refresh_failures+1,last_refresh_error=${message.slice(0, 200)},updated_at=now()
      where user_id = any(${candidates.map((candidate) => candidate.user_id)}::uuid[])`;
    return { examined: candidates.length, outcomes: { FAILED: candidates.length } };
  }
  await recordUsage(provider.source, 'USERS_LOOKUP', result.found.length, null);
  const outcome = await applyLookup(candidates, result);
  return { examined: candidates.length, outcomes: Object.fromEntries(Object.entries(outcome).filter(([, n]) => n > 0)) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Read

/** Saved X profiles by spaca user id, ready for pages and client components (numbers and ISO strings only). */
export async function getXProfileViews(userIds: string[]): Promise<Map<string, XProfileView>> {
  const ids = [...new Set(userIds.filter((id) => UUID_PATTERN.test(id)))];
  if (!ids.length) return new Map();
  const rows = await sql<Row[]>`select user_id,source,username,name,profile_image_url,description,location,verified,verified_type,
      followers_count,following_count,tweet_count,x_created_at,fetched_at,unavailable_at,
      (refresh_requested_at is null and unavailable_at is null and fetched_at < now() - make_interval(days => ${xRefreshAfterDays()})) as refresh_due
    from app.x_profiles where user_id = any(${ids}::uuid[])`;
  return new Map(rows.map((row) => [String(row.user_id), {
    source: row.source as XSource,
    username: String(row.username),
    name: String(row.name),
    imageUrl: row.profile_image_url ? String(row.profile_image_url) : null,
    description: String(row.description ?? ''),
    location: String(row.location ?? ''),
    verified: Boolean(row.verified),
    verifiedType: row.verified_type ? String(row.verified_type) : null,
    followers: Number(row.followers_count),
    following: Number(row.following_count),
    posts: Number(row.tweet_count),
    joinedAt: row.x_created_at ? new Date(String(row.x_created_at)).toISOString() : null,
    fetchedAt: new Date(String(row.fetched_at)).toISOString(),
    unavailable: row.unavailable_at != null,
    refreshDue: Boolean(row.refresh_due),
  } satisfies XProfileView]));
}

/** Hours until the creator may refresh their own profile again (0 when they may now). */
export async function hoursUntilOwnRefresh(userId: string): Promise<number> {
  const [row] = await sql<{ hours: number }[]>`select extract(epoch from (now() - fetched_at))/3600 as hours from app.x_profiles where user_id=${userId}`;
  return row ? Math.max(0, Math.ceil(OWN_REFRESH_HOURS - Number(row.hours))) : 0;
}
