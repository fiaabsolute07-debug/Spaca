/**
 * StorageProvider contract (master §2: Supabase Storage behind an interface) and the local filesystem adapter.
 *
 * The local adapter emulates signed URLs with HMAC tokens served by `/api/dev/storage/*` (404 in production).
 * Signed URLs are bearer capabilities for their TTL; they are never logged. Uploads refuse to overwrite an
 * existing object, so a finalized object cannot be swapped with the same upload URL.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { StorageBucket } from './policy';

export type SignedUrl = { url: string; method: 'PUT' | 'GET'; expiresAt: Date; headers: Record<string, string> };
export type ObjectInfo = { size: number };

export interface StorageProvider {
  readonly name: string;
  createSignedUpload(bucket: StorageBucket, key: string, options: { maxBytes: number; contentType: string; ttlSeconds: number }): Promise<SignedUrl>;
  createSignedDownload(bucket: StorageBucket, key: string, options: { filename: string; contentType: string; ttlSeconds: number }): Promise<SignedUrl>;
  stat(bucket: StorageBucket, key: string): Promise<ObjectInfo | null>;
  readHead(bucket: StorageBucket, key: string, bytes: number): Promise<Uint8Array>;
  sha256(bucket: StorageBucket, key: string): Promise<string>;
  move(from: StorageBucket, key: string, to: StorageBucket): Promise<void>;
  remove(bucket: StorageBucket, key: string): Promise<void>;
}

export class StorageTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageTokenError';
  }
}

export type UploadClaims = { op: 'upload'; bucket: StorageBucket; key: string; exp: number; max: number; type: string };
export type DownloadClaims = { op: 'download'; bucket: StorageBucket; key: string; exp: number; name: string; type: string };
type Claims = UploadClaims | DownloadClaims;

const LOCAL_SIGNING_FALLBACK = 'local_dev_only_storage_signing_fixture';
const KEY_PATTERN = /^[a-z]+\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.[a-z0-9]{2,5}$/;
const BUCKETS = new Set<string>(['public-portfolio', 'private-briefs', 'private-deliverables', 'private-disputes', 'private-products', 'public-avatars', 'public-campaigns', 'private-quarantine']);

export function localStorageEnabled(): boolean {
  return process.env.NODE_ENV !== 'production' && (process.env.STORAGE_PROVIDER ?? 'local') === 'local';
}

export class LocalStorageProvider implements StorageProvider {
  readonly name = 'local-fs';
  private readonly root: string;
  private readonly secret: string;
  private readonly now: () => number;

  constructor(options: { root?: string; secret?: string; now?: () => number } = {}) {
    this.root = resolve(options.root ?? process.env.LOCAL_STORAGE_DIR ?? '.local/storage');
    const secret = options.secret ?? process.env.STORAGE_SIGNING_SECRET ?? (process.env.NODE_ENV === 'production' ? '' : LOCAL_SIGNING_FALLBACK);
    if (secret.length < 16) throw new Error('STORAGE_SIGNING_SECRET is required for the storage adapter');
    this.secret = secret;
    this.now = options.now ?? Date.now;
  }

  /** Resolves inside `root/bucket`; any key that is not server-shaped or escapes the bucket is refused. */
  pathFor(bucket: StorageBucket, key: string): string {
    if (!BUCKETS.has(bucket) || !KEY_PATTERN.test(key)) throw new StorageTokenError('Invalid object key');
    const bucketRoot = resolve(this.root, bucket);
    const path = resolve(bucketRoot, key);
    if (!path.startsWith(bucketRoot + sep)) throw new StorageTokenError('Invalid object key');
    return path;
  }

  private sign(claims: Claims): string {
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const mac = createHmac('sha256', this.secret).update(`v1.${payload}`).digest('base64url');
    return `v1.${payload}.${mac}`;
  }

  verify<T extends Claims['op']>(token: string, op: T): Extract<Claims, { op: T }> {
    const [version, payload, mac] = token.split('.');
    if (version !== 'v1' || !payload || !mac) throw new StorageTokenError('Malformed storage token');
    const expected = createHmac('sha256', this.secret).update(`v1.${payload}`).digest();
    const given = Buffer.from(mac, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new StorageTokenError('Invalid storage token');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Claims;
    if (claims.op !== op) throw new StorageTokenError('Wrong storage token scope');
    if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= this.now()) throw new StorageTokenError('Storage token expired');
    this.pathFor(claims.bucket, claims.key);
    return claims as Extract<Claims, { op: T }>;
  }

  async createSignedUpload(bucket: StorageBucket, key: string, options: { maxBytes: number; contentType: string; ttlSeconds: number }): Promise<SignedUrl> {
    this.pathFor(bucket, key);
    const exp = Math.floor(this.now() / 1000) + options.ttlSeconds;
    const token = this.sign({ op: 'upload', bucket, key, exp, max: options.maxBytes, type: options.contentType });
    return { url: `/api/dev/storage/upload/${token}`, method: 'PUT', expiresAt: new Date(exp * 1000), headers: { 'content-type': options.contentType } };
  }

  async createSignedDownload(bucket: StorageBucket, key: string, options: { filename: string; contentType: string; ttlSeconds: number }): Promise<SignedUrl> {
    if (bucket === 'private-quarantine') throw new StorageTokenError('Quarantined objects have no download URL');
    this.pathFor(bucket, key);
    const exp = Math.floor(this.now() / 1000) + options.ttlSeconds;
    const token = this.sign({ op: 'download', bucket, key, exp, name: options.filename, type: options.contentType });
    return { url: `/api/dev/storage/download/${token}`, method: 'GET', expiresAt: new Date(exp * 1000), headers: {} };
  }

  /** Streams at most `maxBytes`; refuses to overwrite. Returns bytes written or null when the limit was exceeded. */
  async writeObject(bucket: StorageBucket, key: string, body: ReadableStream<Uint8Array>, maxBytes: number): Promise<number | null> {
    const path = this.pathFor(bucket, key);
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, 'wx', 0o600);
    let written = 0;
    let exceeded = false;
    try {
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        written += value.byteLength;
        if (written > maxBytes) {
          exceeded = true;
          await reader.cancel();
          break;
        }
        await handle.write(value);
      }
    } finally {
      await handle.close();
    }
    if (exceeded || written === 0) {
      await rm(path, { force: true });
      return exceeded ? null : 0;
    }
    return written;
  }

  /** `range` is the inclusive byte window a media player asked for; without it the whole object is read. */
  openObject(bucket: StorageBucket, key: string, range?: { start: number; end: number }) {
    return createReadStream(this.pathFor(bucket, key), range);
  }

  async stat(bucket: StorageBucket, key: string): Promise<ObjectInfo | null> {
    try {
      const info = await stat(this.pathFor(bucket, key));
      return info.isFile() ? { size: info.size } : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async readHead(bucket: StorageBucket, key: string, bytes: number): Promise<Uint8Array> {
    const handle = await open(this.pathFor(bucket, key), 'r');
    try {
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
      return new Uint8Array(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  }

  async sha256(bucket: StorageBucket, key: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of this.openObject(bucket, key)) hash.update(chunk as Buffer);
    return hash.digest('hex');
  }

  async move(from: StorageBucket, key: string, to: StorageBucket): Promise<void> {
    const target = this.pathFor(to, key);
    await mkdir(dirname(target), { recursive: true });
    await rename(this.pathFor(from, key), target);
  }

  async remove(bucket: StorageBucket, key: string): Promise<void> {
    await rm(this.pathFor(bucket, key), { force: true });
  }
}

let override: StorageProvider | undefined;
let local: LocalStorageProvider | undefined;

export function getStorageProvider(): StorageProvider {
  if (override) return override;
  if (!localStorageEnabled()) throw new Error('No storage provider is configured for this environment');
  return (local ??= new LocalStorageProvider());
}

export function getLocalStorageProvider(): LocalStorageProvider | null {
  const provider = override ?? (localStorageEnabled() ? getStorageProvider() : undefined);
  return provider instanceof LocalStorageProvider ? provider : null;
}

export function setStorageProviderForTests(provider: StorageProvider | undefined) {
  override = provider;
}
