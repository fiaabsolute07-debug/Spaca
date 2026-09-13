'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Result = { status: string; reason?: string; funding?: string };

const LABEL: Record<string, string> = {
  CREDITED: 'Deposit verified on chain',
  PENDING_FINALITY: 'Deposit seen; waiting for confirmations',
  NOT_FOUND: 'Transaction not found on this network',
  REJECTED: 'Deposit not accepted',
  DUPLICATE: 'This deposit was already counted',
  REORGED: 'That transaction is no longer on the chain',
};

/** Sends a transaction hash as a hint; the server verifies the chain. The local devnet can simulate the wallet. */
export function CryptoDepositActions({ intentId, localDevnet }: { intentId: string; localDevnet: boolean }) {
  const router = useRouter();
  const [hash, setHash] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function check(txHash: string) {
    const response = await fetch('/api/crypto/deposits', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ intent_id: intentId, tx_hash: txHash }) });
    const body = (await response.json().catch(() => ({}))) as { results?: Result[]; error?: string };
    if (!response.ok) return setMessage(body.error ?? 'Could not check the deposit');
    const result = body.results?.[0];
    setMessage(result ? `${LABEL[result.status] ?? result.status}${result.reason ? ` (${result.reason})` : ''}` : 'No result');
    if (result?.status === 'CREDITED' || result?.status === 'PENDING_FINALITY' || result?.status === 'REJECTED') router.refresh();
  }

  async function run(action: () => Promise<void>) {
    setPending(true);
    setMessage(null);
    try {
      await action();
    } catch {
      setMessage('Network error');
    } finally {
      setPending(false);
    }
  }

  return <div className="crypto-actions">
    {localDevnet && <button type="button" className="button button-outline compact" disabled={pending} onClick={() => run(async () => {
      const response = await fetch('/api/dev/local-chain/pay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ intent_id: intentId }) });
      const body = (await response.json().catch(() => ({}))) as { tx_hash?: string; error?: string };
      if (!response.ok || !body.tx_hash) return setMessage(body.error ?? 'Simulation failed');
      setHash(body.tx_hash);
      await check(body.tx_hash);
    })}>Simulate wallet payment (local devnet)</button>}
    <label className="field">
      <span>Transaction hash</span>
      <input value={hash} onChange={(event) => setHash(event.target.value.trim())} placeholder="0x…" spellCheck={false} />
    </label>
    <button type="button" className="button compact" disabled={pending || !/^0x[0-9a-fA-F]{64}$/.test(hash)} onClick={() => run(() => check(hash))}>Check payment</button>
    {message && <p className="muted" role="status">{message}</p>}
  </div>;
}
