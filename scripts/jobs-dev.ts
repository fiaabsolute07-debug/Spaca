/**
 * Local job loop (master §17.4 `jobs:dev`): POSTs the in-process dev jobs hook on an interval so the
 * mock provider, holds, reconciliation, settlements and notifications progress while `pnpm dev` runs.
 * Loopback targets only; never used for staging/production (deployments schedule src/modules/jobs).
 */
const base = process.env.JOBS_DEV_URL ?? 'http://127.0.0.1:3000';
const intervalSeconds = Number(process.env.JOBS_DEV_INTERVAL_SECONDS ?? 30);
const url = new URL('/api/dev/jobs', base);
if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) throw new Error('jobs:dev only targets a loopback dev server');
if (!Number.isInteger(intervalSeconds) || intervalSeconds < 5) throw new Error('JOBS_DEV_INTERVAL_SECONDS must be an integer >= 5');

async function tick() {
  try {
    const response = await fetch(url, { method: 'POST' });
    const body = (await response.json().catch(() => ({}))) as { reports?: { job: string; examined: number; outcomes: Record<string, number> }[] };
    const summary = (body.reports ?? []).filter((r) => r.examined > 0).map((r) => `${r.job}:${JSON.stringify(r.outcomes)}`).join(' ');
    console.log(`${new Date().toISOString()} ${response.status} ${summary || 'idle'}`);
  } catch (error) {
    console.error(`${new Date().toISOString()} jobs hook unreachable: ${(error as Error).message}`);
  }
}

await tick();
setInterval(tick, intervalSeconds * 1000);

export {};
