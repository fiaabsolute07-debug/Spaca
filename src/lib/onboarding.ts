import type { AccountType } from './account';

/**
 * Onboarding (2026-09-16): right after sign-up a new account adds a photo, its name (the project for buyers, the
 * creator name for creators), one line on what it does and a short introduction. Until then the account can look
 * around, but what others would see waits: publishing a service, applying to a campaign, posting a campaign.
 * Shared by the server (command and gate) and the setup page, so nothing here touches the database.
 */
export const INTRO_MIN = 40;
export const INTRO_MAX = 2000;
export const HEADLINE_MAX = 120;
export const MAX_FOCUS = 3;
export const FOCUS_OPTIONS = ['DeFi', 'Infrastructure', 'Layer 2', 'AI', 'Gaming', 'NFTs', 'Memes', 'Trading', 'Education', 'Community'] as const;

const GATED = new Set(['publish_service', 'apply', 'create_request', 'create_item_listing']);

/** Whether a command puts the account in front of others and so waits for setup. */
export const needsOnboarding = (command: string) => GATED.has(command);

export const onboardingMessage = (type: AccountType) => type === 'creator'
  ? 'Finish setting up your profile first: add a photo, your creator name and a short introduction.'
  : 'Finish setting up your project first: add a logo, the project name and a short introduction.';

const safePath = (value: string | null | undefined) => (value && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/sign-') && value.length < 300 ? value : '/dashboard');

/** The setup page, carrying where the person was going. */
export function onboardingPath(returnTo?: string | null): string {
  const next = safePath(returnTo);
  return next === '/dashboard' || next.startsWith('/welcome') ? '/welcome' : `/welcome?return_to=${encodeURIComponent(next)}`;
}

export const nextPath = safePath;

/** "@name", "x.com/name" and "name.xyz" become full links; anything with a scheme is left for the URL check. */
export function normalizeLink(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  const handle = /^@([A-Za-z0-9_]{1,15})$/.exec(trimmed);
  if (handle) return `https://x.com/${handle[1]}`;
  return `https://${trimmed.replace(/^\/+/, '')}`;
}

/** A public handle made from a name: lowercase letters, numbers and dashes, 3–32 characters, or '' when nothing usable is left. */
export function handleFrom(name: string): string {
  const slug = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
  return slug.length >= 3 ? slug : '';
}
