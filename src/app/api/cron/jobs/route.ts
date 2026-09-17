import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { runJobsIsolated } from '@/modules/jobs';

/** A run can take a while when many deadlines fall together; the host may cap it lower. */
export const maxDuration = 300;

const matches = (given: string, expected: string) => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * The deployed scheduler's entry (Vercel Cron, see vercel.json): runs every durable job once. The caller must send
 * `Authorization: Bearer <CRON_SECRET>`; without a configured secret the route does not exist. The answer carries job
 * names and counts only.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET ?? '';
  if (secret.length < 32) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!matches(request.headers.get('authorization') ?? '', `Bearer ${secret}`)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const reports = await runJobsIsolated();
  const failed = reports.filter((report) => 'failed' in report).length;
  return NextResponse.json({ reports, failed }, { status: failed ? 500 : 200, headers: { 'cache-control': 'no-store' } });
}
