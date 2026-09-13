import postgres from 'postgres';
import { hashPassword } from '../src/lib/auth';

const url = process.env.DATABASE_URL ?? 'postgres://app_server:local_dev_only@127.0.0.1:55432/creator_marketplace';
const sql = postgres(url, { max: 1, connect_timeout: 10 });

const creatorId = '10000000-0000-4000-8000-000000000001';
const buyerId = '10000000-0000-4000-8000-000000000002';
const poolId = '20000000-0000-4000-8000-000000000001';
const serviceId = '30000000-0000-4000-8000-000000000001';

try {
  await sql.begin(async (tx) => {
    const creatorPassword = hashPassword('creator-local-password');
    const buyerPassword = hashPassword('buyer-local-password');
    await tx`insert into app.users (id,email,display_name,password_hash,roles,is_test,status)
      values (${creatorId},'creator@example.test','Ari Nguyen',${creatorPassword},ARRAY['buyer','creator'],true,'ACTIVE')
      on conflict (id) do update set display_name=excluded.display_name, password_hash=excluded.password_hash, status='ACTIVE'`;
    await tx`insert into app.users (id,email,display_name,password_hash,roles,is_test,status)
      values (${buyerId},'buyer@example.test','Sam Tran',${buyerPassword},ARRAY['buyer','creator'],true,'ACTIVE')
      on conflict (id) do update set display_name=excluded.display_name, password_hash=excluded.password_hash, status='ACTIVE'`;
    await tx`insert into app.profiles (user_id,handle,bio,niche,avatar_color,social_url)
      values (${creatorId},'ari-makes','Brand stories, launch writing, and editorial systems for thoughtful teams.','Launch writing','#e7bda6','https://example.com/ari')
      on conflict (user_id) do update set bio=excluded.bio,niche=excluded.niche`;
    await tx`insert into app.profiles (user_id,handle,bio,niche,avatar_color)
      values (${buyerId},'sam-builds','A product team looking for clear creative partners.','Product team','#dce1ed')
      on conflict (user_id) do update set bio=excluded.bio,niche=excluded.niche`;
    await tx`insert into app.capacity_pools (id,creator_id,total_units,reserved_units,committed_units,starts_at,ends_at)
      values (${poolId},${creatorId},5,0,0,now(),now()+interval '90 days')
      on conflict (id) do update set total_units=5,reserved_units=0,committed_units=0`;
    await tx`insert into app.services (id,creator_id,pool_id,title,description,taxonomy,price_minor,currency,turnaround_hours,revision_limit,status)
      values (${serviceId},${creatorId},${poolId},'Launch story and landing page copy','A focused launch narrative, landing page structure, and conversion-minded copy for a product people should understand quickly.','CREATE',65000,'USD',72,1,'PUBLISHED')
      on conflict (id) do update set title=excluded.title,description=excluded.description,status='PUBLISHED',price_minor=excluded.price_minor`;
    await tx`delete from app.samples where creator_id=${creatorId}`;
    await tx`insert into app.samples (creator_id,title,url,description) values
      (${creatorId},'Product launch narrative','https://example.com/work/launch-narrative','Positioning and story system for a product launch.'),
      (${creatorId},'Conversion landing page','https://example.com/work/landing-page','Landing page copy with a clear hierarchy from problem to proof.'),
      (${creatorId},'Editorial campaign','https://example.com/work/editorial','A launch series designed to be useful before it becomes promotional.')`;
  });
  console.log('seeded local creator-marketplace fixtures');
  console.log('creator@example.test / creator-local-password');
  console.log('buyer@example.test / buyer-local-password');
} finally {
  await sql.end();
}
