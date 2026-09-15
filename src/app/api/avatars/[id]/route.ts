import { NextResponse } from 'next/server';
import { UUID_PATTERN } from '@/lib/commands';
import { sql } from '@/lib/db';
import { DOWNLOAD_URL_TTL_SECONDS, type StorageBucket } from '@/modules/storage/policy';
import { getStorageProvider } from '@/modules/storage/provider';

/**
 * GET → 302 to a short-lived signed URL for a profile photo that an ACTIVE user's profile currently shows.
 * Anything else (unknown id, replaced or removed photo, suspended user, quarantined file) is 404.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!UUID_PATTERN.test(id)) return new NextResponse(null, { status: 404 });
  const [asset] = await sql<{ bucket: string; object_key: string; filename: string; mime: string }[]>`select a.bucket,a.object_key,a.filename,a.mime
    from app.storage_assets a join app.profiles p on p.avatar_asset_id=a.id join app.users u on u.id=p.user_id
    where a.id=${id} and a.purpose='AVATAR' and a.lifecycle_state='READY' and u.status='ACTIVE'`;
  if (!asset) return new NextResponse(null, { status: 404 });
  const signed = await getStorageProvider().createSignedDownload(asset.bucket as StorageBucket, asset.object_key, {
    filename: asset.filename, contentType: asset.mime, ttlSeconds: DOWNLOAD_URL_TTL_SECONDS,
  });
  // Browsers may reuse the redirect for a few minutes, never beyond the signed URL's lifetime.
  return NextResponse.redirect(new URL(signed.url, _request.url), { status: 302, headers: { 'cache-control': `private, max-age=${DOWNLOAD_URL_TTL_SECONDS - 60}` } });
}
