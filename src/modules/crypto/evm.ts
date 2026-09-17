/**
 * SpacaEscrow executor for RPC networks (anvil, Arc testnet). The executor account only relays server-signed
 * authorizations and pays gas; the contract decides whether funds move. Calls happen outside database transactions
 * (the payout worker commits the signed authorization first). Reverts are mapped to the contract's error names.
 */
import { BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ESCROW_ABI } from './abi';
import type { SignedFreeze, SignedRefund, SignedRelease } from './authorization';
import { ChainUnavailableError, PayoutRejectedError, type ChainPayoutAdapter } from './chain';

const RECEIPT_TIMEOUT_MS = 60_000;

export function createEvmPayoutAdapter(input: { chainId: number; rpcUrl: string; executorKey: Hex; escrow: Hex }): ChainPayoutAdapter {
  const account = privateKeyToAccount(input.executorKey);
  const chain = { id: input.chainId, name: `chain-${input.chainId}`, nativeCurrency: { name: 'Native', symbol: 'NATIVE', decimals: 18 }, rpcUrls: { default: { http: [input.rpcUrl] } } } as const;
  const publicClient = createPublicClient({ chain, transport: http(input.rpcUrl, { timeout: 20_000, retryCount: 1 }) });
  const walletClient = createWalletClient({ account, chain, transport: http(input.rpcUrl, { timeout: 20_000, retryCount: 0 }) });

  async function findPayout(payoutRef: Hex): Promise<Hex | null> {
    try {
      const used = await publicClient.readContract({ address: input.escrow, abi: ESCROW_ABI, functionName: 'payoutUsed', args: [payoutRef] });
      if (!used) return null;
      for (const eventName of ['Released', 'Refunded'] as const) {
        const logs = await publicClient.getContractEvents({ address: input.escrow, abi: ESCROW_ABI, eventName, args: { payoutRef }, fromBlock: 0n, toBlock: 'latest' });
        if (logs[0]?.transactionHash) return logs[0].transactionHash;
      }
      // Used but the log range is unavailable from this node; still never pay again.
      return '0x' as Hex;
    } catch (error) {
      throw new ChainUnavailableError(error instanceof Error ? error.name : 'RPC error');
    }
  }

  async function send(functionName: 'release' | 'releaseBatch' | 'refund' | 'setFrozen', args: readonly unknown[], payoutRef: Hex | null): Promise<{ txHash: Hex }> {
    let hash: Hex;
    try {
      // Simulate first so contract rejections surface as named errors without spending gas.
      const { request } = await publicClient.simulateContract({ address: input.escrow, abi: ESCROW_ABI, functionName, args: args as never, account });
      hash = await walletClient.writeContract(request);
    } catch (error) {
      const revert = error instanceof BaseError ? error.walk((e) => e instanceof ContractFunctionRevertedError) : null;
      if (revert instanceof ContractFunctionRevertedError) {
        const name = revert.data?.errorName ?? 'REVERTED';
        if (name === 'PayoutAlreadyReleased' && payoutRef) {
          const previous = await findPayout(payoutRef);
          throw new PayoutRejectedError(`ALREADY_RELEASED:${previous ?? '0x'}`);
        }
        throw new PayoutRejectedError(name);
      }
      throw new ChainUnavailableError(error instanceof Error ? error.name : 'RPC error');
    }
    try {
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
      if (receipt.status !== 'success') throw new PayoutRejectedError('TX_REVERTED');
      return { txHash: hash };
    } catch (error) {
      if (error instanceof PayoutRejectedError) throw error;
      // Submitted but unconfirmed: the worker records UNKNOWN and reconciles through findPayout before retrying.
      throw new ChainUnavailableError(`RECEIPT_UNCONFIRMED:${hash}`);
    }
  }

  return {
    executeRelease: (signed: SignedRelease) => send('release', [signed.message, signed.signature], signed.message.payoutRef),
    // One transaction, one authorization per release. A revert fails the whole batch and names no payout, so the
    // caller retries the members separately rather than guessing which one the contract refused.
    executeReleaseBatch: (signed: readonly SignedRelease[]) =>
      send('releaseBatch', [signed.map((one) => one.message), signed.map((one) => one.signature)], null),
    executeRefund: (signed: SignedRefund) => send('refund', [signed.message, signed.signature], signed.message.payoutRef),
    executeFreeze: (signed: SignedFreeze) => send('setFrozen', [signed.message.escrowRef, signed.message.frozen, signed.message.nonce, signed.message.expiry, signed.signature], null),
    findPayout,
  };
}
