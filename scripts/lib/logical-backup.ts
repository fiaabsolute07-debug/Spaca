/**
 * Repo-native logical backup for the local restore rehearsal (OPS-02). The embedded PostgreSQL ships no pg_dump, so a
 * backup is: the schema as the ordered migrations, plus every `app` table's rows as binary COPY files taken inside one
 * REPEATABLE READ snapshot, with a manifest of columns, row counts and SHA-256 hashes. Restoring runs the migrations,
 * then loads the rows with triggers suspended (they already passed their guards when first written), re-adds NOT VALID
 * constraints after the data as pg_dump does (historical rows predate them), and resets sequences. Production backups
 * should use the database provider's backups/PITR or pg_dump instead.
 */
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type postgres from 'postgres';

export type BackupManifest = {
  created_at: string;
  source: string;
  migrations: string[];
  tables: { name: string; columns: string[]; rows: number; bytes: number; sha256: string }[];
};

const ident = (name: string) => name.split('.').map((part) => `"${part.replaceAll('"', '""')}"`).join('.');

/**
 * Drains a COPY TO STDOUT stream into a file with synchronous writes. Piping it with backpressure stalled on a reserved
 * connection once a table's data outgrew the stream buffer, so the data is taken as it arrives instead.
 */
async function copyToFile(stream: NodeJS.ReadableStream, file: string): Promise<void> {
  const fd = openSync(file, 'w');
  try {
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => writeSync(fd, chunk));
      stream.on('end', () => resolve());
      stream.on('error', reject);
    });
  } finally {
    closeSync(fd);
  }
}

/** A COPY that the server refused can leave its stream open; fail loudly instead of waiting forever. */
function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms / 1000}s`)), ms); })])
    .finally(() => clearTimeout(timer));
}

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

/** Writes the backup for the snapshot `db` is already in (a REPEATABLE READ transaction on a reserved connection). */
export async function writeBackup(db: postgres.ReservedSql, source: string, dir: string): Promise<BackupManifest> {
  const migrations = (await db.unsafe('select id from public.schema_migrations order by id')).map((row) => String(row.id));
  const tables = (await db.unsafe(`select schemaname || '.' || tablename as name from pg_tables where schemaname='app' order by tablename`)).map((row) => String(row.name));
  const manifest: BackupManifest = { created_at: new Date().toISOString(), source, migrations, tables: [] };
  for (const name of tables) {
    const [schema, table] = name.split('.');
    const columns = (await db.unsafe(`select column_name from information_schema.columns where table_schema=$1 and table_name=$2 and is_generated='NEVER' order by ordinal_position`, [schema!, table!]))
      .map((row) => String(row.column_name));
    const [{ rows }] = await db.unsafe(`select count(*)::int as rows from ${ident(name)}`);
    const file = join(dir, `${name}.copy`);
    const stream = await db.unsafe(`copy ${ident(name)} (${columns.map((c) => `"${c}"`).join(',')}) to stdout (format binary)`).readable();
    await copyToFile(stream, file);
    manifest.tables.push({ name, columns, rows: Number(rows), bytes: statSync(file).size, sha256: await sha256(file) });
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

/** Loads a backup into a database whose schema was just created by the migrations. Refuses a schema mismatch. */
export async function loadBackup(db: postgres.ReservedSql, dir: string): Promise<{ tables: number; rows: number }> {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as BackupManifest;
  const migrations = (await db.unsafe('select id from public.schema_migrations order by id')).map((row) => String(row.id));
  if (JSON.stringify(migrations) !== JSON.stringify(manifest.migrations)) throw new Error('The target schema is at different migrations than the backup');
  for (const table of manifest.tables) {
    if ((await sha256(join(dir, `${table.name}.copy`))) !== table.sha256) throw new Error(`Backup file for ${table.name} does not match its hash`);
  }
  await db.unsafe('begin');
  try {
    // Rows were validated by their triggers when first written; replaying them must not re-run effects or guards.
    await db.unsafe('set local session_replication_role = replica');
    await db.unsafe(`truncate ${manifest.tables.map((t) => ident(t.name)).join(', ')} restart identity cascade`);
    // NOT VALID constraints exempt rows written before they existed; COPY would enforce them, so they return after the data.
    const notValid = await db.unsafe(`select conrelid::regclass::text as tbl, conname, pg_get_constraintdef(oid) as def from pg_constraint
      where connamespace='app'::regnamespace and not convalidated order by conname`);
    for (const constraint of notValid) await db.unsafe(`alter table ${String(constraint.tbl)} drop constraint ${ident(String(constraint.conname))}`);
    let rows = 0;
    for (const table of manifest.tables) {
      const [schema, name] = table.name.split('.');
      const columns = (await db.unsafe(`select column_name from information_schema.columns where table_schema=$1 and table_name=$2 and is_generated='NEVER' order by ordinal_position`, [schema!, name!]))
        .map((row) => String(row.column_name));
      if (JSON.stringify(columns) !== JSON.stringify(table.columns)) throw new Error(`Columns of ${table.name} differ from the backup`);
      const sink = await db.unsafe(`copy ${ident(table.name)} (${columns.map((c) => `"${c}"`).join(',')}) from stdin (format binary)`).writable();
      await withTimeout(pipeline(createReadStream(join(dir, `${table.name}.copy`)), sink), 120_000, `loading ${table.name}`);
      const [{ count }] = await db.unsafe(`select count(*)::int as count from ${ident(table.name)}`);
      if (Number(count) !== table.rows) throw new Error(`${table.name}: loaded ${count} rows, backup has ${table.rows}`);
      rows += table.rows;
    }
    for (const constraint of notValid) await db.unsafe(`alter table ${String(constraint.tbl)} add constraint ${ident(String(constraint.conname))} ${String(constraint.def)}`);
    const sequences = await db.unsafe(`select table_schema || '.' || table_name as name, column_name from information_schema.columns
      where table_schema='app' and column_default like 'nextval(%'`);
    for (const sequence of sequences) {
      await db.unsafe(`select setval(pg_get_serial_sequence($1, $2), coalesce(max(${ident(String(sequence.column_name))}), 1), max(${ident(String(sequence.column_name))}) is not null) from ${ident(String(sequence.name))}`,
        [String(sequence.name), String(sequence.column_name)]);
    }
    await db.unsafe('commit');
    return { tables: manifest.tables.length, rows };
  } catch (error) {
    await db.unsafe('rollback').catch(() => undefined);
    throw error;
  }
}

export type ObjectReport = { assets: number; copied: number; missing_at_source: number; hash_mismatch_at_source: number; bytes: number };

const objectPath = (root: string, bucket: string, key: string) => {
  const base = resolve(root, bucket);
  const path = resolve(base, key);
  if (!path.startsWith(base + sep)) throw new Error(`Object key escapes its bucket: ${bucket}/${key}`);
  return path;
};

/** Copies the stored file of every non-deleted asset in the snapshot, checking it against the recorded SHA-256. */
export async function backupObjects(db: postgres.ReservedSql, storageRoot: string, dir: string): Promise<ObjectReport> {
  const assets = await db.unsafe(`select bucket, object_key, sha256 from app.storage_assets where lifecycle_state <> 'DELETED' order by bucket, object_key`);
  const report: ObjectReport = { assets: assets.length, copied: 0, missing_at_source: 0, hash_mismatch_at_source: 0, bytes: 0 };
  const copied: { bucket: string; key: string; sha256: string }[] = [];
  for (const asset of assets) {
    const source = objectPath(storageRoot, String(asset.bucket), String(asset.object_key));
    if (!existsSync(source)) { report.missing_at_source += 1; continue; }
    if ((await sha256(source)) !== String(asset.sha256)) { report.hash_mismatch_at_source += 1; continue; }
    const target = objectPath(join(dir, 'objects'), String(asset.bucket), String(asset.object_key));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    report.copied += 1;
    report.bytes += statSync(target).size;
    copied.push({ bucket: String(asset.bucket), key: String(asset.object_key), sha256: String(asset.sha256) });
  }
  writeFileSync(join(dir, 'objects.json'), JSON.stringify(copied, null, 2));
  return report;
}

/** Restores the backed-up files into an isolated storage root and verifies each against the restored database rows. */
export async function restoreObjects(db: postgres.Sql, dir: string, targetRoot: string): Promise<{ restored: number; verified: number; failures: string[] }> {
  const copied = JSON.parse(readFileSync(join(dir, 'objects.json'), 'utf8')) as { bucket: string; key: string; sha256: string }[];
  const failures: string[] = [];
  let verified = 0;
  for (const object of copied) {
    const target = objectPath(targetRoot, object.bucket, object.key);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(objectPath(join(dir, 'objects'), object.bucket, object.key), target);
    const [row] = await db.unsafe(`select sha256 from app.storage_assets where bucket=$1 and object_key=$2 and lifecycle_state <> 'DELETED'`, [object.bucket, object.key]);
    if (!row) failures.push(`${object.bucket}/${object.key}: no asset row in the restore`);
    else if ((await sha256(target)) !== String(row.sha256)) failures.push(`${object.bucket}/${object.key}: restored file hash differs`);
    else verified += 1;
  }
  return { restored: copied.length, verified, failures };
}
