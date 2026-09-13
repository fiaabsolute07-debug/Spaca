/**
 * Deterministic local/test fixtures (master §5.7, §17.3). Idempotent: re-running never resets capacity
 * counters or touches orders. Refuses non-local targets (FND-07).
 */
import postgres from 'postgres';
import { hashPassword } from '../src/lib/auth';
import { FIXTURE_PERSONAS, assertLocalDatabaseTarget } from '../src/lib/fixtures';

const url = process.env.DATABASE_URL ?? 'postgres://app_server:local_dev_only@127.0.0.1:55432/creator_marketplace';
const target = assertLocalDatabaseTarget(url);
const sql = postgres(url, { max: 1, connect_timeout: 10 });

const creator = FIXTURE_PERSONAS.creator_c;
const poolId = '20000000-0000-4000-8000-000000000001';
const serviceId = '30000000-0000-4000-8000-000000000001';

// Password sign-in exists only for the two original local fixtures; every persona can use POST /api/dev/session.
const LOCAL_PASSWORDS: Partial<Record<string, string>> = {
  [FIXTURE_PERSONAS.creator_c.id]: 'creator-local-password',
  [FIXTURE_PERSONAS.buyer_a.id]: 'buyer-local-password',
};

try {
  await sql.begin(async (tx) => {
    for (const persona of Object.values(FIXTURE_PERSONAS)) {
      const password = LOCAL_PASSWORDS[persona.id];
      await tx`insert into app.users (id,email,display_name,password_hash,roles,is_test,status)
        values (${persona.id},${persona.email},${persona.displayName},${password ? hashPassword(password) : null},${[...persona.roles]},true,${persona.status})
        on conflict (id) do update set display_name=excluded.display_name,roles=excluded.roles,status=excluded.status,is_test=true,
          password_hash=coalesce(excluded.password_hash,app.users.password_hash)`;
      if ('handle' in persona && persona.handle) {
        await tx`insert into app.profiles (user_id,handle,bio,niche,avatar_color)
          values (${persona.id},${persona.handle},${`${persona.displayName} — local test fixture profile.`},'Local fixture','#dce1ed')
          on conflict (user_id) do nothing`;
      }
    }
    await tx`update app.profiles set bio='Brand stories, launch writing, and editorial systems for thoughtful teams.',niche='Launch writing',avatar_color='#e7bda6',social_url='https://example.com/ari'
      where user_id=${creator.id}`;
    await tx`insert into app.capacity_pools (id,creator_id,total_units,reserved_units,committed_units,starts_at,ends_at)
      values (${poolId},${creator.id},5,0,0,now(),now()+interval '90 days') on conflict (id) do nothing`;
    await tx`insert into app.services (id,creator_id,pool_id,title,description,taxonomy,price_minor,currency,turnaround_hours,revision_limit,status)
      values (${serviceId},${creator.id},${poolId},'Launch story and landing page copy','A focused launch narrative, landing page structure, and conversion-minded copy for a product people should understand quickly.','CREATE',65000,'USD',72,1,'PUBLISHED')
      on conflict (id) do nothing`;
    const [{ count }] = await tx<{ count: number }[]>`select count(*)::int as count from app.samples where creator_id=${creator.id}`;
    if (count === 0) {
      await tx`insert into app.samples (creator_id,title,url,description) values
        (${creator.id},'Product launch narrative','https://example.com/work/launch-narrative','Positioning and story system for a product launch.'),
        (${creator.id},'Conversion landing page','https://example.com/work/landing-page','Landing page copy with a clear hierarchy from problem to proof.'),
        (${creator.id},'Editorial campaign','https://example.com/work/editorial','A launch series designed to be useful before it becomes promotional.')`;
    }
  });
  console.log(`seeded local fixtures into ${target.host}/${target.database}: ${Object.keys(FIXTURE_PERSONAS).join(', ')}`);
  console.log('sign in locally with POST /api/dev/session {persona} (see src/lib/fixtures.ts)');
} finally {
  await sql.end();
}
