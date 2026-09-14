/** Pure input rules for the waitlist; shared by the API route and unit tests. */
export type Role = 'project' | 'creator';

export type SignupInput = { email: string; role: Role; consent: true; honeypot: boolean; source: Record<string, string> };
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SOURCE_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'ref', 'referrer'] as const;

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length >= 3 && email.length <= 254 && EMAIL.test(email) ? email : null;
}

export function parseRole(value: unknown): Role | null {
  return value === 'project' || value === 'creator' ? value : null;
}

/** Accepts `name`, `@name` or an x.com / twitter.com profile URL; returns the bare handle. */
export function normalizeXHandle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let handle = value.trim();
  const url = handle.match(/^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/([^/?#]+)/i);
  if (url) handle = url[1]!;
  handle = handle.replace(/^@/, '');
  return /^[A-Za-z0-9_]{1,15}$/.test(handle) ? handle : null;
}

/** Keeps a few short, printable attribution strings and drops everything else. */
export function sanitizeSource(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== 'object') return out;
  for (const key of SOURCE_KEYS) {
    const raw = (value as Record<string, unknown>)[key];
    if (typeof raw !== 'string') continue;
    const printable = Array.from(raw).filter((char) => char.charCodeAt(0) >= 32).join('');
    const cleaned = printable.trim().slice(0, key === 'referrer' ? 200 : 80);
    if (cleaned) out[key] = cleaned;
  }
  return out;
}

export function parseSignup(body: unknown): Result<SignupInput> {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Invalid request.' };
  const data = body as Record<string, unknown>;
  const email = normalizeEmail(data.email);
  if (!email) return { ok: false, error: 'Enter a valid email address.' };
  const role = parseRole(data.role);
  if (!role) return { ok: false, error: 'Choose whether you are launching a project or a creator.' };
  if (data.consent !== true) return { ok: false, error: 'Please agree to receive updates so we can contact you.' };
  const honeypot = typeof data.website === 'string' && data.website.trim() !== '';
  return { ok: true, value: { email, role, consent: true, honeypot, source: sanitizeSource(data.source) } };
}
