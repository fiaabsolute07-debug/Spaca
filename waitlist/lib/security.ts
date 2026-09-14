import { createHash, randomBytes } from 'node:crypto';

export const RATE_LIMIT = { max: 5, windowMinutes: 10 } as const;

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function newUpdateToken(): { token: string; hash: string } {
  const token = randomBytes(24).toString('base64url');
  return { token, hash: sha256(token) };
}

function ipSalt(): string {
  const salt = process.env.WAITLIST_IP_SALT;
  if (salt && salt.length >= 16) return salt;
  if (process.env.NODE_ENV === 'production') throw new Error('WAITLIST_IP_SALT (16+ chars) is required in production');
  return 'local_dev_only_waitlist_salt';
}

/** Salted hash of the client IP; the raw address is never stored. */
export function ipHashOf(request: Request): string | null {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || '';
  return ip ? sha256(`${ipSalt()}:${ip}`) : null;
}

/** Browser form posts must come from this site. */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
