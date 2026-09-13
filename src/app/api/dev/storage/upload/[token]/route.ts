import { NextResponse } from 'next/server';
import { StorageTokenError, getLocalStorageProvider, localStorageEnabled } from '@/modules/storage/provider';

/**
 * Local emulation of a provider signed-upload URL. The HMAC token is the capability (bucket, key, byte limit,
 * content type, expiry); objects are write-once. 404 in production or when a real storage provider is set.
 */
export async function PUT(request: Request, context: { params: Promise<{ token: string }> }) {
  if (process.env.NODE_ENV === 'production' || !localStorageEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const provider = getLocalStorageProvider();
  if (!provider) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const { token } = await context.params;
  let claims;
  try {
    claims = provider.verify(token, 'upload');
  } catch (error) {
    if (error instanceof StorageTokenError) return NextResponse.json({ error: 'Upload URL is invalid or expired' }, { status: 403 });
    throw error;
  }
  if ((request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase() !== claims.type) {
    return NextResponse.json({ error: 'Content-Type does not match the upload' }, { status: 400 });
  }
  const declaredLength = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declaredLength) && declaredLength > claims.max) return NextResponse.json({ error: 'File is larger than declared' }, { status: 413 });
  if (!request.body) return NextResponse.json({ error: 'Empty upload' }, { status: 400 });
  try {
    const written = await provider.writeObject(claims.bucket, claims.key, request.body, claims.max);
    if (written === null) return NextResponse.json({ error: 'File is larger than declared' }, { status: 413 });
    if (written === 0) return NextResponse.json({ error: 'Empty upload' }, { status: 400 });
    return NextResponse.json({ ok: true, size: written });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return NextResponse.json({ error: 'This upload URL was already used' }, { status: 409 });
    throw error;
  }
}
