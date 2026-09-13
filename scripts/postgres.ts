import EmbeddedPostgres from 'embedded-postgres';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';

if (process.env.NODE_ENV === 'production') throw new Error('Embedded PostgreSQL is local development only');
const directory = resolve('.local/postgres');
const command = process.argv[2];
if (command === 'stop') {
  const pidFile = resolve(directory, 'postmaster.pid');
  if (!existsSync(pidFile)) { console.log('Local PostgreSQL is stopped.'); process.exit(0); }
  const lines = readFileSync(pidFile,'utf8').split('\n');
  if (lines[1] !== directory || lines[3] !== '55432') throw new Error('Refusing to stop a different PostgreSQL instance');
  const pid = Number(lines[0]);
  if (!Number.isSafeInteger(pid) || pid < 2) throw new Error('Invalid PostgreSQL PID');
  process.kill(pid, 'SIGINT');
  console.log('Sent fast shutdown to local PostgreSQL; data is retained.');
} else if (command === 'start') {
  const pg = new EmbeddedPostgres({ databaseDir: directory, user: 'postgres', password: 'local_dev_only', port: 55432,
    persistent: true, createPostgresUser: false, authMethod: 'scram-sha-256',
    // The managed runner blocks SysV shared-memory segments. mmap keeps the
    // local embedded instance real PostgreSQL while remaining sandbox-safe.
    initdbFlags: ['-c','shared_memory_type=mmap','-c','dynamic_shared_memory_type=mmap'],
    // TCP only: a socket under .local/postgres exceeds the 103-byte macOS socket path limit in deep checkouts.
    postgresFlags: ['-h','127.0.0.1','-c','unix_socket_directories=','-c','shared_memory_type=mmap','-c','dynamic_shared_memory_type=mmap'],
  });
  if (!existsSync(resolve(directory,'PG_VERSION'))) await pg.initialise();
  await pg.start();
  const admin = postgres('postgres://postgres:local_dev_only@127.0.0.1:55432/postgres');
  try {
    const found = await admin`select 1 from pg_database where datname='creator_marketplace'`;
    if (!found.length) await admin.unsafe('CREATE DATABASE creator_marketplace');
  } finally { await admin.end(); }
  console.log('Local PostgreSQL ready at 127.0.0.1:55432. Keep this process running.');
  const shutdown = async () => { await pg.stop(); process.exit(0); };
  process.once('SIGINT',shutdown);
  process.once('SIGTERM',shutdown);
} else throw new Error('Usage: tsx scripts/postgres.ts start|stop');
