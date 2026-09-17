/**
 * A creator's connected X account as spaca shows it (src/modules/x). Shared by server pages and client components, so
 * nothing here reads the database or the environment.
 */
export type XSource = 'MOCK' | 'X_API';

export type XProfileView = {
  source: XSource;
  username: string;
  name: string;
  imageUrl: string | null;
  description: string;
  location: string;
  verified: boolean;
  verifiedType: string | null;
  followers: number;
  following: number;
  posts: number;
  joinedAt: string | null;
  fetchedAt: string;
  /** X no longer returns this account (deleted, suspended or private since it was connected). */
  unavailable: boolean;
  /** The copy is older than the refresh age: viewing it should ask for a background refresh. */
  refreshDue: boolean;
};

const COMPACT = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

/** 950 → "950", 12,431 → "12.4K", 1,250,000 → "1.3M". */
export const compactCount = (value: number) => COMPACT.format(value);

export const xProfileUrl = (username: string) => `https://x.com/${username}`;

const DAY = 24 * 3600 * 1000;

/** "updated today", "updated 3 days ago", "updated 2 months ago". */
export function updatedAgo(iso: string, now = Date.now()): string {
  const days = Math.max(0, Math.floor((now - new Date(iso).getTime()) / DAY));
  if (days === 0) return 'updated today';
  if (days === 1) return 'updated yesterday';
  if (days < 30) return `updated ${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? 'updated a month ago' : `updated ${months} months ago`;
}

/** "Mar 2019". */
export const joinedLabel = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
