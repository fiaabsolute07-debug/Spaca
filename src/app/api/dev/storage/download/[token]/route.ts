import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { StorageTokenError, getLocalStorageProvider, localStorageEnabled } from '@/modules/storage/provider';
import { parseRange } from '@/modules/storage/range';

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
  // A video element asks for byte windows before it will play or seek, so the local emulation answers them the way a
  // provider would. Anything unsatisfiable is refused rather than answered with the whole file.
  const range = parseRange(request.headers.get('range'), info.size);
  if (range === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { 'content-range': `bytes */${info.size}` } });
  }
  const body = Readable.toWeb(provider.openObject(claims.bucket, claims.key, range ?? undefined)) as ReadableStream<Uint8Array>;
  return new Response(body, {
    status: range ? 206 : 200,
    headers: {
      'content-type': claims.type,
      'content-length': String(range ? range.end - range.start + 1 : info.size),
      ...(range ? { 'content-range': `bytes ${range.start}-${range.end}/${info.size}` } : {}),
      'accept-ranges': 'bytes',
      'content-disposition': contentDisposition(claims.name),
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'",
      'cache-control': 'private, no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}
