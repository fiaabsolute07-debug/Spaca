import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOTICE_SIGNATURE_PARAM, verifiedNotice, withNotice } from '@/lib/notices';

const queryOf = (path: string) => Object.fromEntries(new URL(path, 'http://local.test').searchParams.entries());

afterEach(() => vi.unstubAllEnvs());

describe('signed flash notices (PAY-06 / SEC-07)', () => {
  it('shows a notice only with the server signature for that exact text and kind', () => {
    const path = withNotice('/orders/1?tab=files', 'message', 'Payment confirmed by the provider.');
    const query = queryOf(path);
    expect(query.tab).toBe('files');
    expect(verifiedNotice(query, 'message')).toBe('Payment confirmed by the provider.');
    expect(verifiedNotice(query, 'error')).toBeNull();

    expect(verifiedNotice({ message: 'Payment confirmed by the provider.' }, 'message')).toBeNull();
    expect(verifiedNotice({ ...query, message: 'Payment confirmed. Send your seed phrase to support.' }, 'message')).toBeNull();
    expect(verifiedNotice({ ...query, [NOTICE_SIGNATURE_PARAM]: 'x'.repeat(32) }, 'message')).toBeNull();
    expect(verifiedNotice({ error: query.message, [NOTICE_SIGNATURE_PARAM]: query[NOTICE_SIGNATURE_PARAM] }, 'error')).toBeNull();
  });

  it('needs a real secret in production and signs with it', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => withNotice('/x', 'message', 'hi')).toThrow(/NOTICE_SIGNING_SECRET/);
    vi.stubEnv('NOTICE_SIGNING_SECRET', 'a'.repeat(40));
    const signed = queryOf(withNotice('/x', 'message', 'hi'));
    expect(verifiedNotice(signed, 'message')).toBe('hi');
    vi.stubEnv('NOTICE_SIGNING_SECRET', 'b'.repeat(40));
    expect(verifiedNotice(signed, 'message')).toBeNull();
  });
});
