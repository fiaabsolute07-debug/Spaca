import { createHash, randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getActor, isSameOrigin, type Actor } from '@/lib/auth';
import { sql } from '@/lib/db';
import { PaymentFlowError, cancelOpenFunding, deliverPendingMockWebhooks, mockPaymentsEnabled, openCase, refundReasonFor, requestProviderRefund } from '@/modules/payments/funding';

class CommandError extends Error {
  constructor(message: string, readonly code = 'INVALID_COMMAND') { super(message); }
}

const text = (form: FormData, name: string, required = true) => {
  const value = String(form.get(name) ?? '').trim();
  if (required && !value) throw new CommandError(`${name} is required`);
  if (value.length > 12000) throw new CommandError(`${name} is too long`);
  if ([...value].some((char) => char.charCodeAt(0) < 32 && !['\n','\r','\t'].includes(char))) throw new CommandError(`${name} contains invalid characters`);
  return value;
};

const integer = (value: string, name: string, min: number, max: number) => {
  if (!/^\d+$/.test(value)) throw new CommandError(`${name} must be a whole number`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new CommandError(`${name} is out of range`);
  return parsed;
};

const money = (value: string, name: string) => {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw new CommandError(`${name} must be a positive USD amount`);
  const [whole, fraction = ''] = value.split('.');
  const minor = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
  if (minor <= 0n || minor > 100000000000n) throw new CommandError(`${name} is out of range`);
  return minor;
};

const instant = (value: string, name: string) => {
  const date = new Date(`${value}Z`);
  if (!value || Number.isNaN(date.getTime())) throw new CommandError(`${name} must be a valid date`);
  return date;
};

const safeReturnTo = (value: string | null, fallback: string) => value && value.startsWith('/') && !value.startsWith('//') && value.length < 300 ? value : fallback;
const hashInput = (input: Record<string, string>) => createHash('sha256').update(JSON.stringify(Object.entries(input).sort(([a],[b]) => a.localeCompare(b)))).digest('hex');
const valuesOf = (form: FormData) => Object.fromEntries([...form.entries()].filter(([key]) => !['idempotency_key','return_to'].includes(key)).map(([key,value]) => [key, String(value)]));

async function event(tx: any, orderId: string, actorId: string, kind: string, payload: Record<string, unknown> = {}) {
  await tx`insert into app.order_events (order_id,actor_id,kind,payload) values (${orderId},${actorId},${kind},${JSON.stringify(payload)}::jsonb)`;
}

async function ownedService(tx: any, actor: Actor, id: string) {
  const [service] = await tx`select s.*,cp.total_units,cp.reserved_units,cp.committed_units from app.services s join app.capacity_pools cp on cp.id=s.pool_id where s.id=${id} and s.creator_id=${actor.id} for update`;
  if (!service) throw new CommandError('Service not found or not owned by this account', 'FORBIDDEN');
  return service;
}

async function orderFor(tx: any, actor: Actor, id: string) {
  const [order] = await tx`select * from app.orders where id=${id} and (buyer_id=${actor.id} or creator_id=${actor.id}) for update`;
  if (!order) throw new CommandError('Order not found or not visible to this account', 'FORBIDDEN');
  return order;
}

async function reservePool(tx: any, poolId: string) {
  const [pool] = await tx`select * from app.capacity_pools where id=${poolId} for update`;
  if (!pool || Number(pool.total_units) - Number(pool.reserved_units) - Number(pool.committed_units) < 1) throw new CommandError('That creator has no available capacity', 'CAPACITY_UNAVAILABLE');
  await tx`update app.capacity_pools set reserved_units=reserved_units+1 where id=${poolId}`;
  return pool;
}

async function runCommand(tx: any, actor: Actor, command: string, form: FormData): Promise<{ path: string; message: string; id?: string }> {
  if (!['buyer','creator'].some((role) => actor.roles.includes(role))) throw new CommandError('This account cannot perform marketplace actions', 'FORBIDDEN');
  if (command === 'update_profile') {
    const displayName = text(form,'display_name');
    const handle = text(form,'handle').toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(handle)) throw new CommandError('Handle must use 3–32 lowercase letters, numbers, _ or -');
    const bio = text(form,'bio');
    const niche = text(form,'niche',false) || 'Independent creator';
    const social = text(form,'social_url',false) || null;
    if (social && !/^https?:\/\//.test(social)) throw new CommandError('Social URL must start with http:// or https://');
    await tx`update app.users set display_name=${displayName} where id=${actor.id}`;
    await tx`insert into app.profiles (user_id,handle,bio,niche,social_url) values (${actor.id},${handle},${bio},${niche},${social}) on conflict (user_id) do update set handle=excluded.handle,bio=excluded.bio,niche=excluded.niche,social_url=excluded.social_url,updated_at=now()`;
    return {path:'/settings/profile',message:'Profile saved'};
  }
  if (command === 'add_sample') {
    const title = text(form,'title'); const url = text(form,'url'); const description = text(form,'description',false);
    if (!/^https?:\/\//.test(url)) throw new CommandError('Sample URL must start with http:// or https://');
    const visibility = text(form,'visibility',false) || 'PUBLIC';
    if (!['PUBLIC','PRIVATE'].includes(visibility)) throw new CommandError('Sample visibility is invalid');
    await tx`insert into app.samples (creator_id,title,url,description,visibility,moderation_status) values (${actor.id},${title},${url},${description},${visibility},'PENDING')`;
    return {path:'/creator/services',message:'Sample added'};
  }
  if (command === 'create_service') {
    const title=text(form,'title'); const description=text(form,'description'); const taxonomy=text(form,'taxonomy');
    if (!['CREATE','PUBLISH','ACCESS','DIGITAL'].includes(taxonomy)) throw new CommandError('Unsupported service category');
    const price=money(text(form,'price'),'price'); const capacity=integer(text(form,'capacity'),'capacity',1,100000); const turnaround=integer(text(form,'turnaround_hours'),'turnaround_hours',1,8760);
    const urls=[1,2,3].map((n)=>text(form,`sample_url_${n}`)); const titles=[1,2,3].map((n)=>text(form,`sample_title_${n}`));
    if (urls.some((url)=>!/^https?:\/\//.test(url))) throw new CommandError('Every sample URL must start with http:// or https://');
    const [pool]=await tx`insert into app.capacity_pools (creator_id,total_units,starts_at,ends_at) values (${actor.id},${capacity},now(),now()+interval '90 days') returning id`;
    const [service]=await tx`insert into app.services (creator_id,pool_id,title,description,taxonomy,price_minor,currency,turnaround_hours,revision_limit,status) values (${actor.id},${pool.id},${title},${description},${taxonomy},${price.toString()},'USD',${turnaround},1,'DRAFT') returning id`;
    for (let i=0;i<3;i++) await tx`insert into app.samples (creator_id,title,url,description) values (${actor.id},${titles[i]},${urls[i]},'Linked sample for this service')`;
    return {path:'/creator/services',message:'Draft service created',id:String(service.id)};
  }
  if (command === 'publish_service') {
    const id=text(form,'service_id'); const service=await ownedService(tx,actor,id);
    const [sampleCount]=await tx`select count(*)::int as count from app.samples where creator_id=${actor.id} and visibility='PUBLIC' and moderation_status='APPROVED'`;
    if (Number(sampleCount.count)<3) throw new CommandError('Add at least three work samples before publishing');
    if (Number(service.total_units)-Number(service.reserved_units)-Number(service.committed_units)<1) throw new CommandError('Set at least one available capacity unit before publishing');
    await tx`update app.services set status='PUBLISHED',version=version+1,updated_at=now() where id=${id}`;
    return {path:'/creator/services',message:'Service published'};
  }
  if (command === 'pause_service') {
    await ownedService(tx,actor,text(form,'service_id')); await tx`update app.services set status='PAUSED',version=version+1,updated_at=now() where id=${text(form,'service_id')}`;
    return {path:'/creator/services',message:'Service paused'};
  }
  if (command === 'set_capacity') {
    const poolId=text(form,'pool_id'); const total=integer(text(form,'total_units'),'total_units',0,100000);
    const [pool]=await tx`select * from app.capacity_pools where id=${poolId} and creator_id=${actor.id} for update`;
    if (!pool) throw new CommandError('Capacity pool not found or not owned by this account','FORBIDDEN');
    if (total<Number(pool.reserved_units)+Number(pool.committed_units)) throw new CommandError('Capacity cannot be below already held units');
    await tx`update app.capacity_pools set total_units=${total} where id=${poolId}`;
    return {path:'/creator/services',message:'Capacity updated'};
  }
  if (command === 'book') {
    const serviceId=text(form,'service_id'); const brief=text(form,'brief');
    const [service]=await tx`select s.*,cp.total_units,cp.reserved_units,cp.committed_units from app.services s join app.capacity_pools cp on cp.id=s.pool_id where s.id=${serviceId} and s.status='PUBLISHED' for update`;
    if (!service) throw new CommandError('Service is no longer available');
    if (String(service.creator_id)===actor.id) throw new CommandError('You cannot book your own service');
    await reservePool(tx,String(service.pool_id));
    const [order]=await tx`insert into app.orders (buyer_id,creator_id,service_id,pool_id,source,title,status,amount_minor,platform_fee_minor,currency,brief,terms,delivery_due_at) values (${actor.id},${service.creator_id},${service.id},${service.pool_id},'BOOK',${service.title},'AWAITING_PAYMENT',${service.price_minor},0,'USD',${brief},${JSON.stringify({revision_limit:1})}::jsonb,now()+(${service.turnaround_hours} * interval '1 hour')) returning id`;
    await tx`insert into app.reservations (pool_id,order_id,state,expires_at) values (${service.pool_id},${order.id},'HELD',now()+interval '30 minutes')`;
    await event(tx,String(order.id),actor.id,'ORDER_CREATED',{source:'BOOK',platform_fee_minor:'0'});
    return {path:`/orders/${order.id}`,message:'Capacity reserved. Fund the order to start work.',id:String(order.id)};
  }
  if (command === 'sandbox_pay') {
    // Funding is a provider fact delivered by a verified webhook (src/modules/payments/funding.ts); clients cannot mark orders paid.
    throw new CommandError('Direct funding is not available. Pay through the provider checkout.','FORBIDDEN');
  }
  if (['start','deliver','approve','revision','dispute','cancel','refund','review','message'].includes(command)) {
    const orderId=text(form,'order_id'); const order=await orderFor(tx,actor,orderId); const status=String(order.status);
    if (command==='start') {
      if (actor.id!==String(order.creator_id)||status!=='FUNDED') throw new CommandError('Only the creator can start a funded order');
      await tx`update app.orders set status='IN_PROGRESS',version=version+1,updated_at=now() where id=${orderId}`; await event(tx,orderId,actor.id,'WORK_STARTED');
      return {path:`/orders/${orderId}`,message:'Work started'};
    }
    if (command==='deliver') {
      if (actor.id!==String(order.creator_id)||!['FUNDED','IN_PROGRESS','REVISION_REQUESTED'].includes(status)) throw new CommandError('Only the creator can deliver active work');
      const body=text(form,'body'); const url=text(form,'url',false)||null; const [last]=await tx`select coalesce(max(version),0)::int as version from app.deliveries where order_id=${orderId}`; const version=Number(last.version)+1;
      await tx`insert into app.deliveries (order_id,body,url,version) values (${orderId},${body},${url},${version})`;
      await tx`update app.orders set status='DELIVERED',review_due_at=now()+interval '72 hours',version=version+1,updated_at=now() where id=${orderId}`; await event(tx,orderId,actor.id,'DELIVERED',{version});
      return {path:`/orders/${orderId}`,message:'Delivery submitted for buyer review'};
    }
    if (command==='revision') {
      if (actor.id!==String(order.buyer_id)||status!=='DELIVERED') throw new CommandError('Only the buyer can request a revision after delivery');
      if (Number(order.revision_count)>=1) throw new CommandError('The included revision has already been used');
      const body=text(form,'body'); await tx`update app.orders set status='REVISION_REQUESTED',revision_count=revision_count+1,version=version+1,updated_at=now() where id=${orderId}`; await event(tx,orderId,actor.id,'REVISION_REQUESTED',{body});
      return {path:`/orders/${orderId}`,message:'Revision requested'};
    }
    if (command==='approve') {
      if (actor.id!==String(order.buyer_id)||status!=='DELIVERED') throw new CommandError('Only the buyer can approve a delivered version');
      // Approval only marks settlement READY; the release job transfers funds and RELEASED follows the provider's webhook.
      await tx`update app.orders set status='COMPLETED',settlement_status='READY',version=version+1,updated_at=now() where id=${orderId}`;
      await tx`update app.reservations set state='CONSUMED' where order_id=${orderId} and state='COMMITTED'`;
      await event(tx,orderId,actor.id,'ORDER_APPROVED',{platform_fee_minor:'0',settlement_status:'READY'});
      return {path:`/orders/${orderId}`,message:'Delivery approved. The creator payout is queued and shows as released once the provider confirms; platform fee is $0.00.'};
    }
    if (command==='dispute') {
      if (!['DELIVERED','REVISION_REQUESTED','IN_PROGRESS'].includes(status)) throw new CommandError('This order cannot be disputed in its current state');
      const reason=text(form,'body'); await tx`insert into app.disputes (order_id,opened_by,reason) values (${orderId},${actor.id},${reason})`; await tx`update app.orders set status='DISPUTED',version=version+1,updated_at=now() where id=${orderId}`; await event(tx,orderId,actor.id,'DISPUTE_OPENED');
      return {path:`/orders/${orderId}`,message:'Dispute opened for review'};
    }
    if (command==='cancel') {
      if (!['AWAITING_PAYMENT','FUNDED'].includes(status)) throw new CommandError('Cancellation requires an order before work starts');
      if (status==='AWAITING_PAYMENT') await cancelOpenFunding(tx,orderId);
      const [reservation]=await tx`select * from app.reservations where order_id=${orderId} for update`;
      if (reservation && ['HELD','COMMITTED'].includes(String(reservation.state))) {
        if (String(reservation.state)==='HELD') await tx`update app.capacity_pools set reserved_units=greatest(reserved_units-1,0) where id=${order.pool_id}`;
        if (String(reservation.state)==='COMMITTED') await tx`update app.capacity_pools set committed_units=greatest(committed_units-1,0) where id=${order.pool_id}`;
        await tx`update app.reservations set state='RELEASED' where id=${reservation.id}`;
      }
      await tx`update app.orders set status='CANCELLED',payment_status=case when payment_status='SUCCEEDED' then 'REFUND_PENDING' else payment_status end,version=version+1,updated_at=now() where id=${orderId}`; await event(tx,orderId,actor.id,'ORDER_CANCELLED');
      if (status==='FUNDED') {
        // Full principal refund before work starts (master §8.6); REFUNDED only after the provider confirms.
        try {
          const refund=await requestProviderRefund(tx,order,refundReasonFor('CANCELLED'));
          await event(tx,orderId,actor.id,'REFUND_REQUESTED',{operation_id:refund.operationId,provider_state:refund.state});
          if (refund.state==='REJECTED') await openCase(tx,orderId,null,'REFUND_REJECTED','HIGH',`Provider rejected refund (${refund.code})`);
        } catch (error) {
          if (!(error instanceof PaymentFlowError)) throw error;
          await openCase(tx,orderId,null,'REFUND_NOT_REQUESTED','HIGH',error.message);
        }
      }
      return {path:`/orders/${orderId}`,message:status==='FUNDED'?'Order cancelled. A full refund was requested from the provider and shows as refunded once confirmed.':'Order cancelled and capacity released'};
    }
    if (command==='refund') {
      if (!actor.roles.includes('finance') && !(actor.id===String(order.buyer_id)&&status==='CANCELLED')) throw new CommandError('Refunds require a finance role or a cancelled buyer order','FORBIDDEN');
      if (!['CANCELLED','DISPUTED'].includes(status)||order.payment_status!=='REFUND_PENDING') throw new CommandError('This order is not eligible for a refund');
      // The order becomes REFUNDED only when the provider's refund webhook is verified and processed.
      const refund=await requestProviderRefund(tx,order,refundReasonFor(status));
      if (refund.state==='REJECTED') throw new CommandError(`The provider rejected the refund (${refund.code})`);
      await event(tx,orderId,actor.id,'REFUND_REQUESTED',{operation_id:refund.operationId,provider_state:refund.state});
      return {path:`/orders/${orderId}`,message:refund.state==='READY'?'Refund requested from the provider. The order shows refunded once the provider confirms.':'The provider has not confirmed the refund request yet; retry to check the same refund operation.'};
    }
    if (command==='review') {
      if (actor.id!==String(order.buyer_id)||!['COMPLETED','APPROVED'].includes(status)) throw new CommandError('Only the buyer can review a completed order');
      const rating=integer(text(form,'rating'),'rating',1,5); const body=text(form,'body'); await tx`insert into app.reviews (order_id,buyer_id,creator_id,rating,body) values (${orderId},${actor.id},${order.creator_id},${rating},${body}) on conflict (order_id) do nothing`;
      return {path:`/orders/${orderId}`,message:'Review saved'};
    }
    if (command==='message') {
      const body=text(form,'body'); await tx`insert into app.messages (order_id,sender_id,body) values (${orderId},${actor.id},${body})`;
      return {path:`/orders/${orderId}`,message:'Message sent'};
    }
  }
  if (command === 'create_request') {
    const title=text(form,'title'); const brief=text(form,'brief'); const taxonomy=text(form,'taxonomy'); if(!['CREATE','PUBLISH','ACCESS','DIGITAL'].includes(taxonomy)) throw new CommandError('Unsupported request category');
    const budget=money(text(form,'budget'),'budget'); const capValue=text(form,'per_creator_cap',false); const cap=capValue?money(capValue,'per_creator_cap'):budget; const target=integer(text(form,'target_hires'),'target_hires',1,100); const deadline=instant(text(form,'deadline'),'deadline'); if(deadline<=new Date()) throw new CommandError('Deadline must be in the future');
    const [request]=await tx`insert into app.requests (buyer_id,title,brief,taxonomy,budget_minor,per_creator_cap_minor,target_hires,deadline) values (${actor.id},${title},${brief},${taxonomy},${budget.toString()},${cap.toString()},${target},${deadline.toISOString()}) returning id`;
    return {path:`/requests/${request.id}`,message:'Brief published. Creators can now apply.',id:String(request.id)};
  }
  if (command === 'apply') {
    const requestId=text(form,'request_id'); const quote=money(text(form,'quote'),'quote'); const note=text(form,'note'); const turnaround=integer(text(form,'turnaround_hours'),'turnaround_hours',1,8760);
    const [request]=await tx`select * from app.requests where id=${requestId} and status in ('OPEN','SELECTING') and deadline>now() for update`; if(!request) throw new CommandError('Request is closed or unavailable'); if(String(request.buyer_id)===actor.id) throw new CommandError('You cannot apply to your own request'); if(quote>BigInt(request.per_creator_cap_minor)) throw new CommandError('Quote exceeds the request cap');
    await tx`insert into app.applications (request_id,creator_id,quote_minor,turnaround_hours,note,status) values (${requestId},${actor.id},${quote.toString()},${turnaround},${note},'SUBMITTED') on conflict (request_id,creator_id) do update set quote_minor=excluded.quote_minor,turnaround_hours=excluded.turnaround_hours,note=excluded.note,status='SUBMITTED',updated_at=now()`;
    return {path:`/requests/${requestId}`,message:'Application sent'};
  }
  if (command === 'select_application') {
    const appId=text(form,'application_id'); const [application]=await tx`select a.*,r.buyer_id,r.status as request_status from app.applications a join app.requests r on r.id=a.request_id where a.id=${appId} and r.buyer_id=${actor.id} for update`; if(!application) throw new CommandError('Application not found or not owned by this buyer','FORBIDDEN');
    await tx`update app.applications set status='SELECTED',updated_at=now() where id=${appId} and status='SUBMITTED'`; await tx`update app.requests set status='SELECTING',updated_at=now() where id=${application.request_id}`;
    return {path:`/requests/${application.request_id}`,message:'Creator selected. They can accept the offer.'};
  }
  if (command === 'accept_offer' || command === 'decline_offer') {
    const appId=text(form,'application_id'); const [application]=await tx`select a.*,r.title,r.brief,r.buyer_id,r.taxonomy,r.deadline,r.status as request_status from app.applications a join app.requests r on r.id=a.request_id where a.id=${appId} and a.creator_id=${actor.id} for update`; if(!application) throw new CommandError('Offer not found or not visible to this account','FORBIDDEN');
    if(command==='decline_offer'){await tx`update app.applications set status='DECLINED',updated_at=now() where id=${appId}`;return {path:`/requests/${application.request_id}`,message:'Offer declined'};}
    if(String(application.status)!=='SELECTED') throw new CommandError('This application is not selected');
    const [service]=await tx`select s.*,cp.total_units,cp.reserved_units,cp.committed_units from app.services s join app.capacity_pools cp on cp.id=s.pool_id where s.creator_id=${actor.id} and s.status='PUBLISHED' and s.taxonomy=${application.taxonomy} order by s.created_at desc limit 1 for update`; if(!service) throw new CommandError('Publish a matching service before accepting this offer'); await reservePool(tx,String(service.pool_id));
    const [order]=await tx`insert into app.orders (buyer_id,creator_id,service_id,pool_id,source,source_ref,title,status,amount_minor,platform_fee_minor,currency,brief,terms,delivery_due_at) values (${application.buyer_id},${actor.id},${service.id},${service.pool_id},'REQUEST',${application.request_id},${application.title},'AWAITING_PAYMENT',${application.quote_minor},0,'USD',${application.brief},${JSON.stringify({revision_limit:1,request_id:application.request_id})}::jsonb,now()+(${application.turnaround_hours} * interval '1 hour')) returning id`;
    await tx`insert into app.reservations (pool_id,order_id,state,expires_at) values (${service.pool_id},${order.id},'HELD',now()+interval '30 minutes')`; await tx`update app.applications set status='ACCEPTED',updated_at=now() where id=${appId}`; await tx`update app.requests set status='FILLED',updated_at=now() where id=${application.request_id}`; await event(tx,String(order.id),actor.id,'ORDER_CREATED',{source:'REQUEST',platform_fee_minor:'0'});
    return {path:`/orders/${order.id}`,message:'Offer accepted. Buyer must fund the order.',id:String(order.id)};
  }
  if (command === 'create_auction') {
    const serviceId=text(form,'service_id'); const service=await ownedService(tx,actor,serviceId); if(String(service.status)!=='PUBLISHED') throw new CommandError('Only a published service can be auctioned'); const starting=money(text(form,'starting_price'),'starting_price'); const increment=money(text(form,'minimum_increment'),'minimum_increment'); const buyValue=text(form,'buy_now_price',false); const buy=buyValue?money(buyValue,'buy_now_price'):null; if(buy!==null&&buy<starting) throw new CommandError('Buy now must be at least the starting price'); const starts=instant(text(form,'starts_at'),'starts_at'); const ends=instant(text(form,'ends_at'),'ends_at'); if(ends<=starts||ends<=new Date()) throw new CommandError('Auction end must be after its start and in the future'); await reservePool(tx,String(service.pool_id));
    const [auction]=await tx`insert into app.auctions (service_id,seller_id,title,starting_price_minor,minimum_increment_minor,buy_now_price_minor,starts_at,ends_at,status) values (${service.id},${actor.id},${service.title},${starting.toString()},${increment.toString()},${buy?.toString() ?? null},${starts.toISOString()},${ends.toISOString()},'SCHEDULED') returning id`; await tx`insert into app.reservations (pool_id,auction_id,state,expires_at) values (${service.pool_id},${auction.id},'HELD',${ends.toISOString()})`;
    return {path:`/auctions/${auction.id}`,message:'Auction scheduled and one capacity unit reserved',id:String(auction.id)};
  }
  if (command === 'bid') {
    const auctionId=text(form,'auction_id'); const amount=money(text(form,'amount'),'amount'); const [auction]=await tx`select * from app.auctions where id=${auctionId} for update`; if(!auction) throw new CommandError('Auction not found'); if(String(auction.seller_id)===actor.id) throw new CommandError('You cannot bid on your own auction'); const now=new Date(); if(new Date(String(auction.ends_at))<=now) throw new CommandError('Auction has ended'); if(new Date(String(auction.starts_at))>now) throw new CommandError('Auction has not started'); const current=auction.current_price_minor?BigInt(auction.current_price_minor):BigInt(auction.starting_price_minor); if(amount<current+BigInt(auction.minimum_increment_minor)) throw new CommandError('Bid must meet the minimum increment'); await tx`insert into app.bids (auction_id,bidder_id,amount_minor) values (${auctionId},${actor.id},${amount.toString()})`; await tx`update app.auctions set status='LIVE',current_price_minor=${amount.toString()},bid_count=bid_count+1,updated_at=now() where id=${auctionId}`; return {path:`/auctions/${auctionId}`,message:'Bid accepted by the server'};
  }
  if (command === 'buy_now') {
    const auctionId=text(form,'auction_id'); const [auction]=await tx`select a.*,r.pool_id,r.id as reservation_id from app.auctions a join app.reservations r on r.auction_id=a.id where a.id=${auctionId} for update`; if(!auction||!auction.buy_now_price_minor) throw new CommandError('Buy now is unavailable'); if(String(auction.seller_id)===actor.id||Number(auction.bid_count)>0) throw new CommandError('Buy now is only available before the first bid'); if(new Date(String(auction.ends_at))<=new Date()) throw new CommandError('Auction has ended'); const [order]=await tx`insert into app.orders (buyer_id,creator_id,service_id,pool_id,source,source_ref,title,status,amount_minor,platform_fee_minor,currency,brief,terms,delivery_due_at) values (${actor.id},${auction.seller_id},${auction.service_id},${auction.pool_id},'AUCTION',${auction.id},${auction.title},'AWAITING_PAYMENT',${auction.buy_now_price_minor},0,'USD','Auction purchase — confirm the final brief in the order workspace.',${JSON.stringify({revision_limit:1})}::jsonb,now()+interval '72 hours') returning id`; await tx`update app.reservations set order_id=${order.id},state='HELD',auction_id=null where id=${auction.reservation_id}`; await tx`update app.auctions set status='AWAITING_WINNER_PAYMENT',winner_id=${actor.id},updated_at=now() where id=${auctionId}`; await event(tx,String(order.id),actor.id,'ORDER_CREATED',{source:'AUCTION',platform_fee_minor:'0'}); return {path:`/orders/${order.id}`,message:'Buy now reserved the auction slot. Fund the order to confirm.',id:String(order.id)};
  }
  if (command === 'close_auction') {
    const auctionId=text(form,'auction_id'); const [auction]=await tx`select a.*,r.pool_id,r.id as reservation_id from app.auctions a left join app.reservations r on r.auction_id=a.id where a.id=${auctionId} and a.seller_id=${actor.id} for update of a`; if(!auction) throw new CommandError('Auction not found or not owned by this account','FORBIDDEN'); if(!['SCHEDULED','LIVE'].includes(String(auction.status))) throw new CommandError('This auction has already been closed or is awaiting winner payment'); if(new Date(String(auction.ends_at))>new Date()) throw new CommandError('Auction can only close after its server deadline'); const [bid]=await tx`select * from app.bids where auction_id=${auctionId} order by amount_minor desc,created_at asc limit 1`; if(!bid){await tx`update app.auctions set status='EXPIRED',updated_at=now() where id=${auctionId}`;if(auction.reservation_id){await tx`update app.capacity_pools set reserved_units=greatest(reserved_units-1,0) where id=${auction.pool_id}`;await tx`update app.reservations set state='RELEASED' where id=${auction.reservation_id}`;}return {path:`/auctions/${auctionId}`,message:'Auction closed with no valid bids; capacity released'};}
    const [order]=await tx`insert into app.orders (buyer_id,creator_id,service_id,pool_id,source,source_ref,title,status,amount_minor,platform_fee_minor,currency,brief,terms,delivery_due_at) values (${bid.bidder_id},${auction.seller_id},${auction.service_id},${auction.pool_id},'AUCTION',${auction.id},${auction.title},'AWAITING_PAYMENT',${bid.amount_minor},0,'USD','Winning bid — confirm the final brief in the order workspace.',${JSON.stringify({revision_limit:1})}::jsonb,now()+interval '24 hours') returning id`; await tx`update app.reservations set order_id=${order.id},state='HELD',auction_id=null,expires_at=now()+interval '24 hours' where id=${auction.reservation_id}`; await tx`update app.auctions set status='AWAITING_WINNER_PAYMENT',winner_id=${bid.bidder_id},updated_at=now() where id=${auctionId}`; await event(tx,String(order.id),actor.id,'AUCTION_CLOSED',{winner_id:String(bid.bidder_id),amount_minor:String(bid.amount_minor)}); return {path:`/auctions/${auctionId}`,message:'Auction closed. The winner must fund the order.',id:String(order.id)};
  }
  if (command === 'create_pool') {
    const requestId=text(form,'request_id',false)||null; const symbol=text(form,'asset_symbol'); const atomic=text(form,'amount'); if(!/^[A-Z0-9]{2,12}$/.test(symbol)||!/^[0-9]+$/.test(atomic)) throw new CommandError('Reward pool asset and amount are invalid'); await tx`insert into app.reward_pools (request_id,asset_symbol,amount_atomic,created_by) values (${requestId},${symbol},${atomic},${actor.id})`; return {path:requestId?`/requests/${requestId}`:'/dashboard',message:'Reward pool recorded as local simulation only'};
  }
  throw new CommandError('Unknown command');
}

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'Origin not allowed' }, { status: 403 });
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  const form = await request.formData();
  const command = String(form.get('command') ?? '').trim();
  const idempotencyKey = String(form.get('idempotency_key') ?? randomUUID());
  const returnTo = safeReturnTo(String(form.get('return_to') ?? ''), '/dashboard');
  if (!/^[A-Za-z0-9_.:-]{8,200}$/.test(idempotencyKey)) return NextResponse.json({ error: 'Invalid idempotency key' }, { status: 400 });
  try {
    const inputHash = hashInput(valuesOf(form));
    const result = await sql.begin(async (tx) => {
      // Serialize same-key submits so concurrent duplicates replay the stored result instead of racing the unique insert.
      await tx`select pg_advisory_xact_lock(hashtextextended(${`${actor.id}:${command}:${idempotencyKey}`}, 0))`;
      const [previous] = await tx`select input_hash,result from app.commands where actor_id=${actor.id} and command=${command} and idempotency_key=${idempotencyKey} for update`;
      if (previous) {
        if (String(previous.input_hash)!==inputHash) throw new CommandError('This idempotency key was already used for different input','IDEMPOTENCY_CONFLICT');
        return previous.result as {path:string;message:string;id?:string};
      }
      const result = await runCommand(tx,actor,command,form);
      await tx`insert into app.commands (actor_id,command,idempotency_key,input_hash,result) values (${actor.id},${command},${idempotencyKey},${inputHash},${JSON.stringify(result)}::jsonb)`;
      return result;
    });
    // Local mock provider emits webhooks after commit (e.g. refund confirmation); failures stay in the inbox for retry.
    if (mockPaymentsEnabled()) await deliverPendingMockWebhooks().catch((error) => console.error('mock webhook delivery failed', error));
    if ((request.headers.get('accept') ?? '').includes('application/json')) return NextResponse.json(result);
    const destination = result.path || returnTo;
    return NextResponse.redirect(new URL(`${destination}${destination.includes('?')?'&':'?'}message=${encodeURIComponent(result.message)}`,request.url),303);
  } catch (error) {
    const known = error instanceof CommandError || error instanceof PaymentFlowError;
    const message = known ? error.message : 'The command could not be completed. Check the order state and try again.';
    if ((request.headers.get('accept') ?? '').includes('application/json')) return NextResponse.json({error:message},{status:known&&error.code==='FORBIDDEN'?403:400});
    return NextResponse.redirect(new URL(`${returnTo}?error=${encodeURIComponent(message)}`,request.url),303);
  }
}
