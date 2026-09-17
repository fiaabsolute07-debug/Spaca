/**
 * Supabase Storage adapter (STORAGE_PROVIDER=supabase), for deployments. Talks to the Storage REST API
 * (`<SUPABASE_URL>/storage/v1`) with the server secret key; the key never reaches a browser.
 *
 * Every bucket is private: pictures shown publicly still go through the app's own routes, which check visibility and
 * redirect to a short-lived signed URL, exactly as with the local adapter. Signed downloads are always attachments.
 * A signed upload URL cannot carry a size limit, so buckets are created with `file_size_limit` (see
 * `scripts/supabase-storage-setup.ts`) and finalize still compares the stored size with the declared one.
 */
import { createHash } from 'node:crypto';
import type { ObjectInfo, SignedUrl, StorageProvider } from './provider';
import type { StorageBucket } from './policy';

const BUCKETS = new Set<string>(['public-portfolio', 'private-briefs', 'private-deliverables', 'private-disputes', 'private-products', 'public-avatars', 'public-campaigns', 'public-items', 'private-quarantine']);
const KEY_PATTERN = /^[a-z]+\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.[a-z0-9]{2,5}$/;
const TIMEOUT_MS = 15_000;

/** Errors carry the operation and status only, never a URL, token or response body. */
export class SupabaseStorageError extends Error {
  constructor(operation: string, readonly status: number) {
    super(`Supabase Storage ${operation} failed (${status})`);
    this.name = 'SupabaseStorageError';
  }
}

type Config = { url: string; secretKey: string; fetch?: typeof fetch; now?: () => number };

export class SupabaseStorageProvider implements StorageProvider {
  readonly name = 'supabase';
  private readonly base: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly config: Config) {
    const url = new URL(config.url);
    if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Supabase URL must use https');
    if (config.secretKey.length < 20) throw new Error('Supabase server secret key is required for storage');
    this.base = `${url.origin}/storage/v1`;
    this.fetcher = config.fetch ?? fetch;
    this.now = config.now ?? Date.now;
  }

  /** `bucket/segments…`, refusing any bucket or key the app would not generate. */
  private static path(bucket: StorageBucket, key: string): string {
    if (!BUCKETS.has(bucket) || !KEY_PATTERN.test(key)) throw new Error('Invalid storage object');
    return `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  private request(path: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
    return this.fetcher(`${this.base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.config.secretKey}`, apikey: this.config.secretKey, ...init.headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  /** The API answers relative URLs (`/object/…?token=…`); absolute ones are kept only on the same origin. */
  private absolute(relative: string): string {
    const url = new URL(relative.startsWith('/object/') ? `${this.base}${relative}` : relative, this.base);
    if (url.origin !== new URL(this.base).origin) throw new SupabaseStorageError('sign', 502);
    return url.toString();
  }

  async createSignedUpload(bucket: StorageBucket, key: string, options: { maxBytes: number; contentType: string; ttlSeconds: number }): Promise<SignedUrl> {
    const response = await this.request(`/object/upload/sign/${SupabaseStorageProvider.path(bucket, key)}`, { method: 'POST', headers: { 'x-upsert': 'false' } });
    if (!response.ok) throw new SupabaseStorageError('upload signing', response.status);
    const { url } = (await response.json().catch(() => ({}))) as { url?: unknown };
    if (typeof url !== 'string' || !url.includes('token=')) throw new SupabaseStorageError('upload signing', 502);
    return {
      url: this.absolute(url), method: 'PUT',
      // Supabase keeps signed upload URLs for two hours; the app's own intent expiry is the shorter limit that counts.
      expiresAt: new Date(this.now() + Math.min(options.ttlSeconds, 7200) * 1000),
      headers: { 'content-type': options.contentType, 'x-upsert': 'false' },
    };
  }

  async createSignedDownload(bucket: StorageBucket, key: string, options: { filename: string; contentType: string; ttlSeconds: number }): Promise<SignedUrl> {
    const response = await this.request(`/object/sign/${SupabaseStorageProvider.path(bucket, key)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expiresIn: options.ttlSeconds }),
    });
    if (!response.ok) throw new SupabaseStorageError('download signing', response.status);
    const { signedURL } = (await response.json().catch(() => ({}))) as { signedURL?: unknown };
    if (typeof signedURL !== 'string' || !signedURL.includes('token=')) throw new SupabaseStorageError('download signing', 502);
    const url = new URL(this.absolute(signedURL));
    // Like the local adapter: always an attachment, with the original name.
    url.searchParams.set('download', options.filename);
    return { url: url.toString(), method: 'GET', expiresAt: new Date(this.now() + options.ttlSeconds * 1000), headers: {} };
  }

  async stat(bucket: StorageBucket, key: string): Promise<ObjectInfo | null> {
    const response = await this.request(`/object/authenticated/${SupabaseStorageProvider.path(bucket, key)}`, { method: 'HEAD' });
    if (response.status === 404 || response.status === 400) return null;
    if (!response.ok) throw new SupabaseStorageError('stat', response.status);
    const size = Number(response.headers.get('content-length'));
    if (!Number.isSafeInteger(size) || size < 0) throw new SupabaseStorageError('stat', 502);
    return { size };
  }

  async readHead(bucket: StorageBucket, key: string, bytes: number): Promise<Uint8Array> {
    const response = await this.request(`/object/authenticated/${SupabaseStorageProvider.path(bucket, key)}`, { headers: { range: `bytes=0-${Math.max(0, bytes - 1)}` } });
    if (!response.ok) throw new SupabaseStorageError('read', response.status);
    return new Uint8Array(await response.arrayBuffer()).slice(0, bytes);
  }

  async sha256(bucket: StorageBucket, key: string): Promise<string> {
    const response = await this.request(`/object/authenticated/${SupabaseStorageProvider.path(bucket, key)}`);
    if (!response.ok || !response.body) throw new SupabaseStorageError('read', response.status);
    const hash = createHash('sha256');
    const reader = response.body.getReader();
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) hash.update(chunk.value);
    return hash.digest('hex');
  }

  async move(from: StorageBucket, key: string, to: StorageBucket): Promise<void> {
    SupabaseStorageProvider.path(from, key);
    SupabaseStorageProvider.path(to, key);
    const response = await this.request('/object/move', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bucketId: from, sourceKey: key, destinationBucket: to, destinationKey: key }),
    });
    if (!response.ok) throw new SupabaseStorageError('move', response.status);
  }

  async remove(bucket: StorageBucket, key: string): Promise<void> {
    SupabaseStorageProvider.path(bucket, key);
    const response = await this.request(`/object/${encodeURIComponent(bucket)}`, {
      method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefixes: [key] }),
    });
    // Removing an object that is already gone is not an error.
    if (!response.ok && response.status !== 404) throw new SupabaseStorageError('remove', response.status);
  }
}
