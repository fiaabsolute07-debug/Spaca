/**
 * SEC-11 secret scan. Reports file:line and a pattern label, never the matched text.
 *
 * 1. Tracked files (git ls-files): real-looking credentials of any kind.
 * 2. Client bundles (default `.next/static`, or `--client-dir <dir>`): the same credentials plus anything that must never
 *    reach a browser — server-only environment variable names, local fixture secrets and database URLs.
 * 3. Optional log file (`--log <file>`): credentials plus private payload markers passed with `--private <text>`.
 *
 * Usage: tsx scripts/secret-scan.ts [--client-dir .next/static] [--log file] [--private text ...]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

const args = process.argv.slice(2);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const clientDir = option('--client-dir') ?? '.next/static';
const logFile = option('--log');
const privateMarkers = args.flatMap((arg, index) => (arg === '--private' && args[index + 1] ? [args[index + 1]!] : []));

const CREDENTIALS: [string, RegExp][] = [
  ['private key block', /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/],
  ['Stripe secret key', /\bsk_(?:live|test)_[A-Za-z0-9]{16,}/],
  ['Stripe webhook secret', /\bwhsec_[A-Za-z0-9]{24,}\b/],
  ['Supabase secret key', /\bsb_secret_[A-Za-z0-9_-]{16,}/],
  ['Resend API key', /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}/],
  ['JSON web token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['remote database URL with password', /postgres(?:ql)?:\/\/[^:\s'"`/]+:[^@\s'"`]+@(?!127\.0\.0\.1|localhost|db\.example\.com|db\.market\.example)[A-Za-z0-9.-]+/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36}\b/],
];

const CLIENT_FORBIDDEN: [string, RegExp][] = [
  ['server-only environment variable', /\b(?:STORAGE_SIGNING_SECRET|NOTICE_SIGNING_SECRET|MOCK_PAYMENT_WEBHOOK_SECRET|RELEASE_SIGNER_PRIVATE_KEY|DATABASE_URL|DATABASE_MIGRATION_URL|VIEW_HASH_SALT|RESEND_API_KEY|SUPABASE_SERVICE_ROLE_KEY|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|WAITLIST_IP_SALT|WAITLIST_DATABASE_URL)\b/],
  ['local fixture secret', /local_dev_only|whsec_local_dev_only_fixture|local_dev_only_notice_signing_fixture/],
  ['database URL', /postgres(?:ql)?:\/\/[^\s'"`]+/],
  ['private key next to its name', /PRIVATE_KEY[^\n]{0,40}0x[0-9a-fA-F]{64}/],
];

type Finding = { file: string; line: number; label: string };
const BINARY = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.mp4', '.woff', '.woff2', '.ttf', '.pdf', '.zip']);
/** Files whose job is to contain secret-shaped strings: the unit tests of the secret detectors themselves. */
const DETECTOR_FIXTURES = new Set(['tests/unit/release-rules.test.ts']);

function scanText(file: string, content: string, patterns: [string, RegExp][], findings: Finding[]) {
  content.split(/\r?\n/).forEach((text, index) => {
    for (const [label, pattern] of patterns) if (pattern.test(text)) findings.push({ file, line: index + 1, label });
  });
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const findings: Finding[] = [];
const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean)
  .filter((file) => !BINARY.has(extname(file).toLowerCase()) && file !== 'pnpm-lock.yaml' && !DETECTOR_FIXTURES.has(file) && existsSync(file));
for (const file of tracked) scanText(file, readFileSync(file, 'utf8'), CREDENTIALS, findings);

let clientFiles = 0;
if (existsSync(clientDir)) {
  for (const file of walk(clientDir).filter((path) => ['.js', '.css', '.map', '.json', '.html'].includes(extname(path)))) {
    clientFiles += 1;
    scanText(file, readFileSync(file, 'utf8'), [...CREDENTIALS, ...CLIENT_FORBIDDEN], findings);
  }
}

let logLines = 0;
if (logFile) {
  const content = readFileSync(logFile, 'utf8');
  logLines = content.split('\n').length;
  const markers: [string, RegExp][] = privateMarkers.map((marker) => ['private payload marker', new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))]);
  scanText(logFile, content, [...CREDENTIALS, ...markers], findings);
}

console.log(`secret scan: ${tracked.length} tracked files, ${clientFiles} client bundle files in ${clientDir}${existsSync(clientDir) ? '' : ' (missing)'}${logFile ? `, ${logLines} log lines` : ''}`);
for (const finding of findings) console.log(`FINDING | ${finding.file}:${finding.line} | ${finding.label}`);
if (!existsSync(clientDir)) console.log('NOTE | no client bundle directory; build or run the app first to scan bundles');
console.log(findings.length ? `RESULT: ${findings.length} finding(s)` : 'RESULT: no secrets or server-only values found');
process.exitCode = findings.length ? 1 : 0;
