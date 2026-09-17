import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { logError } from '@/lib/log';

/** For uptime monitoring: 200 when the app can reach its database, 503 when it cannot. Says nothing else. */
export async function GET() {
  try {
    await sql`select 1`;
    return NextResponse.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    logError('health check failed', error);
    return NextResponse.json({ ok: false }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
}
