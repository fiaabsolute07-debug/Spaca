'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createPublicClient, createWalletClient, custom, parseAbi, type EIP1193Provider, type Hex } from 'viem';

const ESCROW_FUND_ABI = parseAbi(['function fund(bytes32 escrowRef, bytes32 paymentRef, address token, uint256 amount)']);
const ERC20_APPROVE_ABI = parseAbi(['function approve(address spender, uint256 amount) returns (bool)', 'function allowance(address owner, address spender) view returns (uint256)']);

export type WalletFunding = { chainId: number; chainName: string; escrow: string; token: string; escrowRef: string; paymentRef: string; amountAtomic: string };

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
export function CryptoDepositActions({ intentId, localDevnet, wallet }: { intentId: string; localDevnet: boolean; wallet?: WalletFunding | null }) {
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
    } catch (error) {
      const text = error instanceof Error ? error.message : '';
      setMessage(/rejected|denied/i.test(text) ? 'Cancelled in the wallet' : 'The wallet or network returned an error. Nothing is charged unless the deposit transaction succeeded.');
    } finally {
      setPending(false);
    }
  }

  /** Browser wallet (EIP-1193): approve the exact amount for the escrow, fund the bucket, then let the server verify. */
  async function payWithWallet(funding: WalletFunding) {
    const ethereum = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
    if (!ethereum) return setMessage('No browser wallet found. Install a wallet such as MetaMask or Rabby, or send from any wallet and paste the transaction hash.');
    const [account] = await ethereum.request({ method: 'eth_requestAccounts' }) as Hex[];
    if (!account) return setMessage('The wallet did not share an account');
    const hexChain = `0x${funding.chainId.toString(16)}`;
    try {
      await ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexChain }] });
    } catch {
      return setMessage(`Switch your wallet to ${funding.chainName} (chain ${funding.chainId}) and try again`);
    }
    const chain = { id: funding.chainId, name: funding.chainName, nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [] as string[] } } } as const;
    const client = createWalletClient({ account, chain, transport: custom(ethereum) });
    const reader = createPublicClient({ chain, transport: custom(ethereum) });
    const amount = BigInt(funding.amountAtomic);
    const allowance = await reader.readContract({ address: funding.token as Hex, abi: ERC20_APPROVE_ABI, functionName: 'allowance', args: [account, funding.escrow as Hex] });
    if (allowance < amount) {
      setMessage('Step 1 of 2: approve the exact amount for the escrow in your wallet');
      const approval = await client.writeContract({ address: funding.token as Hex, abi: ERC20_APPROVE_ABI, functionName: 'approve', args: [funding.escrow as Hex, amount] });
      await reader.waitForTransactionReceipt({ hash: approval });
    }
    setMessage('Step 2 of 2: confirm the deposit into the escrow in your wallet');
    const txHash = await client.writeContract({ address: funding.escrow as Hex, abi: ESCROW_FUND_ABI, functionName: 'fund', args: [funding.escrowRef as Hex, funding.paymentRef as Hex, funding.token as Hex, amount] });
    setHash(txHash);
    await reader.waitForTransactionReceipt({ hash: txHash });
    await check(txHash);
  }

  return <div className="crypto-actions">
    {wallet && !localDevnet && <button type="button" className="button compact" disabled={pending} onClick={() => run(() => payWithWallet(wallet))}>Pay with browser wallet</button>}
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
