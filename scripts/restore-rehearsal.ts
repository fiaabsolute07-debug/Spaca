/**
 * OPS-02 restore rehearsal on the local embedded PostgreSQL (never production, never a remote host).
 *
 * 1. Opens a REPEATABLE READ snapshot on the source, records obligations inside it and backs up exactly that snapshot
 *    (scripts/lib/logical-backup.ts: migrations + binary COPY per table + manifest with hashes).
 * 2. Creates a new isolated database `creator_marketplace_restore_<utc>`, builds the schema with the normal migrations
 *    and loads the backup.
 * 3. Compares the restored obligations with the source snapshot and checks the hard invariants.
 * 4. Replays every processed webhook with the application code against the restored database and proves nothing changes.
 * 5. Drops the restored database and the dump (keep them with --keep).
 *
 * Usage: tsx scripts/restore-rehearsal.ts [--source creator_marketplace] [--storage-root .local/storage] [--keep] [--inject-fault]
 * `--inject-fault` deletes one ledger entry from the restored copy before verification, to prove the checks catch it.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { backupObjects, loadBackup, restoreObjects, writeBackup } from './lib/logical-backup';
import { OBLIGATION_QUERIES, dueJobWorkQuery } from './lib/restore-obligations';
import { assertLocalDatabaseTarget } from '../src/lib/fixtures';

if (process.env.NODE_ENV === 'production') throw new Error('The restore rehearsal is local only');
const args = process.argv.slice(2);
const source = args.includes('--source') ? args[args.indexOf('--source') + 1]! : 'creator_marketplace';
const keep = args.includes('--keep');
const injectFault = args.includes('--inject-fault');
const storageRoot = args.includes('--storage-root') ? args[args.indexOf('--storage-root') + 1]! : '.local/storage';
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(source)) throw new Error('Invalid source database name');
const HOST = '127.0.0.1';
const PORT = '55432';
const PASSWORD = 'local_dev_only';
const adminUrl = (db: string) => `postgres://postgres:${PASSWORD}@${HOST}:${PORT}/${db}`;
// FND-07: refuse production/staging environments before touching any database.
assertLocalDatabaseTarget(adminUrl(source));

function run(command: string, commandArgs: string[], env: Record<string, string> = {}) {
  const started = performance.now();
  const result = spawnSync(command, commandArgs, { env: { ...process.env, PGPASSWORD: PASSWORD, ...env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command.split('/').pop()} failed: ${result.stderr || result.stdout}`);
  return { ms: Math.round(performance.now() - started), stdout: result.stdout };
}

type Snapshot = Record<string, unknown>;
async function obligations(db: postgres.Sql | postgres.TransactionSql): Promise<Snapshot> {
  const out: Snapshot = {};
  for (const [name, query] of Object.entries(OBLIGATION_QUERIES)) out[name] = (await db.unsafe(query)).map((row) => ({ ...row }));
  return out;
}

const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
const target = `creator_marketplace_restore_${stamp}`;
const work = mkdtempSync(join(tmpdir(), 'spaca-restore-'));
const report: { step: string; ms?: number; detail: string }[] = [];
const failures: string[] = [];
const admin = postgres(adminUrl('postgres'), { max: 1 });
const sourceSql = postgres(adminUrl(source), { max: 2 });
let restored: postgres.Sql | null = null;

try {
  // 1. One consistent snapshot for both the recorded obligations and the dump.
  const reserved = await sourceSql.reserve();
  let sourceObligations: Snapshot;
  let asOf = '';
  let sourceDueWork: Record<string, unknown>[] = [];
  let objects: Awaited<ReturnType<typeof backupObjects>>;
  const totalStarted = performance.now();
  try {
    await reserved.unsafe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    sourceObligations = await obligations(reserved);
    const [{ as_of }] = await reserved.unsafe(`select now()::text as as_of`);
    asOf = String(as_of);
    sourceDueWork = (await reserved.unsafe(dueJobWorkQuery(asOf))).map((row) => ({ ...row }));
    const started = performance.now();
    const manifest = await writeBackup(reserved, source, work);
    objects = await backupObjects(reserved, storageRoot, work);
    const bytes = manifest.tables.reduce((sum, table) => sum + table.bytes, 0);
    report.push({ step: 'backup (one snapshot)', ms: Math.round(performance.now() - started), detail: `${manifest.tables.length} tables, ${manifest.tables.reduce((sum, t) => sum + t.rows, 0)} rows, ${(bytes / 1024 / 1024).toFixed(2)} MB, ${manifest.migrations.length} migrations` });
  } finally {
    await reserved.unsafe('COMMIT').catch(() => undefined);
    reserved.release();
  }

  report.push({ step: 'backup files', detail: `${objects!.copied}/${objects!.assets} stored files copied (${(objects!.bytes / 1024).toFixed(0)} KB); missing at source ${objects!.missing_at_source}, hash mismatch at source ${objects!.hash_mismatch_at_source}` });

  // 2. Isolated restore and the normal migration runner.
  const [exists] = await admin`select 1 from pg_database where datname=${target}`;
  if (exists) throw new Error(`${target} already exists`);
  await admin.unsafe(`CREATE DATABASE ${target}`);
  const migrate = run('./node_modules/.bin/tsx', ['scripts/migrate.ts'], { DATABASE_MIGRATION_URL: adminUrl(target) });
  const applied = migrate.stdout.split('\n').filter((line) => line.startsWith('applied ')).length;
  report.push({ step: 'schema from migrations', ms: migrate.ms, detail: `${applied} migrations applied to the empty isolated database ${target}` });
  restored = postgres(adminUrl(target), { max: 1 });
  const loader = await restored.reserve();
  try {
    const started = performance.now();
    const loaded = await loadBackup(loader, work);
    report.push({ step: 'load backup', ms: Math.round(performance.now() - started), detail: `${loaded.tables} tables, ${loaded.rows} rows verified against the manifest` });
  } finally {
    loader.release();
  }

  if (injectFault) {
    await restored.begin(async (tx) => {
      await tx.unsafe('set local session_replication_role = replica');
      await tx.unsafe('delete from app.ledger_entries where id = (select id from app.ledger_entries order by id limit 1)');
    });
    report.push({ step: 'inject fault', detail: 'deleted one ledger entry from the restored copy (self-test)' });
  }

  const files = await restoreObjects(restored, work, join(work, 'restored-storage'));
  report.push({ step: 'restore files', detail: `${files.verified}/${files.restored} files restored to an isolated storage root and matched to their restored asset rows` });
  failures.push(...files.failures);

  // 3. Obligations and invariants.
  const verifyStarted = performance.now();
  const restoredObligations = await obligations(restored);
  for (const name of Object.keys(OBLIGATION_QUERIES)) {
    if (JSON.stringify(sourceObligations[name]) !== JSON.stringify(restoredObligations[name])) failures.push(`${name} differs between the source snapshot and the restore`);
  }
  const restoredDueWork = (await restored.unsafe(dueJobWorkQuery(asOf))).map((row) => ({ ...row }));
  if (JSON.stringify(restoredDueWork) !== JSON.stringify(sourceDueWork)) failures.push('job work due at the backup instant differs between the source and the restore');
  const hard = restoredObligations.hard_invariants as { check: string; violations: number }[];
  for (const { check, violations } of hard) if (Number(violations) !== 0) failures.push(`${check}: ${violations} violation(s) in the restore`);
  report.push({ step: 'verify obligations', ms: Math.round(performance.now() - verifyStarted), detail: `${Object.keys(OBLIGATION_QUERIES).length} obligation sets compared; ${hard.length} hard invariants checked` });

  // 4. Replay processed provider facts with the application code, as the app's own database role.
  const replay = run('./node_modules/.bin/tsx', ['scripts/lib/restore-replay.ts'], {
    DATABASE_URL: `postgres://app_server:${PASSWORD}@${HOST}:${PORT}/${target}`, RESTORE_REPLAY_TARGET: target,
  });
  const replayed = JSON.parse(replay.stdout.trim().split('\n').at(-1)!) as { events: number; outcomes: Record<string, number>; changed: string[] };
  report.push({ step: 'replay processed webhooks', ms: replay.ms, detail: `${replayed.events} events → ${JSON.stringify(replayed.outcomes)}; changed: ${replayed.changed.length ? replayed.changed.join(', ') : 'nothing'}` });
  if (replayed.changed.length) failures.push(`replay changed ${replayed.changed.join(', ')}`);
  if (Object.keys(replayed.outcomes).some((outcome) => outcome !== 'ALREADY_PROCESSED')) failures.push(`replay applied facts again: ${JSON.stringify(replayed.outcomes)}`);

  report.push({ step: 'total (dump → verified restore)', ms: Math.round(performance.now() - totalStarted), detail: 'local measured recovery time for this dataset' });
  const counts = sourceObligations.table_counts as { table: string; rows: number }[];
  console.log(`\nOPS-02 restore rehearsal: ${source} → ${target}`);
  console.table(report);
  console.table(counts);
  console.table(hard);
  console.log(`Jobs dry-run: work due as of the backup instant ${asOf} (not executed; reconcile before starting jobs)`);
  console.table(restoredDueWork);
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  await restored?.end();
  await sourceSql.end();
  if (!keep) {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${target}`).catch((error) => failures.push(`could not drop ${target}: ${String(error)}`));
    rmSync(work, { recursive: true, force: true });
  } else {
    console.log(`kept ${target} and the backup in ${work}`);
  }
  await admin.end();
}

console.log(failures.length ? `RESULT: FAILED\n- ${failures.join('\n- ')}` : 'RESULT: restore verified — obligations conserved, invariants hold, replay is a no-op');
process.exitCode = failures.length ? 1 : 0;
