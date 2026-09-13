import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { StorageTokenError, getLocalStorageProvider, localStorageEnabled } from '@/modules/storage/provider';

const contentDisposition = (filename: string) =>
  `attachment; filename="${filename.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`;

/**
 * Local emulation of a provider signed-download URL: always an attachment, never sniffed or rendered inline.
 * 404 in production or when a real storage provider is set.
 */
export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  if (process.env.NODE_ENV === 'production' || !localStorageEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const provider = getLocalStorageProvider();
  if (!provider) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const { token } = await context.params;
  let claims;
  try {
    claims = provider.verify(token, 'download');
  } catch (error) {
    if (error instanceof StorageTokenError) return NextResponse.json({ error: 'Download link is invalid or expired' }, { status: 403 });
    throw error;
  }
  if (claims.bucket === 'private-quarantine') return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const info = await provider.stat(claims.bucket, claims.key);
  if (!info) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const body = Readable.toWeb(provider.openObject(claims.bucket, claims.key)) as ReadableStream<Uint8Array>;
  return new Response(body, {
    headers: {
      'content-type': claims.type,
      'content-length': String(info.size),
      'content-disposition': contentDisposition(claims.name),
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'",
      'cache-control': 'private, no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}
