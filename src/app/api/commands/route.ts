/**
 * Command envelope: origin + session checks, idempotency replay (actor + command + key + input hash),
 * one transaction per command, post-commit mock webhook delivery. Domain logic lives in the
 * per-domain `commands.ts` files under `src/modules/` (registry: `src/modules/commands.ts`).
 */
import { createHash, randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getActor, isSameOrigin } from '@/lib/auth';
import { CommandError, statusForCode, type CommandResult } from '@/lib/commands';
import { sql } from '@/lib/db';
import { commandHandlers } from '@/modules/commands';
import { PaymentFlowError, deliverPendingMockWebhooks, mockPaymentsEnabled } from '@/modules/payments/funding';

const safeReturnTo = (value: string | null, fallback: string) =>
  value && value.startsWith('/') && !value.startsWith('//') && value.length < 300 ? value : fallback;

const hashInput = (input: Record<string, string>) =>
  createHash('sha256').update(JSON.stringify(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');

const valuesOf = (form: FormData) =>
  Object.fromEntries([...form.entries()].filter(([key]) => !['idempotency_key', 'return_to'].includes(key)).map(([key, value]) => [key, String(value)]));

function errorResponse(error: unknown): { status: number; message: string } {
  if (error instanceof CommandError) return { status: statusForCode(error.code), message: error.message };
  if (error instanceof PaymentFlowError) return { status: error.code === 'FORBIDDEN' ? 403 : 400, message: error.message };
  console.error('command failed', error);
  return { status: 400, message: 'The command could not be completed. Check the order state and try again.' };
}

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'Origin not allowed' }, { status: 403 });
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  const form = await request.formData();
  const command = String(form.get('command') ?? '').trim();
  const idempotencyKey = String(form.get('idempotency_key') ?? randomUUID());
  const returnTo = safeReturnTo(String(form.get('return_to') ?? ''), '/dashboard');
  const wantsJson = (request.headers.get('accept') ?? '').includes('application/json');
  if (!/^[A-Za-z0-9_.:-]{8,200}$/.test(idempotencyKey)) return NextResponse.json({ error: 'Invalid idempotency key' }, { status: 400 });

  try {
    const handler = commandHandlers[command];
    if (!handler) throw new CommandError('Unknown command');
    if (!['buyer', 'creator'].some((role) => actor.roles.includes(role))) throw new CommandError('This account cannot perform marketplace actions', 'FORBIDDEN');
    const inputHash = hashInput(valuesOf(form));
    const result = await sql.begin(async (tx) => {
      // Serialize same-key submits so concurrent duplicates replay the stored result instead of racing the unique insert.
      await tx`select pg_advisory_xact_lock(hashtextextended(${`${actor.id}:${command}:${idempotencyKey}`}, 0))`;
      const [previous] = await tx`select input_hash,result from app.commands where actor_id=${actor.id} and command=${command} and idempotency_key=${idempotencyKey} for update`;
      if (previous) {
        if (String(previous.input_hash) !== inputHash) throw new CommandError('This idempotency key was already used for different input', 'IDEMPOTENCY_CONFLICT');
        return previous.result as CommandResult;
      }
      const outcome = await handler({ tx, actor, form, command });
      await tx`insert into app.commands (actor_id,command,idempotency_key,input_hash,result) values (${actor.id},${command},${idempotencyKey},${inputHash},${JSON.stringify(outcome)}::jsonb)`;
      return outcome;
    });
    // Local mock provider emits webhooks after commit (e.g. refund confirmation); failures stay in the inbox for retry.
    if (mockPaymentsEnabled()) await deliverPendingMockWebhooks().catch((error) => console.error('mock webhook delivery failed', error));
    if (wantsJson) return NextResponse.json(result);
    const destination = result.path || returnTo;
    return NextResponse.redirect(new URL(`${destination}${destination.includes('?') ? '&' : '?'}message=${encodeURIComponent(result.message)}`, request.url), 303);
  } catch (error) {
    const { status, message } = errorResponse(error);
    if (wantsJson) return NextResponse.json({ error: message }, { status });
    return NextResponse.redirect(new URL(`${returnTo}?error=${encodeURIComponent(message)}`, request.url), 303);
  }
}
