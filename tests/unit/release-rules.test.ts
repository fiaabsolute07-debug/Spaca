import { describe, expect, it } from 'vitest';
import { checkClientFunding, checkDevRouteGuards, checkExampleSecrets, checkFeeConstraints, parseReleaseGates } from '../../scripts/lib/release-rules';

const file = (path: string, content: string) => ({ path, content });

describe('PAY-18 — release check keeps the platform fee at zero', () => {
  const base = file('drizzle/0001.sql', `CREATE TABLE app.orders (id uuid, platform_fee_minor bigint NOT NULL DEFAULT 0 CHECK (platform_fee_minor = 0));
    CREATE TABLE app.service_versions (id uuid, platform_fee_bps integer NOT NULL DEFAULT 0 CHECK (platform_fee_bps = 0));`);

  it('passes when both fee columns keep NOT NULL and an exact zero CHECK', () => {
    expect(checkFeeConstraints([base]).status).toBe('PASS');
  });

  it('fails on a nonzero CHECK, a missing CHECK, a dropped fee constraint or column', () => {
    expect(checkFeeConstraints([file('drizzle/0001.sql', 'CREATE TABLE app.orders (platform_fee_minor bigint NOT NULL CHECK (platform_fee_minor <= 200));')]).status).toBe('FAIL');
    expect(checkFeeConstraints([file('drizzle/0001.sql', 'CREATE TABLE app.orders (platform_fee_minor bigint NOT NULL DEFAULT 0);')]).status).toBe('FAIL');
    expect(checkFeeConstraints([base, file('drizzle/0002.sql', 'ALTER TABLE app.orders DROP CONSTRAINT orders_platform_fee_minor_check;')]).status).toBe('FAIL');
    expect(checkFeeConstraints([base, file('drizzle/0002.sql', 'ALTER TABLE app.orders DROP COLUMN platform_fee_minor;')]).status).toBe('FAIL');
  });

  it('ignores commented-out SQL', () => {
    expect(checkFeeConstraints([base, file('drizzle/0002.sql', '-- ALTER TABLE app.orders DROP COLUMN platform_fee_minor;')]).status).toBe('PASS');
  });
});

describe('PAY-06 — no client-side mark paid in source', () => {
  it('flags markPaid, funded/succeeded writes in TS and SQL SET clauses outside funding.ts', () => {
    const result = checkClientFunding([
      file('src/app/api/bad/route.ts', 'export function markPaid() {}'),
      file('src/modules/x.ts', "const patch = { payment_status: 'SUCCEEDED' };"),
      file('src/modules/y.ts', "await tx`update app.orders set status='FUNDED', version=version+1 where id=${id}`;"),
      file('src/modules/z.ts', "await tx`insert into app.orders (status,amount_minor) values ('FUNDED',1)`;"),
    ]);
    expect(result.status).toBe('FAIL');
    expect(result.findings).toHaveLength(4);
  });

  it('does not flag predicates, CASE comparisons, comments, or funding.ts itself', () => {
    expect(checkClientFunding([
      file('src/modules/jobs.ts', "const c = sql`o.status='COMPLETED' and o.payment_status='SUCCEEDED'`;"),
      file('src/modules/orders.ts', "await tx`update app.orders set status='CANCELLED',payment_status=case when payment_status='SUCCEEDED' then 'REFUND_PENDING' else payment_status end where id=${id}`;"),
      file('src/app/x.tsx', "if (order.status === 'FUNDED') show(); // markPaid is not allowed"),
      file('src/modules/payments/funding.ts', "await tx`update app.orders set status='FUNDED' where id=${id}`;"),
    ]).status).toBe('PASS');
  });
});

describe('FND-03/FND-06 — dev routes fail closed', () => {
  const guarded = "export async function POST(request: Request) {\n  if (!mockPaymentsEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 });\n  return ok();\n}";
  it('accepts handlers whose first statement rejects production/non-mock requests', () => {
    expect(checkDevRouteGuards([file('src/app/api/dev/jobs/route.ts', guarded)]).status).toBe('PASS');
    expect(checkDevRouteGuards([file('src/app/api/dev/session/route.ts',
      "export async function POST(request: Request) {\n  const url = new URL(request.url);\n  if (process.env.NODE_ENV === 'production' || !ok) {\n    return NextResponse.json({ error: 'Not found' }, { status: 404 });\n  }\n}")]).status).toBe('PASS');
  });

  it('rejects missing, late, commented or non-rejecting guards and re-exports', () => {
    const cases = [
      "export async function POST() {\n  return run();\n}",
      "export async function POST() {\n  await run();\n  if (!mockPaymentsEnabled()) return NextResponse.json({}, { status: 404 });\n}",
      "export async function POST() {\n  // if (!mockPaymentsEnabled()) return NextResponse.json({}, { status: 404 });\n  return run();\n}",
      "export async function POST() {\n  if (!mockPaymentsEnabled()) return NextResponse.json({}, { status: 200 });\n}",
      "export const POST = handler;",
    ];
    for (const content of cases) expect(checkDevRouteGuards([file('src/app/api/dev/x/route.ts', content)]).status).toBe('FAIL');
  });
});

describe('.env.example secret scan and gate parsing', () => {
  it('flags secret-looking values but allows the documented local fixture', () => {
    expect(checkExampleSecrets('MOCK_PAYMENT_WEBHOOK_SECRET=whsec_local_dev_only_fixture\nPLATFORM_FEE_BPS=0').status).toBe('PASS');
    expect(checkExampleSecrets('STRIPE_SECRET_KEY=sk_test_abc123').status).toBe('FAIL');
    expect(checkExampleSecrets('-----BEGIN PRIVATE KEY-----').status).toBe('FAIL');
    const finding = checkExampleSecrets('STRIPE_SECRET_KEY=sk_live_supersecretvalue').findings.join('\n');
    expect(finding).not.toContain('supersecretvalue');
  });

  it('reads only the status column of gate rows', () => {
    const markdown = '| Gate | Meaning | Status |\n|---|---|---|\n| G3 Usable | NOT_RUN mentioned | PARTIAL |\n| G5 Deployable | x | BLOCKED |\n| G6 | x | NOT_RUN |';
    expect(parseReleaseGates(markdown)).toEqual([{ gate: 'G5', status: 'BLOCKED' }, { gate: 'G6', status: 'NOT_RUN' }]);
  });
});
