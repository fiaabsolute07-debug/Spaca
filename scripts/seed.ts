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
const LOCAL_DEVNET = { chainId: 1337001, settlement: '0x5e7713e00000000000000000000000000000c0de', usdcToken: '0x05dc000000000000000000000000000000000006' };
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
      for (const role of 'grants' in persona ? persona.grants : []) {
        await tx`insert into app.user_roles (user_id,role,granted_reason) values (${persona.id},${role},'Local fixture bootstrap grant (seed.ts)')
          on conflict do nothing`;
      }
      if ('handle' in persona && persona.handle) {
        await tx`insert into app.profiles (user_id,handle,bio,niche,avatar_color)
          values (${persona.id},${persona.handle},${`${persona.displayName} — local test fixture profile.`},'Local fixture','#dce1ed')
          on conflict (user_id) do nothing`;
      }
    }
    await tx`update app.profiles set bio='Brand stories, launch writing, and editorial systems for thoughtful teams.',niche='Launch writing',avatar_color='#e7bda6',social_url='https://example.com/ari'
      where user_id=${creator.id}`;
    await tx`insert into app.creator_workloads (creator_id) values (${creator.id}) on conflict (creator_id) do nothing`;
    const [existingService] = await tx<{ id: string }[]>`select id from app.services where id=${serviceId}`;
    if (!existingService) {
      await tx`insert into app.services (id,creator_id,title,description,taxonomy,price_minor,currency,turnaround_hours,revision_limit,status)
        values (${serviceId},${creator.id},'Launch story and landing page copy','A focused launch narrative, landing page structure, and conversion-minded copy for a product people should understand quickly.','CREATE',65000,'USD',72,1,'DRAFT')`;
      const [version] = await tx<{ id: string }[]>`insert into app.service_versions (service_id,version,title,description,taxonomy,price_minor,currency,turnaround_hours,revision_limit,units_per_order,created_by)
        select id,1,title,description,taxonomy,price_minor,currency,turnaround_hours,revision_limit,units_per_order,creator_id from app.services where id=${serviceId} returning id`;
      await tx`update app.services set status='PUBLISHED',published_version_id=${version!.id} where id=${serviceId}`;
    }
    const [{ count }] = await tx<{ count: number }[]>`select count(*)::int as count from app.samples where creator_id=${creator.id}`;
    if (count === 0) {
      await tx`insert into app.samples (creator_id,title,url,description) values
        (${creator.id},'Product launch narrative','https://example.com/work/launch-narrative','Positioning and story system for a product launch.'),
        (${creator.id},'Conversion landing page','https://example.com/work/landing-page','Landing page copy with a clear hierarchy from problem to proof.'),
        (${creator.id},'Editorial campaign','https://example.com/work/editorial','A launch series designed to be useful before it becomes promotional.')`;
    }
    await tx`insert into app.service_samples (service_id,sample_id,creator_id)
      select ${serviceId}, id, creator_id from app.samples where creator_id=${creator.id} on conflict do nothing`;
    // Simulated local devnet (no real chain). The 18-decimal native USDC and the 6-decimal token interface are separate
    // registry entries; an intent names one, and an intent is credited at most once, so one balance is never double-counted.
    // Crypto checkout stays behind CRYPTO_CHECKOUT_ENABLED, which an admin turns on with an audit reason.
    await tx`insert into app.chain_networks (chain_id,name,mode,settlement_address,finality_confirmations,enabled,verification_note)
      values (${LOCAL_DEVNET.chainId},'Local devnet (simulated)','LOCAL',${LOCAL_DEVNET.settlement},3,true,'In-process simulator for local development and tests; not a real chain')
      on conflict (chain_id) do nothing`;
    await tx`insert into app.chain_assets (chain_id,symbol,kind,contract_address,decimals,balance_key,usd_pegged,transfer_behavior,allowlisted)
      values (${LOCAL_DEVNET.chainId},'USDC','NATIVE',null,18,'USDC',true,'STANDARD',true),
             (${LOCAL_DEVNET.chainId},'USDC','ERC20',${LOCAL_DEVNET.usdcToken},6,'USDC-ERC20',true,'STANDARD',true)
      on conflict do nothing`;
  });
  console.log(`seeded local fixtures into ${target.host}/${target.database}: ${Object.keys(FIXTURE_PERSONAS).join(', ')}`);
  console.log('sign in locally with POST /api/dev/session {persona} (see src/lib/fixtures.ts)');
} finally {
  await sql.end();
}
