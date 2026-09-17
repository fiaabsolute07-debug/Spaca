import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { xMode } from '@/modules/x/provider';

const COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f97316', '#14b8a6', '#22c55e', '#eab308', '#6366f1'];

/** Sandbox X profile photo: initials on a colour made from the username. 404 unless the local X sandbox is on. */
export async function GET(_request: Request, context: { params: Promise<{ username: string }> }) {
  if (process.env.NODE_ENV === 'production' || xMode() !== 'mock') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const { username } = await context.params;
  if (!/^[A-Za-z0-9_]{1,15}$/.test(username)) return new NextResponse(null, { status: 404 });
  const digest = createHash('sha256').update(username.toLowerCase()).digest();
  const color = COLORS[digest[0]! % COLORS.length]!;
  const initials = username.split('_').filter(Boolean).map((part) => part[0]!.toUpperCase()).join('').slice(0, 2) || username[0]!.toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="${color}"/><text x="200" y="200" dy="0.35em" text-anchor="middle" font-family="Arial, sans-serif" font-size="150" font-weight="700" fill="#ffffff">${initials}</text></svg>`;
  return new NextResponse(svg, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' } });
}
