/**
 * Marketplace content policy (master §1.2.1 web3 rules, §23 trust/safety, MOD-01). A brief or request that asks for
 * undisclosed promotion, fake engagement, guaranteed returns or a deceptive verbatim script is refused with the
 * rule it breaks. This is a narrow explicit-phrase screen, not a classifier: anything subtler goes to the report
 * queue, where a moderator decides with a written reason.
 */
import { CommandError } from '@/lib/commands';

export type PolicyReason = 'UNDISCLOSED_PROMOTION' | 'FAKE_ENGAGEMENT' | 'GUARANTEED_RETURNS' | 'DECEPTIVE_SCRIPT';

const RULES: { reason: PolicyReason; message: string; patterns: RegExp[] }[] = [
  {
    reason: 'UNDISCLOSED_PROMOTION',
    message: 'Sponsored posts must be disclosed. Remove the request to hide that the post is paid.',
    patterns: [
      /\b(?:don'?t|do not|never|without|no need to)\s+(?:mention|disclose|say|tag|label|add)\b[^.\n]{0,40}\b(?:sponsor(?:ed|ship)?|paid|#?ad\b|advert(?:isement|ising)?|partnership|disclosure)/i,
      /\b(?:look|seem|appear|pretend)\w*\s+(?:(?:like|to be|as if it(?:'s| is)|it(?:'s| is))\s+)?(?:\w+\s+){0,2}organic\b/i,
      /\bno\s+(?:#ad|disclosure|sponsor(?:ed)?\s+(?:tag|label))\b/i,
    ],
  },
  {
    reason: 'FAKE_ENGAGEMENT',
    message: 'Buying or faking likes, reposts, followers or views is not allowed.',
    patterns: [
      /\b(?:buy|bought|fake|botted|bot|purchased?|paid)\s+(?:likes|followers|retweets|reposts|views|comments|engagement|impressions)\b/i,
      /\bengagement\s+(?:pods?|farms?|groups?)\b/i,
      /\b(?:like|follow|retweet|repost)[- ]for[- ](?:like|follow|retweet|repost)\b/i,
    ],
  },
  {
    reason: 'GUARANTEED_RETURNS',
    message: 'Posts cannot promise returns, profits or price targets.',
    patterns: [
      /\bguarantee[sd]?\s+(?:\w+\s+){0,2}(?:returns?|profits?|gains?|pumps?|moon|100x|\d+x)\b/i,
      /\brisk[- ]free\s+(?:returns?|profits?|gains?|investment)\b/i,
      /\b(?:can'?t|cannot|won'?t)\s+lose\b/i,
      /\b\d{2,}x\s+(?:guaranteed|for sure|minimum)\b/i,
    ],
  },
  {
    reason: 'DECEPTIVE_SCRIPT',
    message: 'Creators write original content in their own voice. Share key points instead of a script to post verbatim.',
    patterns: [
      /\b(?:post|copy|publish|tweet)\s+(?:this|it|the (?:text|script|thread))\s+(?:word[- ]for[- ]word|verbatim|exactly as (?:written|provided|is))\b/i,
      /\bpass (?:it|this) off as (?:your|their) own\b/i,
    ],
  },
];

export function screenContent(...texts: string[]): { reason: PolicyReason; message: string }[] {
  const joined = texts.join('\n');
  return RULES.filter((rule) => rule.patterns.some((pattern) => pattern.test(joined))).map(({ reason, message }) => ({ reason, message }));
}

/** Refuses content that breaks an explicit rule; the caller's transaction stores nothing. */
export function assertContentPolicy(...texts: string[]): void {
  const violations = screenContent(...texts);
  if (violations.length) throw new CommandError(`This brief breaks the marketplace content policy: ${violations.map((v) => v.message).join(' ')}`, 'DOMAIN_RULE');
}
