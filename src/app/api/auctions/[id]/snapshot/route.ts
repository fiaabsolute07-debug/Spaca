import { NextResponse } from 'next/server';
import { getActor } from '@/lib/auth';
import { getAuctionData } from '@/lib/read-model';

/** §10.6 polling snapshot (server time, version, standing). Read-only; accepted bids come only from commands. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const data = await getAuctionData(await getActor(), id);
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(data, { headers: { 'cache-control': 'no-store' } });
}
