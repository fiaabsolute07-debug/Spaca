export type EnvironmentTarget = 'local' | 'staging' | 'production';
export type Environment = Readonly<Record<string, string | undefined>>;
export type EnvironmentRow = {
  name: string;
  status: 'OK' | 'MISSING' | 'INVALID';
  presence: 'set' | 'unset';
  host?: 'loopback' | 'remote';
};
export type EnvironmentReport = { ok: boolean; rows: EnvironmentRow[] };

export function isEnvironmentTarget(value: string): value is EnvironmentTarget {
  return ['local', 'staging', 'production'].includes(value);
}

function parseUrl(value: string): URL | undefined {
  try { return new URL(value); } catch { return undefined; }
}

function hostClass(url: URL): 'loopback' | 'remote' {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '::' ||
    host === '0.0.0.0' || /^127\./.test(host) || /^::ffff:(?:127\.|7f[0-9a-f]{2}:)/.test(host)
    ? 'loopback' : 'remote';
}

/** No IO, logging, or raw values in the result (including malformed URLs and unknown keys). */
export function checkEnvironment(env: Environment, target: EnvironmentTarget): EnvironmentReport {
  const rows: EnvironmentRow[] = [];
  const deployed = target !== 'local';
  const production = target === 'production';
  const live = env.LIVE_PAYMENTS_ENABLED === 'true';
  const add = (name: string, required = false, valid: (value: string) => boolean = () => true, url = false) => {
    const value = env[name];
    const present = value !== undefined && value.trim() !== '';
    const parsed = url && present ? parseUrl(value!) : undefined;
    rows.push({ name, status: !present ? (required ? 'MISSING' : value === undefined ? 'OK' : 'INVALID')
      : valid(value!) ? 'OK' : 'INVALID', presence: present ? 'set' : 'unset',
    ...(parsed?.hostname ? { host: hostClass(parsed) } : {}) });
  };
  const oneOf = (...values: string[]) => (value: string) => values.includes(value);
  const webUrl = (remote: boolean) => (value: string) => {
    const url = parseUrl(value);
    return !!url?.hostname && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
      (!remote || (url.protocol === 'https:' && hostClass(url) === 'remote'));
  };
  const databaseUrl = (value: string) => {
    const url = parseUrl(value);
    return !!url?.hostname && ['postgres:', 'postgresql:'].includes(url.protocol) && url.pathname.length > 1 &&
      (!production || hostClass(url) === 'remote') && !url.searchParams.has('host');
  };

  add('APP_ENV', false, (value) => value === target || (target === 'local' && value === 'test'));
  add('NODE_ENV', deployed, production ? oneOf('production') : oneOf('development', 'test', 'production'));
  add('APP_BASE_URL', deployed, webUrl(deployed), true);
  add('DATABASE_URL', deployed, databaseUrl, true);
  add('DATABASE_MIGRATION_URL', deployed, databaseUrl, true);
  add('AUTH_MODE', deployed, deployed ? oneOf('supabase') : oneOf('local', 'supabase'));
  const supabase = deployed || env.AUTH_MODE === 'supabase' || env.NODE_ENV === 'production';
  add('NEXT_PUBLIC_SUPABASE_URL', supabase, webUrl(deployed), true);
  add('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', supabase, (value) => !/^(?:sb_secret_|sk_|whsec_)/.test(value));
  // Legacy alias is read by auth.ts, but deployments must provide the canonical publishable key.
  add('NEXT_PUBLIC_SUPABASE_ANON_KEY', false, (value) => !/^(?:sb_secret_|sk_|whsec_)/.test(value));
  add('DEV_SESSIONS', deployed, deployed ? oneOf('off') : oneOf('on', 'off'));
  add('PLATFORM_FEE_BPS', false, oneOf('0'));
  add('PAYMENT_MODE', deployed || live, (value) => ['mock', 'sandbox', 'testnet', 'live'].includes(value) &&
    !(production && value === 'mock') && (live ? value === 'live' && production : value !== 'live') &&
    !(target === 'staging' && value === 'mock'));
  add('LIVE_PAYMENTS_ENABLED', deployed, oneOf('true', 'false'));
  add('PAYMENT_PROVIDER', live, (value) => ['mock', 'stripe_connect', 'arc_usdc'].includes(value) &&
    !(production && value === 'mock') && (!live || value === 'stripe_connect'));
  add('FEE_PAYER_POLICY', live, oneOf('CREATOR_AT_COST', 'PLATFORM_SUBSIDIZED'));
  // Runtime mapping: master THIRD_PARTY_FEE_POLICY -> FEE_PAYER_POLICY; alias alone is insufficient.
  add('THIRD_PARTY_FEE_POLICY', false, (value) => value === env.FEE_PAYER_POLICY);
  const stripe = live || env.PAYMENT_PROVIDER === 'stripe_connect';
  add('STRIPE_SECRET_KEY', stripe, (value) => (live ? /^sk_live_[A-Za-z0-9]+$/ : /^sk_test_[A-Za-z0-9]+$/).test(value));
  add('STRIPE_WEBHOOK_SECRET', stripe, (value) => /^whsec_[A-Za-z0-9]+$/.test(value));
  add('STRIPE_API_VERSION', stripe);
  add('MOCK_PAYMENT_WEBHOOK_SECRET');
  add('MOCK_PROVIDER_FEE_BPS', false, (value) => /^\d+$/.test(value) && Number(value) <= 1000);
  add('CHECKOUT_HOLD_MINUTES', false, (value) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0);
  add('ALLOW_REMOTE_TEST_DATABASE', false, (value) => !deployed && /^[A-Za-z0-9_]+_test$/.test(value));

  // Prepared integration contracts are optional until selected; no credential proves readiness.
  add('EMAIL_MODE', false, deployed ? (production ? oneOf('sink', 'live') : oneOf('sink', 'allowlist')) : oneOf('sink', 'allowlist'));
  const externalEmail = env.EMAIL_MODE === 'live' || env.EMAIL_MODE === 'allowlist';
  add('RESEND_API_KEY', externalEmail);
  add('EMAIL_FROM', externalEmail);
  add('EMAIL_ALLOWED_RECIPIENTS', env.EMAIL_MODE === 'allowlist');
  add('INNGEST_EVENT_KEY', !!env.INNGEST_SIGNING_KEY);
  add('INNGEST_SIGNING_KEY', !!env.INNGEST_EVENT_KEY);
  // The local filesystem adapter and its HMAC URLs are for local development only (W2-S).
  add('STORAGE_PROVIDER', deployed, deployed ? oneOf('supabase') : oneOf('local', 'supabase'));
  add('STORAGE_SIGNING_SECRET', false, (value) => !deployed && value.length >= 16);
  add('LOCAL_STORAGE_DIR', false, () => !deployed);
  // Release signing needs managed custody (KMS/multisig), not implemented; a raw key in env is local-only (W5-C2).
  add('RELEASE_SIGNER_PRIVATE_KEY', false, (value) => !deployed && /^0x[0-9a-fA-F]{64}$/.test(value));
  add('LOCAL_CHAIN', false, (value) => deployed ? value === 'off' : ['on', 'off'].includes(value));
  // Eligible-view hashing (P5-04) must use a real secret salt when deployed.
  add('VIEW_HASH_SALT', deployed, (value) => value.length >= 16);
  for (const name of ['SUPABASE_SERVER_SECRET_KEY', 'STORAGE_PUBLIC_BUCKET', 'STORAGE_PRIVATE_BUCKETS',
    'SUPPORT_CONTACT', 'POLICY_VERSION', 'WALLET_PROVIDER_CONFIG']) add(name);
  const arc = env.PAYMENT_PROVIDER === 'arc_usdc';
  add('ARC_NETWORK_MODE', arc, oneOf('testnet')); // Live Arc has no selected/verified configuration yet.
  add('ARC_CHAIN_ID', arc, (value) => /^\d+$/.test(value) && BigInt(value) > 0n);
  add('ARC_RPC_URL', arc, webUrl(deployed), true);
  for (const name of ['ARC_USDC_ASSET_CONFIG', 'ARC_SETTLEMENT_CONTRACT_ADDRESS', 'ARC_CONTRACT_VERSION']) add(name, arc);
  add('SENTRY_DSN', false, (value) => !!parseUrl(value)?.hostname, true);
  return { ok: rows.every((row) => row.status === 'OK'), rows };
}

export function formatEnvironmentReport(report: EnvironmentReport): string {
  return ['VARIABLE | STATUS | PRESENCE | HOST', ...report.rows.map((row) =>
    `${row.name} | ${row.status} | ${row.presence} | ${row.host ?? ''}`)].join('\n');
}
