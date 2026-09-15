/**
 * Flash notices travel in the redirect URL (`?message=` / `?error=`). Anyone can craft such a link, so a page shows a
 * notice only when the server signed it: a forged "Payment confirmed" link displays nothing (PAY-06, SEC-07).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type NoticeKind = 'message' | 'error';
export const NOTICE_SIGNATURE_PARAM = 'notice_sig';
const LOCAL_FALLBACK = 'local_dev_only_notice_signing_fixture';

function secret(): string {
  const value = process.env.NOTICE_SIGNING_SECRET;
  if (value && value.length >= 32) return value;
  if (process.env.NODE_ENV === 'production') throw new Error('NOTICE_SIGNING_SECRET (32+ characters) is required in production');
  return LOCAL_FALLBACK;
}

const sign = (kind: NoticeKind, text: string) => createHmac('sha256', secret()).update(`${kind}\n${text}`).digest('base64url').slice(0, 32);

/** `path` with the notice and its signature appended. */
export function withNotice(path: string, kind: NoticeKind, text: string): string {
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}${kind}=${encodeURIComponent(text)}&${NOTICE_SIGNATURE_PARAM}=${sign(kind, text)}`;
}

/** The notice text when the query carries a valid signature for it; otherwise null. */
export function verifiedNotice(query: Record<string, string | string[] | undefined>, kind: NoticeKind): string | null {
  const text = query[kind];
  const signature = query[NOTICE_SIGNATURE_PARAM];
  if (typeof text !== 'string' || !text || typeof signature !== 'string') return null;
  const expected = Buffer.from(sign(kind, text));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given) ? text : null;
}
