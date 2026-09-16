/**
 * MOCK view metrics for performance campaigns. Master §9.6 reads views from the creator's own connected account; no
 * such connection exists in this environment, so these numbers are generated deterministically from the account handle
 * and the post link. They are labelled `mock-metrics-v1` wherever they are stored, and nothing here is a real view
 * count from X or any other platform. A real adapter replaces `baselineFor` and `postViews`, keeping the same shape.
 */
import { createHash } from 'node:crypto';
import { DEFAULT_MEASURE_AFTER_DAYS, MIN_ELIGIBLE_POSTS } from './performance';

export const METRICS_SOURCE = 'mock-metrics-v1';
export const BASELINE_WINDOW_DAYS = 90;
/** How many recent posts the median is taken over (master §9.6 uses 20). */
export const BASELINE_SAMPLE_POSTS = 20;

/** A stable 0–1 number for a key, so the same account always gets the same fake history. */
function unitFor(key: string, salt: string): number {
  const digest = createHash('sha256').update(`${salt}:${key}`).digest();
  return digest.readUInt32BE(0) / 0xffffffff;
}

export type Baseline = {
  eligible_posts: number;
  median_views: bigint;
  window_days: number;
  measured_at_days: number;
  source: string;
  eligible: boolean;
};

/**
 * The creator's recent posting history, as this mock sees it: a handle with few posts stays ineligible, and a busy
 * handle gets a median in the low thousands. Eligibility mirrors master §9.6 (at least 10 qualifying posts).
 */
export function baselineFor(input: { handle: string | null; accountId: string }): Baseline {
  const key = (input.handle ?? input.accountId).toLowerCase();
  const posts = Math.round(4 + unitFor(key, 'posts') * 26); // 4–30 posts in the window
  const eligiblePosts = Math.min(posts, BASELINE_SAMPLE_POSTS);
  const median = BigInt(Math.round(400 + unitFor(key, 'median') * 11_600)); // 400–12,000 views
  return {
    eligible_posts: eligiblePosts,
    median_views: median,
    window_days: BASELINE_WINDOW_DAYS,
    measured_at_days: DEFAULT_MEASURE_AFTER_DAYS,
    source: METRICS_SOURCE,
    eligible: eligiblePosts >= MIN_ELIGIBLE_POSTS,
  };
}

export type PostMetrics = { views: bigint; signals: string[]; source: string };

/**
 * Views for one post at its checkpoint, plus the signals that must hold a bonus for review instead of paying it:
 * a count far above the creator's own median, or engagement that does not match the views (master §9.6).
 */
export function postViews(input: { postUrl: string; baselineMedian: bigint }): PostMetrics {
  const spread = unitFor(input.postUrl, 'views'); // 0–1
  const multiple = 0.2 + spread * 6; // 0.2× to 6.2× the creator's median
  const views = BigInt(Math.max(0, Math.round(Number(input.baselineMedian) * multiple)));
  const engagementRate = 0.002 + unitFor(input.postUrl, 'engagement') * 0.05;
  const signals: string[] = [];
  if (input.baselineMedian > 0n && views > input.baselineMedian * 20n) signals.push('VIEWS_FAR_ABOVE_MEDIAN');
  if (views > 2_000n && engagementRate < 0.004) signals.push('ENGAGEMENT_TOO_LOW_FOR_VIEWS');
  return { views, signals, source: METRICS_SOURCE };
}
