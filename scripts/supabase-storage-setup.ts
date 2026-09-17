/**
 * Creates or updates the private Supabase Storage buckets a deployment needs (launch runbook 11). Every bucket is private;
 * each gets the size and type limits of the uploads it takes, from src/modules/storage/policy.ts.
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVER_SECRET_KEY from the process environment only, and prints bucket names
 * and outcomes, never the URL or the key. Usage: tsx scripts/supabase-storage-setup.ts [--dry-run]
 */
import { bucketRules } from '../src/modules/storage/policy';

const dryRun = process.argv.includes('--dry-run');
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVER_SECRET_KEY;
const rules = bucketRules();

if (dryRun) {
  for (const [bucket, rule] of Object.entries(rules)) console.log(`${bucket} | private | ${Math.round(rule.maxBytes / 1024 / 1024)} MB | ${rule.mimeTypes.join(', ')}`);
} else if (!url || !key) {
  console.error('FAIL | set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVER_SECRET_KEY in the environment');
  process.exitCode = 1;
} else {
  const base = `${new URL(url).origin}/storage/v1`;
  const headers = { authorization: `Bearer ${key}`, apikey: key, 'content-type': 'application/json' };
  for (const [bucket, rule] of Object.entries(rules)) {
    const body = JSON.stringify({ id: bucket, name: bucket, public: false, file_size_limit: rule.maxBytes, allowed_mime_types: rule.mimeTypes });
    try {
      const created = await fetch(`${base}/bucket`, { method: 'POST', headers, body });
      if (created.ok) {
        console.log(`${bucket} | created`);
        continue;
      }
      const updated = await fetch(`${base}/bucket/${bucket}`, { method: 'PUT', headers, body });
      console.log(`${bucket} | ${updated.ok ? 'updated' : `FAIL (${created.status}/${updated.status})`}`);
      if (!updated.ok) process.exitCode = 1;
    } catch {
      // Error objects can carry the request URL; report the bucket only.
      console.log(`${bucket} | FAIL (unreachable)`);
      process.exitCode = 1;
    }
  }
}
