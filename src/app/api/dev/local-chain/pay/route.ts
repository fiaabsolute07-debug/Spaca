import { NextResponse } from 'next/server';
import { getActor, isSameOrigin } from '@/lib/auth';
import { sql } from '@/lib/db';
import { NATIVE_TOKEN } from '@/modules/crypto/abi';
import { getLocalDevChain, localChainsEnabled } from '@/modules/crypto/chain';

/**
 * Local devnet wallet simulator: emits the settlement event for the buyer's own intent and mines enough blocks for
 * finality. No real chain, key or funds. 404 in production, when the devnet is off, or for non-LOCAL networks.
 */
export async function POST(request: Request) {
  if (process.env.NODE_ENV === 'production' || !localChainsEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'Origin not allowed' }, { status: 403 });
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  const input = (await request.json().catch(() => ({}))) as { intent_id?: string };
  if (!/^[0-9a-f-]{36}$/i.test(String(input.intent_id ?? ''))) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const [intent] = await sql`select i.*,n.mode,n.finality_confirmations,a.kind,a.contract_address,w.address as wallet_address
    from app.crypto_payment_intents i join app.chain_networks n on n.chain_id=i.chain_id join app.chain_assets a on a.id=i.asset_id
    left join app.wallets w on w.id=i.payer_wallet_id
    where i.id=${String(input.intent_id)} and i.buyer_id=${actor.id}`;
  if (!intent || intent.mode !== 'LOCAL') return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const chain = getLocalDevChain(Number(intent.chain_id), String(intent.recipient));
  if (!chain) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const txHash = chain.submitDeposit({
    emitter: intent.recipient, reference: intent.reference, payer: intent.wallet_address ?? '0x00000000000000000000000000000000000de7a1',
    token: intent.kind === 'NATIVE' ? NATIVE_TOKEN : intent.contract_address, amount: BigInt(String(intent.amount_atomic)),
  });
  chain.mine(Math.max(0, Number(intent.finality_confirmations) - 1));
  return NextResponse.json({ tx_hash: txHash, chain_id: Number(intent.chain_id), simulated: true });
}
