/** GET envelope for discovery: 400 for invalid input, 503 (retryable, no items) when the database is unavailable (DSC-02). */
import { NextResponse } from 'next/server';
import { CommandError, statusForCode } from '@/lib/commands';

export async function discoveryRoute(run: () => Promise<unknown>) {
  try {
    return NextResponse.json(await run(), { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (error instanceof CommandError) return NextResponse.json({ error: error.message, code: error.code }, { status: statusForCode(error.code) });
    console.error('discovery failed', error instanceof Error ? error.name : 'unknown');
    return NextResponse.json({ error: 'Search is temporarily unavailable. Try again shortly.', code: 'TEMPORARILY_UNAVAILABLE', retryable: true }, { status: 503, headers: { 'retry-after': '5' } });
  }
}
