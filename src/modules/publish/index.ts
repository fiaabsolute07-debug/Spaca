/**
 * PUBLISH (master §16.9 P6-01/P6-02; XPL-01/02, MOD-02, SUP-06). Social links are canonicalized locally and are
 * always SELF_REPORTED; no social network API is called. A publication proof is a post link on the sold channel,
 * the time it went live and the creator's disclosure attestation. The link is checked against the channel (host,
 * and the handle where the platform puts it in the URL); the post content itself is never fetched or verified.
 */
import { CommandError, instant, zoneOffset, type Row, type Tx } from '@/lib/commands';

export const SOCIAL_PLATFORMS = ['X', 'INSTAGRAM', 'TIKTOK', 'YOUTUBE', 'NEWSLETTER', 'WEBSITE'] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];
export const PUBLISH_FORMATS = ['POST', 'THREAD', 'QUOTE_POST', 'VIDEO', 'NEWSLETTER_ISSUE', 'ARTICLE'] as const;
export const DEFAULT_DISCLOSURE = '#ad';
export const DEFAULT_MIN_LIVE_HOURS = 72;
export const EDITORIAL_POLICY_VERSION = 'publish-v1';
/** Allowed clock skew between the creator's device and the server when stating the publication time. */
const FUTURE_TOLERANCE_MS = 5 * 60_000;

const HOSTS: Record<'X' | 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE', string[]> = {
  X: ['x.com', 'twitter.com', 'mobile.twitter.com', 'mobile.x.com'],
  INSTAGRAM: ['instagram.com'],
  TIKTOK: ['tiktok.com', 'm.tiktok.com'],
  YOUTUBE: ['youtube.com', 'm.youtube.com', 'youtu.be'],
};

export function isSocialPlatform(value: string): value is SocialPlatform {
  return (SOCIAL_PLATFORMS as readonly string[]).includes(value);
}

function parseUrl(value: string, name: string): URL {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new CommandError(`${name} must be a valid link`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new CommandError(`${name} must be an http(s) link`);
  if (url.username || url.password) throw new CommandError(`${name} must not contain credentials`);
  return url;
}

const bareHost = (url: URL) => url.hostname.toLowerCase().replace(/^www\./, '');

/** Accepts "@handle", "handle" or a profile link and returns the one canonical https URL stored for the account. */
export function canonicalizeSocialAccount(platform: SocialPlatform, input: string): { handle: string | null; canonicalUrl: string } {
  const value = input.trim();
  if (!value) throw new CommandError('Enter the account link or handle');
  if (platform === 'X' || platform === 'INSTAGRAM' || platform === 'TIKTOK') {
    const pattern = platform === 'X' ? /^[A-Za-z0-9_]{1,15}$/ : platform === 'INSTAGRAM' ? /^[A-Za-z0-9._]{1,30}$/ : /^[A-Za-z0-9._]{2,24}$/;
    let handle: string | undefined;
    if (/^@?[A-Za-z0-9._]+$/.test(value)) handle = value.replace(/^@/, '');
    else {
      const url = parseUrl(value, 'Account link');
      if (!HOSTS[platform].includes(bareHost(url))) throw new CommandError(`That is not a ${platform === 'X' ? 'X' : platform.toLowerCase()} link`);
      handle = url.pathname.split('/').filter(Boolean)[0]?.replace(/^@/, '');
    }
    if (!handle || !pattern.test(handle)) throw new CommandError('That handle is not valid for this platform');
    const lower = handle.toLowerCase();
    if (platform === 'X' && ['home', 'i', 'search', 'explore', 'settings', 'intent', 'share'].includes(lower)) throw new CommandError('Link your profile, not an X page');
    const canonicalUrl = platform === 'X' ? `https://x.com/${lower}` : platform === 'INSTAGRAM' ? `https://www.instagram.com/${lower}` : `https://www.tiktok.com/@${lower}`;
    return { handle: lower, canonicalUrl };
  }
  const url = parseUrl(value, 'Account link');
  if (platform === 'YOUTUBE') {
    if (!HOSTS.YOUTUBE.includes(bareHost(url)) || bareHost(url) === 'youtu.be') throw new CommandError('That is not a YouTube channel link');
    const [first, second] = url.pathname.split('/').filter(Boolean);
    if (first?.startsWith('@') && /^@[A-Za-z0-9._-]{3,30}$/.test(first)) return { handle: first.slice(1).toLowerCase(), canonicalUrl: `https://www.youtube.com/${first.toLowerCase()}` };
    if (first === 'channel' && second && /^UC[A-Za-z0-9_-]{22}$/.test(second)) return { handle: null, canonicalUrl: `https://www.youtube.com/channel/${second}` };
    throw new CommandError('Use a YouTube channel link like youtube.com/@name');
  }
  // NEWSLETTER / WEBSITE: the site itself; query and fragment are dropped so the same site is one account.
  const path = url.pathname.replace(/\/+$/, '');
  return { handle: null, canonicalUrl: `https://${url.hostname.toLowerCase()}${path}` };
}

export type PublishChannel = { platform: string; handle: string | null; channel_url: string };

/**
 * XPL-02: the post must be on the sold channel. X and TikTok carry the handle in the post URL, so the handle must
 * match (MATCHES_CHANNEL); Instagram and YouTube post URLs do not, so only the platform is checked (SAME_PLATFORM);
 * newsletters and websites must be on the channel's host.
 */
export function checkPostLink(channel: PublishChannel, postUrlInput: string): { postUrl: string; postId: string | null; linkCheck: 'MATCHES_CHANNEL' | 'SAME_PLATFORM' } {
  const url = parseUrl(postUrlInput, 'Post link');
  const host = bareHost(url);
  const parts = url.pathname.split('/').filter(Boolean);
  const wrongChannel = () => new CommandError(`The post must be published on the channel sold in this order (${channel.handle ? `@${channel.handle}` : channel.channel_url})`, 'DOMAIN_RULE');
  switch (channel.platform) {
    case 'X': {
      if (!HOSTS.X.includes(host)) throw wrongChannel();
      const [handle, status, id] = parts;
      if (status !== 'status' || !id || !/^\d{5,25}$/.test(id) || !handle) throw new CommandError('Use the link to the post itself, like x.com/name/status/123…');
      if (handle.toLowerCase() !== channel.handle?.toLowerCase()) throw wrongChannel();
      return { postUrl: `https://x.com/${handle.toLowerCase()}/status/${id}`, postId: id, linkCheck: 'MATCHES_CHANNEL' };
    }
    case 'TIKTOK': {
      if (!HOSTS.TIKTOK.includes(host)) throw wrongChannel();
      const [handle, kind, id] = parts;
      if (!handle?.startsWith('@') || kind !== 'video' || !id || !/^\d{5,25}$/.test(id)) throw new CommandError('Use the link to the video itself, like tiktok.com/@name/video/123…');
      if (handle.slice(1).toLowerCase() !== channel.handle?.toLowerCase()) throw wrongChannel();
      return { postUrl: `https://www.tiktok.com/${handle.toLowerCase()}/video/${id}`, postId: id, linkCheck: 'MATCHES_CHANNEL' };
    }
    case 'INSTAGRAM': {
      if (!HOSTS.INSTAGRAM.includes(host)) throw wrongChannel();
      const [kind, id] = parts;
      if (!['p', 'reel'].includes(kind ?? '') || !id || !/^[A-Za-z0-9_-]{5,40}$/.test(id)) throw new CommandError('Use the link to the post itself, like instagram.com/p/…');
      return { postUrl: `https://www.instagram.com/${kind}/${id}`, postId: id, linkCheck: 'SAME_PLATFORM' };
    }
    case 'YOUTUBE': {
      if (!HOSTS.YOUTUBE.includes(host)) throw wrongChannel();
      const id = host === 'youtu.be' ? parts[0] : parts[0] === 'shorts' ? parts[1] : url.searchParams.get('v');
      if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) throw new CommandError('Use the link to the video itself, like youtube.com/watch?v=…');
      return { postUrl: `https://www.youtube.com/watch?v=${id}`, postId: id, linkCheck: 'SAME_PLATFORM' };
    }
    default: {
      const channelHost = bareHost(new URL(channel.channel_url));
      if (host !== channelHost && !host.endsWith(`.${channelHost}`)) throw wrongChannel();
      return { postUrl: `https://${url.hostname.toLowerCase()}${url.pathname}`, postId: null, linkCheck: 'MATCHES_CHANNEL' };
    }
  }
}

export type PublishTerms = PublishChannel & {
  account_id: string;
  format: string;
  min_live_hours: number;
  disclosure_text: string;
  editorial_policy_version: string;
};

export function publishTermsOf(terms: unknown): PublishTerms | null {
  const publish = (terms as { publish?: unknown } | null)?.publish;
  return publish && typeof publish === 'object' ? (publish as PublishTerms) : null;
}

/** Posting terms shared by service and request forms. */
export function publishFields(form: FormData): { format: string; minLiveHours: number; disclosure: string } {
  const format = String(form.get('publish_format') ?? 'POST').trim() || 'POST';
  if (!(PUBLISH_FORMATS as readonly string[]).includes(format)) throw new CommandError('Unsupported post format');
  const hoursValue = String(form.get('min_live_hours') ?? '').trim();
  const minLiveHours = hoursValue ? Number(hoursValue) : DEFAULT_MIN_LIVE_HOURS;
  if (!Number.isInteger(minLiveHours) || minLiveHours < 0 || minLiveHours > 2160) throw new CommandError('Minimum live time must be 0–2160 hours');
  const disclosure = String(form.get('disclosure_text') ?? '').trim() || DEFAULT_DISCLOSURE;
  if (disclosure.length < 2 || disclosure.length > 80) throw new CommandError('Disclosure must be 2–80 characters, for example "#ad" or "Sponsored by …"');
  return { format, minLiveHours, disclosure };
}

/** Loads a live social account owned by the creator (for listings and applications). */
export async function ownedSocialAccount(tx: Tx, creatorId: string, accountId: string): Promise<Row> {
  const [account] = await tx<Row[]>`select * from app.social_accounts where id=${accountId} and creator_id=${creatorId} and removed_at is null`;
  if (!account) throw new CommandError('Choose one of your own linked accounts as the posting channel', 'FORBIDDEN');
  return account;
}

export function channelOf(account: Row): PublishChannel {
  return { platform: String(account.platform), handle: account.handle ? String(account.handle) : null, channel_url: String(account.canonical_url) };
}

/** Validates the proof fields of a PUBLISH delivery against the order's sold terms. */
export function checkPublicationProof(publish: PublishTerms, form: FormData, workStartAt: Date | null, dueAt: Date | null, now = new Date()) {
  const postValue = String(form.get('post_url') ?? '').trim();
  if (!postValue) throw new CommandError('A PUBLISH delivery needs the link to the published post');
  const link = checkPostLink(publish, postValue);
  const publishedValue = String(form.get('published_at') ?? '').trim();
  if (!publishedValue) throw new CommandError('Enter when the post went live');
  // A wall clock the creator typed is read in the zone their browser reported; a value that already names its own
  // offset (or ends in Z) is taken as written.
  const stamped = /[zZ]|[+-]\d\d:?\d\d$/.test(publishedValue);
  const offsetMinutes = stamped ? null : zoneOffset(form, 'published_at_offset');
  const publishedAt = stamped ? new Date(publishedValue) : instant(publishedValue, 'published_at', offsetMinutes);
  if (Number.isNaN(publishedAt.getTime())) throw new CommandError('The publication time is not a valid date');
  if (publishedAt.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) throw new CommandError('The publication time cannot be in the future');
  if (workStartAt && publishedAt.getTime() < workStartAt.getTime() - FUTURE_TOLERANCE_MS) {
    throw new CommandError('The post went live before this order started; publish a new post for this order', 'DOMAIN_RULE');
  }
  const attested = ['on', 'true'].includes(String(form.get('disclosure_attested') ?? ''));
  if (!attested) throw new CommandError(`Confirm the post shows the sponsorship disclosure "${publish.disclosure_text}"`, 'DOMAIN_RULE');
  return { ...link, publishedAt, late: dueAt ? publishedAt.getTime() > dueAt.getTime() : false };
}
