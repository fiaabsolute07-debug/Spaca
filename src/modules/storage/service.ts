/**
 * Asset lifecycle (master §4.4): upload intent → direct upload with a short-lived signed URL → server finalize
 * (size, signature, hash) → attach to the right owner/order → authorization-checked signed download.
 *
 * Provider IO (stat, read, hash, move, remove) runs outside database transactions. Objects cannot be
 * overwritten after upload, so the verified hash stays true while the row is committed.
 */
import { randomUUID } from 'node:crypto';
import type { Actor } from '@/lib/auth';
import { CommandError, UUID_PATTERN, type Row, type Tx } from '@/lib/commands';
import { sql } from '@/lib/db';
import { audit, hasAnyRole } from '@/modules/admin/policy';
import {
  DOWNLOAD_URL_TTL_SECONDS,
  FINALIZE_GRACE_SECONDS,
  MAX_ASSETS_PER_DELIVERY,
  MAX_OPEN_INTENTS_PER_HOUR,
  QUARANTINE_BUCKET,
  SCAN_ENGINE,
  UPLOAD_URL_TTL_SECONDS,
  UploadPolicyError,
  objectKeyFor,
  validateDeclaredUpload,
  verifySignature,
  type AssetPurpose,
  type StorageBucket,
} from './policy';
import { getStorageProvider } from './provider';

const ORDER_UPLOAD_STATES: Readonly<Record<Exclude<AssetPurpose, 'SAMPLE' | 'DIGITAL' | 'AVATAR' | 'REQUEST_IMAGE' | 'ITEM_IMAGE'>, readonly string[]>> = {
  DELIVERY: ['IN_PROGRESS', 'REVISION_REQUESTED'],
  BRIEF: ['AWAITING_PAYMENT', 'FUNDED'],
  DISPUTE: ['IN_PROGRESS', 'DELIVERED', 'REVISION_REQUESTED', 'DISPUTED'],
};

const notFound = () => new CommandError('File not found or not available to this account', 'NOT_FOUND');

async function assertOrderUpload(tx: Tx, actor: Actor, purpose: AssetPurpose, orderId: string | null) {
  if (purpose === 'AVATAR') {
    // Any active account (buyer or creator) may upload its own profile photo.
    if (orderId) throw new CommandError('Profile photos are not tied to an order');
    if (actor.status !== 'ACTIVE') throw new CommandError('Suspended accounts cannot change their photo', 'ACCOUNT_SUSPENDED');
    return;
  }
  if (purpose === 'REQUEST_IMAGE') {
    if (orderId) throw new CommandError('Campaign images are not tied to an order');
    if (actor.status !== 'ACTIVE') throw new CommandError('Suspended accounts cannot add campaign images', 'ACCOUNT_SUSPENDED');
    if (!actor.roles.includes('buyer')) throw new CommandError('Only buyer accounts add campaign images', 'FORBIDDEN');
    return;
  }
  if (purpose === 'ITEM_IMAGE') {
    // Anyone who can list an item (buyer or creator account) may upload its pictures.
    if (orderId) throw new CommandError('Item pictures are not tied to an order');
    if (actor.status !== 'ACTIVE') throw new CommandError('Suspended accounts cannot add item pictures', 'ACCOUNT_SUSPENDED');
    if (!['buyer', 'creator'].some((role) => actor.roles.includes(role))) throw new CommandError('Only marketplace accounts list items', 'FORBIDDEN');
    return;
  }
  if (purpose === 'SAMPLE' || purpose === 'DIGITAL') {
    const what = purpose === 'SAMPLE' ? 'portfolio samples' : 'product files';
    if (orderId) throw new CommandError(`${purpose === 'SAMPLE' ? 'Portfolio samples' : 'Product files'} are not tied to an order`);
    if (actor.status !== 'ACTIVE') throw new CommandError(`Suspended accounts cannot add ${what}`, 'ACCOUNT_SUSPENDED');
    if (!actor.roles.includes('creator')) throw new CommandError(`Only creators can upload ${what}`, 'FORBIDDEN');
    return;
  }
  if (!orderId || !UUID_PATTERN.test(orderId)) throw new CommandError('order_id is required for this upload');
  const [order] = await tx<Row[]>`select id,status,buyer_id,creator_id from app.orders where id=${orderId} and (buyer_id=${actor.id} or creator_id=${actor.id}) for share`;
  if (!order) throw new CommandError('Order not found or not visible to this account', 'NOT_FOUND');
  if (purpose === 'DELIVERY' && String(order.creator_id) !== actor.id) throw new CommandError('Only the creator uploads delivery files', 'FORBIDDEN');
  if (purpose === 'BRIEF' && String(order.buyer_id) !== actor.id) throw new CommandError('Only the buyer uploads brief files', 'FORBIDDEN');
  if (!ORDER_UPLOAD_STATES[purpose].includes(String(order.status))) throw new CommandError('This order is not accepting these files now', 'ORDER_STATE_CONFLICT');
}

export type UploadIntentInput = { purpose: string; filename: string; mime: string; size: number; orderId?: string | null };

export async function createUploadIntent(actor: Actor, input: UploadIntentInput) {
  let declared;
  try {
    declared = validateDeclaredUpload(input);
  } catch (error) {
    if (error instanceof UploadPolicyError) throw new CommandError(error.message, 'UNSUPPORTED_ASSET');
    throw error;
  }
  const orderId = input.orderId?.trim() || null;
  const id = randomUUID();
  const key = objectKeyFor(declared.purpose, actor.id, id, declared.extension);
  await sql.begin(async (tx) => {
    await assertOrderUpload(tx, actor, declared.purpose, orderId);
    await tx`select pg_advisory_xact_lock(hashtextextended(${`upload-quota:${actor.id}`}, 0))`;
    const [{ recent }] = await tx<{ recent: number }[]>`select count(*)::int as recent from app.upload_intents where owner_id=${actor.id} and created_at > now() - interval '1 hour'`;
    if (recent >= MAX_OPEN_INTENTS_PER_HOUR) throw new CommandError('Too many uploads started in the last hour. Try again later.', 'RATE_LIMITED');
    await tx`insert into app.upload_intents (id,owner_id,purpose,order_id,bucket,object_key,filename,declared_mime,declared_size,expires_at)
      values (${id},${actor.id},${declared.purpose},${orderId},${declared.bucket},${key},${declared.filename},${declared.mime},${declared.size},
        now() + (${UPLOAD_URL_TTL_SECONDS} * interval '1 second'))`;
  });
  const upload = await getStorageProvider().createSignedUpload(declared.bucket, key, { maxBytes: declared.size, contentType: declared.mime, ttlSeconds: UPLOAD_URL_TTL_SECONDS });
  return { id, filename: declared.filename, max_bytes: declared.size, upload: { url: upload.url, method: upload.method, headers: upload.headers, expires_at: upload.expiresAt.toISOString() } };
}

export type FinalizeResult = { id: string; state: 'READY' | 'QUARANTINED' | 'REJECTED'; detail?: string };

function resultFromIntent(intent: Row): FinalizeResult {
  if (intent.outcome === 'FINALIZED') return { id: String(intent.id), state: 'READY' };
  if (intent.outcome === 'QUARANTINED') return { id: String(intent.id), state: 'QUARANTINED', detail: 'The file did not match its declared type and is held for review' };
  if (intent.outcome === 'REJECTED') return { id: String(intent.id), state: 'REJECTED', detail: String(intent.outcome_detail ?? 'Upload rejected') };
  throw new CommandError('This upload expired. Start a new upload.', 'ORDER_STATE_CONFLICT');
}

const withinFinalizeWindow = (intent: Row) => new Date(String(intent.expires_at)).getTime() + FINALIZE_GRACE_SECONDS * 1000 > Date.now();

/** Idempotent: finalizing a closed intent returns its recorded outcome. */
export async function finalizeUpload(actor: Actor, intentId: string): Promise<FinalizeResult> {
  if (!UUID_PATTERN.test(intentId)) throw notFound();
  const [intent] = await sql<Row[]>`select * from app.upload_intents where id=${intentId} and owner_id=${actor.id}`;
  if (!intent) throw notFound();
  if (intent.closed_at) return resultFromIntent(intent);
  if (!withinFinalizeWindow(intent)) throw new CommandError('This upload expired. Start a new upload.', 'ORDER_STATE_CONFLICT');

  const provider = getStorageProvider();
  const bucket = String(intent.bucket) as StorageBucket;
  const key = String(intent.object_key);
  let location: StorageBucket = bucket;
  let info = await provider.stat(bucket, key);
  let verdict: { outcome: 'FINALIZED' | 'QUARANTINED' | 'REJECTED'; detail: string | null };
  if (!info && (info = await provider.stat(QUARANTINE_BUCKET, key))) {
    // A previous finalize moved the object but did not commit; record the quarantine now.
    location = QUARANTINE_BUCKET;
    verdict = { outcome: 'QUARANTINED', detail: 'recovered quarantine move' };
  } else if (!info) {
    throw new CommandError('No uploaded file was found for this upload yet', 'DOMAIN_RULE');
  } else if (info.size !== Number(intent.declared_size)) {
    await provider.remove(bucket, key);
    verdict = { outcome: 'REJECTED', detail: `uploaded ${info.size} bytes but declared ${intent.declared_size}` };
  } else {
    const signature = verifySignature(String(intent.declared_mime), await provider.readHead(bucket, key, 4096));
    if (signature.ok) {
      verdict = { outcome: 'FINALIZED', detail: null };
    } else {
      await provider.move(bucket, key, QUARANTINE_BUCKET);
      location = QUARANTINE_BUCKET;
      verdict = { outcome: 'QUARANTINED', detail: signature.detail };
    }
  }
  const sha256 = verdict.outcome === 'REJECTED' ? null : await provider.sha256(location, key);

  const committed = await sql.begin(async (tx) => {
    const [locked] = await tx<Row[]>`select * from app.upload_intents where id=${intentId} and owner_id=${actor.id} for update`;
    if (locked!.closed_at) return { result: resultFromIntent(locked!), removeAfter: false };
    if (!withinFinalizeWindow(locked!)) throw new CommandError('This upload expired. Start a new upload.', 'ORDER_STATE_CONFLICT');
    let outcome = verdict.outcome;
    let detail = verdict.detail;
    if (outcome === 'FINALIZED') {
      try {
        await assertOrderUpload(tx, actor, String(locked!.purpose) as AssetPurpose, locked!.order_id ? String(locked!.order_id) : null);
      } catch (error) {
        if (!(error instanceof CommandError)) throw error;
        outcome = 'REJECTED';
        detail = error.message;
      }
    }
    if (outcome !== 'REJECTED') {
      const quarantined = outcome === 'QUARANTINED';
      await tx`insert into app.storage_assets (id,owner_id,purpose,order_id,bucket,object_key,filename,mime,size_bytes,sha256,scan_status,scan_engine,scan_detail,lifecycle_state,quarantined_at)
        values (${intentId},${actor.id},${locked!.purpose},${locked!.order_id},${quarantined ? QUARANTINE_BUCKET : bucket},${key},${locked!.filename},${locked!.declared_mime},
          ${info!.size},${sha256},${quarantined ? 'QUARANTINED' : 'CLEAN'},${SCAN_ENGINE},${detail},${quarantined ? 'QUARANTINED' : 'READY'},${quarantined ? sql`now()` : null})`;
    }
    const [closed] = await tx<Row[]>`update app.upload_intents set closed_at=now(),outcome=${outcome},outcome_detail=${detail} where id=${intentId} returning *`;
    return { result: resultFromIntent(closed!), removeAfter: outcome === 'REJECTED' && verdict.outcome === 'FINALIZED' };
  });
  if (committed.removeAfter) await provider.remove(bucket, key);
  return committed.result;
}

const ORDER_OPERATOR_ROLES = ['support', 'finance', 'admin'] as const;

/** SEC-01/SEC-05: participants (and audited operators for disputes) get a 5-minute URL; everyone else sees 404. */
export async function createDownloadUrl(actor: Actor | null, assetId: string) {
  if (!UUID_PATTERN.test(assetId)) throw notFound();
  const [asset] = await sql<Row[]>`select a.*,o.buyer_id,o.creator_id,o.status as order_status,s.visibility as sample_visibility,s.moderation_status as sample_moderation
    from app.storage_assets a left join app.orders o on o.id=a.order_id left join app.samples s on s.storage_asset_id=a.id where a.id=${assetId}`;
  if (!asset || asset.lifecycle_state === 'DELETED') throw notFound();
  const purpose = String(asset.purpose) as AssetPurpose;
  const participant = !!actor && (actor.id === String(asset.buyer_id) || actor.id === String(asset.creator_id));
  const owner = !!actor && actor.id === String(asset.owner_id);
  let operatorAccess = false;
  let allowed: boolean;
  if (purpose === 'AVATAR') {
    // Photos are public only while a profile shows them (/api/avatars/[id]); here the owner can always preview.
    allowed = owner || (asset.lifecycle_state === 'READY' && !!(await sql<Row[]>`select 1 from app.profiles p join app.users u on u.id=p.user_id where p.avatar_asset_id=${assetId} and u.status='ACTIVE'`)[0]);
  } else if (purpose === 'REQUEST_IMAGE') {
    // Campaign images are as visible as their campaign (/api/request-images/[id]); the buyer can always preview.
    allowed = owner || (asset.lifecycle_state === 'READY' && !!(await sql<Row[]>`select 1 from app.request_images i join app.requests r on r.id=i.request_id where i.asset_id=${assetId} and r.status in ('OPEN','FILLED','CLOSED')`)[0]);
  } else if (purpose === 'ITEM_IMAGE') {
    // Item pictures are as visible as their listing (/api/item-images/[id]); the seller can always preview.
    allowed = owner || (asset.lifecycle_state === 'READY' && !!(await sql<Row[]>`select 1 from app.item_listing_images i join app.item_listings l on l.id=i.listing_id
      where (i.asset_id=${assetId} or i.thumb_asset_id=${assetId}) and l.status in ('OPEN','SOLD','NO_BIDS')`)[0]);
  } else if (purpose === 'DIGITAL') {
    // Buyers download product files only through their entitlement (src/modules/digital); here only the creator.
    allowed = owner;
  } else if (purpose === 'SAMPLE') {
    allowed = owner || (!!actor && hasAnyRole(actor, ['moderator', 'admin'])) || (asset.sample_visibility === 'PUBLIC' && asset.sample_moderation === 'APPROVED' && asset.lifecycle_state === 'READY');
  } else {
    operatorAccess = !participant && !!actor && actor.status === 'ACTIVE' && hasAnyRole(actor, ORDER_OPERATOR_ROLES) && (purpose === 'DISPUTE' || asset.order_status === 'DISPUTED');
    allowed = participant || operatorAccess;
  }
  if (!allowed) throw notFound();
  if (asset.lifecycle_state === 'QUARANTINED') throw new CommandError('This file is held for a safety review and cannot be downloaded', 'ORDER_STATE_CONFLICT');
  if (operatorAccess) {
    await sql.begin((tx) => audit(tx, actor, 'asset.operator_download', 'storage_asset', assetId, `Operator ${purpose.toLowerCase()} file access for order review`, null, { order_id: asset.order_id }));
  }
  const signed = await getStorageProvider().createSignedDownload(String(asset.bucket) as StorageBucket, String(asset.object_key), {
    filename: String(asset.filename), contentType: String(asset.mime), ttlSeconds: DOWNLOAD_URL_TTL_SECONDS,
  });
  return { url: signed.url, expires_at: signed.expiresAt.toISOString() };
}

export function parseAssetIds(value: string): string[] {
  const ids = [...new Set(value.split(/[\s,]+/).map((id) => id.trim().toLowerCase()).filter(Boolean))];
  if (ids.some((id) => !UUID_PATTERN.test(id))) throw new CommandError('asset_ids must be file ids from finished uploads');
  if (ids.length > MAX_ASSETS_PER_DELIVERY) throw new CommandError(`A delivery can include at most ${MAX_ASSETS_PER_DELIVERY} files`);
  return ids;
}

/** Locks and validates delivery files: same creator, same order, DELIVERY purpose, READY (SEC-14, ORD-07). */
export async function lockDeliveryAssets(tx: Tx, orderId: string, creatorId: string, ids: readonly string[]): Promise<void> {
  if (!ids.length) return;
  const rows = await tx<Row[]>`select id,owner_id,purpose,order_id,lifecycle_state from app.storage_assets where id = any(${ids}::uuid[]) order by id for share`;
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  for (const id of ids) {
    const row = byId.get(id);
    if (!row || String(row.owner_id) !== creatorId || row.purpose !== 'DELIVERY' || String(row.order_id) !== orderId) {
      throw new CommandError('One of the files was not uploaded for this order delivery', 'DOMAIN_RULE');
    }
    if (row.lifecycle_state !== 'READY') throw new CommandError('One of the files is held for a safety review and cannot be delivered', 'DOMAIN_RULE');
  }
}

export async function attachDeliveryAssets(tx: Tx, orderId: string, deliveryId: string, ids: readonly string[]): Promise<void> {
  let position = 0;
  for (const id of ids) {
    position += 1;
    await tx`insert into app.delivery_assets (delivery_id,order_id,asset_id,position) values (${deliveryId},${orderId},${id},${position})`;
  }
}

/** A portfolio sample may only use the creator's own finished SAMPLE upload, never a delivery or brief file. */
export async function lockSampleAsset(tx: Tx, creatorId: string, assetId: string): Promise<void> {
  const [row] = await tx<Row[]>`select id,owner_id,purpose,lifecycle_state from app.storage_assets where id=${assetId} for share`;
  if (!row || String(row.owner_id) !== creatorId || row.purpose !== 'SAMPLE') throw new CommandError('Portfolio samples need a file uploaded as a sample', 'DOMAIN_RULE');
  if (row.lifecycle_state !== 'READY') throw new CommandError('This file is held for a safety review', 'DOMAIN_RULE');
  const [linked] = await tx<Row[]>`select id from app.samples where storage_asset_id=${assetId}`;
  if (linked) throw new CommandError('This file is already used by another sample', 'DOMAIN_RULE');
}

/** Operator quarantine: the object moves to the quarantine bucket and loses every download path. */
export async function quarantineAsset(tx: Tx, assetId: string, detail: string): Promise<Row> {
  const [asset] = await tx<Row[]>`select * from app.storage_assets where id=${assetId} for update`;
  if (!asset || asset.lifecycle_state === 'DELETED') throw notFound();
  if (asset.lifecycle_state === 'QUARANTINED') throw new CommandError('This file is already quarantined', 'ORDER_STATE_CONFLICT');
  await tx`update app.storage_assets set lifecycle_state='QUARANTINED',scan_status='QUARANTINED',bucket=${QUARANTINE_BUCKET},scan_detail=${detail},quarantined_at=now() where id=${assetId}`;
  await getStorageProvider().move(String(asset.bucket) as StorageBucket, String(asset.object_key), QUARANTINE_BUCKET);
  return asset;
}

export async function listOrderAssets(orderId: string) {
  return sql<Row[]>`select a.id,a.purpose,a.owner_id,a.filename,a.mime,a.size_bytes,a.lifecycle_state,a.created_at,da.delivery_id,da.position
    from app.storage_assets a left join app.delivery_assets da on da.asset_id=a.id
    where a.order_id=${orderId} and a.lifecycle_state <> 'DELETED' order by a.created_at, da.position`;
}
