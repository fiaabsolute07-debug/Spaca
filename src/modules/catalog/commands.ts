import { CommandError, integer, money, orderEvent, text, type CommandHandler, type Row, type Tx } from '@/lib/commands';
import type { Actor } from '@/lib/auth';
import { reservePoolUnit } from '@/modules/capacity';

const TAXONOMIES = ['CREATE', 'PUBLISH', 'ACCESS', 'DIGITAL'];

export async function ownedService(tx: Tx, actor: Actor, id: string): Promise<Row> {
  const [service] = await tx<Row[]>`select s.*,cp.total_units,cp.reserved_units,cp.committed_units from app.services s
    join app.capacity_pools cp on cp.id=s.pool_id where s.id=${id} and s.creator_id=${actor.id} for update`;
  if (!service) throw new CommandError('Service not found or not owned by this account', 'FORBIDDEN');
  return service;
}

const updateProfile: CommandHandler = async ({ tx, actor, form }) => {
  const displayName = text(form, 'display_name');
  const handle = text(form, 'handle').toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(handle)) throw new CommandError('Handle must use 3–32 lowercase letters, numbers, _ or -');
  const bio = text(form, 'bio');
  const niche = text(form, 'niche', false) || 'Independent creator';
  const social = text(form, 'social_url', false) || null;
  if (social && !/^https?:\/\//.test(social)) throw new CommandError('Social URL must start with http:// or https://');
  await tx`update app.users set display_name=${displayName} where id=${actor.id}`;
  await tx`insert into app.profiles (user_id,handle,bio,niche,social_url) values (${actor.id},${handle},${bio},${niche},${social})
    on conflict (user_id) do update set handle=excluded.handle,bio=excluded.bio,niche=excluded.niche,social_url=excluded.social_url,updated_at=now()`;
  return { path: '/settings/profile', message: 'Profile saved' };
};

const addSample: CommandHandler = async ({ tx, actor, form }) => {
  const title = text(form, 'title');
  const url = text(form, 'url');
  const description = text(form, 'description', false);
  if (!/^https?:\/\//.test(url)) throw new CommandError('Sample URL must start with http:// or https://');
  const visibility = text(form, 'visibility', false) || 'PUBLIC';
  if (!['PUBLIC', 'PRIVATE'].includes(visibility)) throw new CommandError('Sample visibility is invalid');
  await tx`insert into app.samples (creator_id,title,url,description,visibility,moderation_status) values (${actor.id},${title},${url},${description},${visibility},'PENDING')`;
  return { path: '/creator/services', message: 'Sample added' };
};

const createService: CommandHandler = async ({ tx, actor, form }) => {
  const title = text(form, 'title');
  const description = text(form, 'description');
  const taxonomy = text(form, 'taxonomy');
  if (!TAXONOMIES.includes(taxonomy)) throw new CommandError('Unsupported service category');
  const price = money(text(form, 'price'), 'price');
  const capacity = integer(text(form, 'capacity'), 'capacity', 1, 100000);
  const turnaround = integer(text(form, 'turnaround_hours'), 'turnaround_hours', 1, 8760);
  const urls = [1, 2, 3].map((n) => text(form, `sample_url_${n}`));
  const titles = [1, 2, 3].map((n) => text(form, `sample_title_${n}`));
  if (urls.some((url) => !/^https?:\/\//.test(url))) throw new CommandError('Every sample URL must start with http:// or https://');
  const [pool] = await tx<Row[]>`insert into app.capacity_pools (creator_id,total_units,starts_at,ends_at) values (${actor.id},${capacity},now(),now()+interval '90 days') returning id`;
  const [service] = await tx<Row[]>`insert into app.services (creator_id,pool_id,title,description,taxonomy,price_minor,currency,turnaround_hours,revision_limit,status)
    values (${actor.id},${pool!.id},${title},${description},${taxonomy},${price.toString()},'USD',${turnaround},1,'DRAFT') returning id`;
  for (let i = 0; i < 3; i++) {
    await tx`insert into app.samples (creator_id,title,url,description) values (${actor.id},${titles[i]!},${urls[i]!},'Linked sample for this service')`;
  }
  return { path: '/creator/services', message: 'Draft service created', id: String(service!.id) };
};

const publishService: CommandHandler = async ({ tx, actor, form }) => {
  const id = text(form, 'service_id');
  const service = await ownedService(tx, actor, id);
  const [sampleCount] = await tx<Row[]>`select count(*)::int as count from app.samples where creator_id=${actor.id} and visibility='PUBLIC' and moderation_status='APPROVED'`;
  if (Number(sampleCount!.count) < 3) throw new CommandError('Add at least three work samples before publishing');
  if (Number(service.total_units) - Number(service.reserved_units) - Number(service.committed_units) < 1) {
    throw new CommandError('Set at least one available capacity unit before publishing');
  }
  await tx`update app.services set status='PUBLISHED',version=version+1,updated_at=now() where id=${id}`;
  return { path: '/creator/services', message: 'Service published' };
};

const pauseService: CommandHandler = async ({ tx, actor, form }) => {
  const id = text(form, 'service_id');
  await ownedService(tx, actor, id);
  await tx`update app.services set status='PAUSED',version=version+1,updated_at=now() where id=${id}`;
  return { path: '/creator/services', message: 'Service paused' };
};

const setCapacity: CommandHandler = async ({ tx, actor, form }) => {
  const poolId = text(form, 'pool_id');
  const total = integer(text(form, 'total_units'), 'total_units', 0, 100000);
  const [pool] = await tx<Row[]>`select * from app.capacity_pools where id=${poolId} and creator_id=${actor.id} for update`;
  if (!pool) throw new CommandError('Capacity pool not found or not owned by this account', 'FORBIDDEN');
  if (total < Number(pool.reserved_units) + Number(pool.committed_units)) throw new CommandError('Capacity cannot be below already held units');
  await tx`update app.capacity_pools set total_units=${total} where id=${poolId}`;
  return { path: '/creator/services', message: 'Capacity updated' };
};

const book: CommandHandler = async ({ tx, actor, form }) => {
  const serviceId = text(form, 'service_id');
  const brief = text(form, 'brief');
  const [service] = await tx<Row[]>`select s.*,cp.total_units,cp.reserved_units,cp.committed_units from app.services s
    join app.capacity_pools cp on cp.id=s.pool_id where s.id=${serviceId} and s.status='PUBLISHED' for update`;
  if (!service) throw new CommandError('Service is no longer available');
  if (String(service.creator_id) === actor.id) throw new CommandError('You cannot book your own service');
  await reservePoolUnit(tx, String(service.pool_id));
  const [order] = await tx<Row[]>`insert into app.orders (buyer_id,creator_id,service_id,pool_id,source,title,status,amount_minor,platform_fee_minor,currency,brief,terms,delivery_due_at)
    values (${actor.id},${service.creator_id},${service.id},${service.pool_id},'BOOK',${service.title},'AWAITING_PAYMENT',${service.price_minor},0,'USD',${brief},
      ${JSON.stringify({ revision_limit: 1 })}::jsonb,now()+(${service.turnaround_hours} * interval '1 hour')) returning id`;
  await tx`insert into app.reservations (pool_id,order_id,state,expires_at) values (${service.pool_id},${order!.id},'HELD',now()+interval '30 minutes')`;
  await orderEvent(tx, String(order!.id), actor.id, 'ORDER_CREATED', { source: 'BOOK', platform_fee_minor: '0' });
  return { path: `/orders/${order!.id}`, message: 'Capacity reserved. Fund the order to start work.', id: String(order!.id) };
};

export const catalogCommands: Record<string, CommandHandler> = {
  update_profile: updateProfile,
  add_sample: addSample,
  create_service: createService,
  publish_service: publishService,
  pause_service: pauseService,
  set_capacity: setCapacity,
  book,
};
