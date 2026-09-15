/**
 * DIGITAL products (master §16.9 P6-05/06; XPL-04/05/06). A listing sells a license to private, versioned files.
 * Purchases hold an entitlement instead of a workload claim (no creator time is used). The database refuses a second
 * live exclusive license and sales beyond stock (drizzle/0016); this module adds releases, fulfilment on funding,
 * entitlement-checked downloads and the refund-before-first-download rule.
 */
import type { Actor } from '@/lib/auth';
import { CommandError, UUID_PATTERN, integer, text, type Row, type Tx } from '@/lib/commands';
import { sql } from '@/lib/db';
import { enqueueNotification } from '@/modules/notifications/enqueue';
import { termsOf } from '@/modules/orders/lifecycle';
import { DOWNLOAD_URL_TTL_SECONDS, type StorageBucket } from '@/modules/storage/policy';
import { getStorageProvider } from '@/modules/storage/provider';

type Queryable = Tx | import('postgres').Sql;

export const DIGITAL_POLICY_VERSION = 'digital-v1';
export const LIVE_ENTITLEMENT_STATES = ['HELD', 'EXPIRY_RECONCILING', 'ACTIVE'] as const;

export type DigitalTerms = {
  license: 'NON_EXCLUSIVE' | 'EXCLUSIVE';
  rights_text: string;
  updates_policy: 'LATEST' | 'PURCHASED_VERSION';
  download_limit: number;
  release_version: number;
  policy_version: string;
};

export type DigitalFields = { license: 'NON_EXCLUSIVE' | 'EXCLUSIVE'; rightsText: string; stock: number | null; updates: 'LATEST' | 'PURCHASED_VERSION'; downloadLimit: number };

/** License terms from a service form. An exclusive license always has stock 1. */
export function digitalFields(form: FormData): DigitalFields {
  const license = text(form, 'digital_license', false) || 'NON_EXCLUSIVE';
  if (license !== 'NON_EXCLUSIVE' && license !== 'EXCLUSIVE') throw new CommandError('digital_license must be NON_EXCLUSIVE or EXCLUSIVE');
  const rightsText = text(form, 'digital_rights_text', true, 4000);
  if (rightsText.length < 20) throw new CommandError('Describe what the buyer may do with the files in at least 20 characters');
  const updates = text(form, 'digital_updates', false) || 'LATEST';
  if (updates !== 'LATEST' && updates !== 'PURCHASED_VERSION') throw new CommandError('digital_updates must be LATEST or PURCHASED_VERSION');
  const stockValue = text(form, 'digital_stock', false, 10);
  const stock = license === 'EXCLUSIVE' ? 1 : stockValue ? integer(stockValue, 'digital_stock', 1, 100000) : null;
  const downloadLimit = integer(text(form, 'digital_download_limit', false, 5) || '10', 'digital_download_limit', 1, 1000);
  return { license, rightsText, stock, updates, downloadLimit };
}

export function digitalTermsOf(terms: unknown): DigitalTerms | null {
  const digital = (terms as { digital?: DigitalTerms } | null)?.digital;
  return digital && typeof digital.license === 'string' ? digital : null;
}

export async function latestReleaseVersion(db: Queryable, serviceId: string): Promise<number | null> {
  const [row] = await db<Row[]>`select max(version)::int as version from app.digital_releases where service_id=${serviceId}`;
  return row?.version == null ? null : Number(row.version);
}

/** SOLD_OUT when stock is used up (live holds count) or an exclusive license is live; otherwise ACCEPTING. */
export async function digitalAvailability(db: Queryable, serviceIds: string[]): Promise<Map<string, 'ACCEPTING' | 'SOLD_OUT'>> {
  if (!serviceIds.length) return new Map();
  const rows = await db<Row[]>`select s.id,s.digital_stock,
      (select count(*)::int from app.digital_entitlements e where e.service_id=s.id and e.state in ('HELD','EXPIRY_RECONCILING','ACTIVE')) as live,
      exists (select 1 from app.digital_entitlements e where e.service_id=s.id and e.license='EXCLUSIVE' and e.state in ('HELD','EXPIRY_RECONCILING','ACTIVE')) as exclusive_live
    from app.services s where s.id = any(${serviceIds}::uuid[])`;
  return new Map(rows.map((row) => [String(row.id), row.exclusive_live || (row.digital_stock != null && Number(row.live) >= Number(row.digital_stock)) ? 'SOLD_OUT' : 'ACCEPTING']));
}

/** Inserts the HELD entitlement for a new DIGITAL order; the database trigger refuses a sale beyond stock or exclusivity. */
export async function holdEntitlement(tx: Tx, input: { orderId: string; serviceId: string; versionId: string; buyerId: string; creatorId: string; terms: DigitalTerms; expiresAt: Date }): Promise<Row> {
  try {
    const [entitlement] = await tx.savepoint((sp) => sp<Row[]>`insert into app.digital_entitlements
        (order_id,service_id,service_version_id,buyer_id,creator_id,license,release_version,updates_policy,download_limit,expires_at)
      values (${input.orderId},${input.serviceId},${input.versionId},${input.buyerId},${input.creatorId},${input.terms.license},${input.terms.release_version},
        ${input.terms.updates_policy},${input.terms.download_limit},${input.expiresAt.toISOString()}) returning *`);
    return entitlement!;
  } catch (error) {
    const pg = error as { hint?: string; code?: string };
    if (pg.hint === 'SOLD_OUT' || pg.code === '23505') {
      throw new CommandError(input.terms.license === 'EXCLUSIVE' ? 'The exclusive license for this product is already sold or reserved.' : 'This product is sold out.', 'SOLD_OUT');
    }
    throw error;
  }
}

/**
 * Called right after an order is funded (all rails). A DIGITAL order is delivered at once: the entitlement is already
 * ACTIVE (order trigger), and the order moves FUNDED → IN_PROGRESS → DELIVERED so the normal review, auto-accept,
 * dispute and settlement rules apply.
 */
export async function fulfillDigitalOrder(tx: Tx, orderId: string): Promise<boolean> {
  const [order] = await tx<Row[]>`select * from app.orders where id=${orderId} for update`;
  const digital = order ? digitalTermsOf(order.terms) : null;
  if (!order || !digital || order.status !== 'FUNDED') return false;
  const [entitlement] = await tx<Row[]>`select id,state from app.digital_entitlements where order_id=${orderId}`;
  if (entitlement?.state !== 'ACTIVE') return false;
  await tx`update app.orders set status='IN_PROGRESS',version=version+1,updated_at=now() where id=${orderId}`;
  const window = termsOf(order).reviewWindowHours;
  const body = `Digital product, version ${digital.release_version} (${digital.license === 'EXCLUSIVE' ? 'exclusive' : 'non-exclusive'} license). Download it from the Files for this purchase panel.`;
  await tx`insert into app.deliveries (order_id,body,url,version,validation_status,submitted_by) values (${orderId},${body},${null},1,'VALID',${String(order.creator_id)})`;
  const [updated] = await tx<Row[]>`update app.orders set status='DELIVERED',review_due_at=now() + (${window} * interval '1 hour'),version=version+1,updated_at=now()
    where id=${orderId} returning review_due_at`;
  await tx`insert into app.order_events (order_id,actor_id,kind,payload) values (${orderId},${null},'DIGITAL_DELIVERED',
    ${JSON.stringify({ entitlement_id: String(entitlement.id), release_version: digital.release_version, license: digital.license })}::jsonb)`;
  await enqueueNotification(tx, orderId, `notify:order.delivered:${orderId}:v1`, {
    templateId: 'order.delivered', recipientId: String(order.buyer_id), params: { orderRef: orderId, reviewDeadlineAt: new Date(updated!.review_due_at).toISOString() },
  });
  return true;
}

/** Releases a buyer can download under the entitlement's update policy (XPL-06). */
export async function downloadableReleases(db: Queryable, entitlement: Row): Promise<Row[]> {
  const cap = entitlement.updates_policy === 'LATEST' ? null : Number(entitlement.release_version);
  return db<Row[]>`select r.id,r.version,r.notes,r.created_at,a.filename,a.mime,a.size_bytes,a.lifecycle_state,a.bucket,a.object_key
    from app.digital_releases r join app.storage_assets a on a.id=r.asset_id
    where r.service_id=${String(entitlement.service_id)} and (${cap}::int is null or r.version <= ${cap}::int)
    order by r.version desc`;
}

const unavailable = () => new CommandError('File not found or not available to this account', 'NOT_FOUND');

/**
 * A 5-minute download link for one release, counted against the entitlement's limit. Only the entitled buyer, only
 * while ACTIVE; a refunded or cancelled purchase gets nothing, and non-buyers see 404.
 */
export async function createEntitlementDownload(actor: Actor, entitlementId: string, requestedVersion: number | null) {
  if (!UUID_PATTERN.test(entitlementId)) throw unavailable();
  const release = await sql.begin(async (tx) => {
    const [entitlement] = await tx<Row[]>`select * from app.digital_entitlements where id=${entitlementId} and buyer_id=${actor.id} for update`;
    if (!entitlement) throw unavailable();
    if (entitlement.state !== 'ACTIVE') throw new CommandError(entitlement.state === 'REVOKED' ? 'This purchase was cancelled or refunded, so its files are no longer available' : 'Files unlock once payment is confirmed', 'ORDER_STATE_CONFLICT');
    const releases = await downloadableReleases(tx, entitlement);
    const chosen = requestedVersion === null ? releases[0] : releases.find((r) => Number(r.version) === requestedVersion);
    if (!chosen) throw new CommandError(requestedVersion === null ? 'No file is available yet' : 'Your license does not include this version', requestedVersion === null ? 'ORDER_STATE_CONFLICT' : 'FORBIDDEN');
    if (chosen.lifecycle_state !== 'READY') throw new CommandError('This file is held for a safety review and cannot be downloaded', 'ORDER_STATE_CONFLICT');
    if (Number(entitlement.download_count) >= Number(entitlement.download_limit)) {
      throw new CommandError(`You have used all ${Number(entitlement.download_limit)} downloads for this purchase. Contact the creator or support.`, 'RATE_LIMITED');
    }
    await tx`update app.digital_entitlements set download_count=download_count+1,first_downloaded_at=coalesce(first_downloaded_at,now()) where id=${entitlementId}`;
    await tx`insert into app.digital_downloads (entitlement_id,release_id,actor_id) values (${entitlementId},${String(chosen.id)},${actor.id})`;
    return chosen;
  });
  const signed = await getStorageProvider().createSignedDownload(String(release.bucket) as StorageBucket, String(release.object_key), {
    filename: String(release.filename), contentType: String(release.mime), ttlSeconds: DOWNLOAD_URL_TTL_SECONDS,
  });
  return { url: signed.url, expires_at: signed.expiresAt.toISOString(), version: Number(release.version) };
}
