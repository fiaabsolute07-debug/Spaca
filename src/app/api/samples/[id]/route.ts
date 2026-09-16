import { NextResponse } from 'next/server';
import { getActor } from '@/lib/auth';
import { hasAnyRole } from '@/modules/admin/policy';
import { UUID_PATTERN } from '@/lib/commands';
import { sql } from '@/lib/db';
import { DOWNLOAD_URL_TTL_SECONDS, type StorageBucket } from '@/modules/storage/policy';
import { getStorageProvider } from '@/modules/storage/provider';

/**
 * GET → 302 to a short-lived signed URL for the file behind a work sample, so a page can show the picture or play the
 * video instead of linking away from it. The rule is the one `readAsset` uses for SAMPLE files: the creator who owns
 * it, a moderator, or anyone at all once the sample is public and approved. Anything else is 404.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!UUID_PATTERN.test(id)) return new NextResponse(null, { status: 404 });
  const actor = await getActor();
  const [asset] = await sql<{ bucket: string; object_key: string; filename: string; mime: string; owner_id: string; visibility: string; moderation_status: string }[]>`
    select a.bucket,a.object_key,a.filename,a.mime,a.owner_id,s.visibility,s.moderation_status
    from app.storage_assets a join app.samples s on s.storage_asset_id=a.id
    where a.id=${id} and a.purpose='SAMPLE' and a.lifecycle_state='READY'`;
  if (!asset) return new NextResponse(null, { status: 404 });
  const owner = !!actor && actor.id === String(asset.owner_id);
  const moderator = !!actor && actor.status === 'ACTIVE' && hasAnyRole(actor, ['moderator', 'admin']);
  const published = asset.visibility === 'PUBLIC' && asset.moderation_status === 'APPROVED';
  if (!owner && !moderator && !published) return new NextResponse(null, { status: 404 });
  const signed = await getStorageProvider().createSignedDownload(asset.bucket as StorageBucket, asset.object_key, {
    filename: asset.filename, contentType: asset.mime, ttlSeconds: DOWNLOAD_URL_TTL_SECONDS,
  });
  return NextResponse.redirect(new URL(signed.url, request.url), { status: 302, headers: { 'cache-control': `private, max-age=${DOWNLOAD_URL_TTL_SECONDS - 60}` } });
}
