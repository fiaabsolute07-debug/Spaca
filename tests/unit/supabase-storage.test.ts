import { describe, expect, it, vi } from 'vitest';
import { SupabaseStorageError, SupabaseStorageProvider } from '@/modules/storage/supabase';

const KEY = 'avatar/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.png';
const SECRET = 'fixture-not-a-real-server-key';
const NOW = Date.parse('2026-09-17T10:00:00Z');

type Call = { url: string; init: RequestInit & { headers?: Record<string, string> } };
function stub(handler: (url: string, init: Call['init']) => Response) {
  const calls: Call[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init: Call['init'] = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as unknown as typeof fetch;
  return { calls, provider: new SupabaseStorageProvider({ url: 'https://abcd.supabase.co', secretKey: SECRET, fetch: fetcher, now: () => NOW }) };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('storage provider selection', () => {
  it('uses Supabase Storage when STORAGE_PROVIDER=supabase, and refuses to start without its URL and key', async () => {
    const { getStorageProvider, setStorageProviderForTests } = await import('@/modules/storage/provider');
    setStorageProviderForTests(undefined);
    try {
      vi.stubEnv('STORAGE_PROVIDER', 'supabase');
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
      vi.stubEnv('SUPABASE_SERVER_SECRET_KEY', '');
      expect(() => getStorageProvider()).toThrow('Supabase Storage is not configured for this environment');
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://abcd.supabase.co');
      vi.stubEnv('SUPABASE_SERVER_SECRET_KEY', SECRET);
      expect(getStorageProvider()).toBeInstanceOf(SupabaseStorageProvider);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('SupabaseStorageProvider (Storage REST API, fetch stubbed)', () => {
  it('signs an upload without upsert, and hands the browser the full URL and the headers to send', async () => {
    const { calls, provider } = stub(() => json({ url: `/object/upload/sign/public-avatars/${KEY}?token=upload-token` }));
    const signed = await provider.createSignedUpload('public-avatars', KEY, { maxBytes: 1000, contentType: 'image/png', ttlSeconds: 900 });
    expect(calls[0]!.url).toBe(`https://abcd.supabase.co/storage/v1/object/upload/sign/public-avatars/${KEY}`);
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.headers).toMatchObject({ authorization: `Bearer ${SECRET}`, apikey: SECRET, 'x-upsert': 'false' });
    expect(signed).toEqual({
      url: `https://abcd.supabase.co/storage/v1/object/upload/sign/public-avatars/${KEY}?token=upload-token`,
      method: 'PUT', expiresAt: new Date(NOW + 900_000), headers: { 'content-type': 'image/png', 'x-upsert': 'false' },
    });
    // The secret key is for the server's own request only.
    expect(JSON.stringify(signed)).not.toContain(SECRET);
  });

  it('signs a download for its lifetime as an attachment with the original name', async () => {
    const { calls, provider } = stub(() => json({ signedURL: `/object/sign/private-products/${KEY}?token=download-token` }));
    const signed = await provider.createSignedDownload('private-products', KEY, { filename: 'launch kit.zip', contentType: 'application/zip', ttlSeconds: 300 });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ expiresIn: 300 });
    const url = new URL(signed.url);
    expect(url.origin + url.pathname).toBe(`https://abcd.supabase.co/storage/v1/object/sign/private-products/${KEY}`);
    expect(url.searchParams.get('token')).toBe('download-token');
    expect(url.searchParams.get('download')).toBe('launch kit.zip');
    expect(signed.expiresAt).toEqual(new Date(NOW + 300_000));
  });

  it('refuses a signed URL on another origin, keys the app would not make, and plain http', async () => {
    const { provider } = stub(() => json({ signedURL: 'https://evil.example/object/sign/x?token=t' }));
    await expect(provider.createSignedDownload('public-avatars', KEY, { filename: 'a.png', contentType: 'image/png', ttlSeconds: 60 })).rejects.toThrow(SupabaseStorageError);
    await expect(provider.stat('public-avatars', '../private-products/secret.zip')).rejects.toThrow('Invalid storage object');
    await expect(provider.stat('not-a-bucket' as never, KEY)).rejects.toThrow('Invalid storage object');
    expect(() => new SupabaseStorageProvider({ url: 'http://abcd.supabase.co', secretKey: SECRET })).toThrow(/https/);
    expect(() => new SupabaseStorageProvider({ url: 'https://abcd.supabase.co', secretKey: '' })).toThrow(/secret key/);
  });

  it('reads size, the first bytes and the hash, and treats a missing object as absent', async () => {
    const body = new TextEncoder().encode('\x89PNG\r\n\x1a\nrest of the file');
    const { calls, provider } = stub((url, init) => {
      if (url.includes('33333333-3333')) return new Response(null, { status: 400 });
      if (init.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': String(body.byteLength) } });
      if (init.headers?.range) return new Response(body.slice(0, 8), { status: 206 });
      return new Response(body, { status: 200 });
    });
    expect(await provider.stat('public-avatars', KEY)).toEqual({ size: body.byteLength });
    expect(await provider.stat('public-avatars', 'avatar/11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333.png')).toBeNull();
    const head = await provider.readHead('public-avatars', KEY, 8);
    expect(Array.from(head)).toEqual(Array.from(body.slice(0, 8)));
    expect(calls.find((call) => call.init.headers?.range)!.init.headers!.range).toBe('bytes=0-7');
    expect(await provider.sha256('public-avatars', KEY)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('moves across buckets, removes idempotently, and reports failures without URLs or bodies', async () => {
    const { calls, provider } = stub((url, init) => {
      if (url.endsWith('/object/move')) return json({ message: 'Successfully moved' });
      if (init.method === 'DELETE') return new Response('{"error":"not found, token=abc"}', { status: 404 });
      return new Response('{"error":"internal"}', { status: 500 });
    });
    await provider.move('private-deliverables', KEY, 'private-quarantine');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ bucketId: 'private-deliverables', sourceKey: KEY, destinationBucket: 'private-quarantine', destinationKey: KEY });
    await provider.remove('private-quarantine', KEY);
    expect(calls[1]!.url).toBe('https://abcd.supabase.co/storage/v1/object/private-quarantine');
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ prefixes: [KEY] });
    const failure = await provider.readHead('public-avatars', KEY, 8).catch((error) => error);
    expect(failure).toBeInstanceOf(SupabaseStorageError);
    expect(failure.message).toBe('Supabase Storage read failed (500)');
  });
});
