/** Shared JSON envelope for non-form API routes (assets, wallets, chain deposits): same-origin, session, §13.1 status codes. */
import { NextResponse } from 'next/server';
import { getActor, isSameOrigin, type Actor } from '@/lib/auth';
import { CommandError, statusForCode } from '@/lib/commands';

export async function readInput(request: Request): Promise<Record<string, string>> {
  const type = request.headers.get('content-type') ?? '';
  if (type.includes('application/json')) {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    return Object.fromEntries(Object.entries(body ?? {}).map(([key, value]) => [key, String(value ?? '')]));
  }
  if (type.includes('form')) return Object.fromEntries([...(await request.formData()).entries()].map(([key, value]) => [key, String(value)]));
  return {};
}

export async function jsonRoute(request: Request, run: (actor: Actor | null) => Promise<unknown>, options: { anonymous?: boolean } = {}) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'Origin not allowed' }, { status: 403 });
  const actor = await getActor();
  if (!actor && !options.anonymous) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  try {
    return NextResponse.json(await run(actor), { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (error instanceof CommandError) return NextResponse.json({ error: error.message, code: error.code }, { status: statusForCode(error.code), headers: { 'cache-control': 'no-store' } });
    console.error('json route failed', error instanceof Error ? error.name : 'unknown');
    return NextResponse.json({ error: 'The request could not be completed' }, { status: 500 });
  }
}
