'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

type Network = { chain_id: number; name: string; mode: string };
type Ethereum = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };

async function postJson(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : `Request failed (${response.status})`);
  return data;
}

/**
 * Links a wallet by signing the server's challenge (master §11.2). The signature proves control of the address and
 * authorizes no payment; the server checks it against the domain, chain, nonce and expiry.
 */
export function WalletLink({ networks }: { networks: Network[] }) {
  const router = useRouter();
  const [chainId, setChainId] = useState(networks[0]?.chain_id ?? 0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  if (networks.length === 0) return <p className="muted">No network is enabled for wallets in this environment.</p>;
  const network = networks.find((item) => item.chain_id === chainId) ?? networks[0]!;

  async function link() {
    setNotice(null);
    const ethereum = (window as unknown as { ethereum?: Ethereum }).ethereum;
    if (!ethereum) {
      setNotice({ tone: 'error', text: 'No browser wallet was found. Install one, or open this page in your wallet’s browser.' });
      return;
    }
    setBusy(true);
    try {
      const accounts = (await ethereum.request({ method: 'eth_requestAccounts' })) as string[];
      const address = accounts?.[0];
      if (!address) throw new Error('The wallet did not share an address.');
      const challenge = await postJson('/api/wallets/challenge', { chain_id: network.chain_id, address });
      const signature = (await ethereum.request({ method: 'personal_sign', params: [String(challenge.message), address] })) as string;
      const wallet = await postJson('/api/wallets/verify', { challenge_id: String(challenge.challenge_id), signature });
      setNotice({ tone: 'ok', text: `Linked ${String(wallet.address)} on ${network.name}.` });
      router.refresh();
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'The wallet did not finish signing.' });
    } finally {
      setBusy(false);
    }
  }

  return <div className="wallet-link">
    {networks.length > 1 && <fieldset className="choice-group">
      <legend>Network</legend>
      <div className="choice-chips">
        {networks.map((option) => <label key={option.chain_id} className="choice-chip">
          <input type="radio" name="wallet_network" value={option.chain_id} checked={option.chain_id === network.chain_id} onChange={() => setChainId(option.chain_id)} />
          <span>{option.name} · {option.mode.toLowerCase()}</span>
        </label>)}
      </div>
    </fieldset>}
    <button type="button" className="button" onClick={link} disabled={busy}>{busy ? 'Waiting for your wallet…' : 'Link a wallet'}</button>
    <p className="muted">Your wallet opens and asks you to sign a message naming this site, the network and a one-time code. Signing proves the address is yours and moves no money.</p>
    {notice && <p className={notice.tone === 'ok' ? 'notice success' : 'notice error'} role="status">{notice.text}</p>}
  </div>;
}
