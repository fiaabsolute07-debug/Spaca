import { NextResponse } from 'next/server';
import { getActor } from '@/lib/auth';
import { UUID_PATTERN } from '@/lib/commands';
import { sql } from '@/lib/db';
import { DOWNLOAD_URL_TTL_SECONDS, type StorageBucket } from '@/modules/storage/policy';
import { getStorageProvider } from '@/modules/storage/provider';

/**
 * GET → 302 to a short-lived signed URL for a campaign image, or its small card copy, that a visible campaign currently
 * shows (the same visibility as the campaign page: OPEN, FILLED or CLOSED, or any status for its own buyer). A copy is
 * never served once its original is quarantined. Anything else is 404.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!UUID_PATTERN.test(id)) return new NextResponse(null, { status: 404 });
  const actor = await getActor();
  const [asset] = await sql<{ bucket: string; object_key: string; filename: string; mime: string }[]>`select a.bucket,a.object_key,a.filename,a.mime
    from app.storage_assets a join app.request_images i on (i.asset_id=a.id or i.thumb_asset_id=a.id)
      join app.storage_assets original on original.id=i.asset_id join app.requests r on r.id=i.request_id
    where a.id=${id} and a.purpose='REQUEST_IMAGE' and a.lifecycle_state='READY' and original.lifecycle_state='READY'
      and (r.status in ('OPEN','FILLED','CLOSED') or r.buyer_id=${actor?.id ?? null}) limit 1`;
  if (!asset) return new NextResponse(null, { status: 404 });
  const signed = await getStorageProvider().createSignedDownload(asset.bucket as StorageBucket, asset.object_key, {
    filename: asset.filename, contentType: asset.mime, ttlSeconds: DOWNLOAD_URL_TTL_SECONDS,
  });
  return NextResponse.redirect(new URL(signed.url, request.url), { status: 302, headers: { 'cache-control': `private, max-age=${DOWNLOAD_URL_TTL_SECONDS - 60}` } });
}
