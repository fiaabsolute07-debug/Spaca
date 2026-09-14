/** Network/asset registry helpers and exact atomic-unit arithmetic (master §11.1, §11.4; CRY-04). */
import { createHash } from 'node:crypto';
import type { Hex } from 'viem';
import { CommandError, type Row, type Tx } from '@/lib/commands';
import { NATIVE_TOKEN } from './abi';
import { localChainsEnabled } from './chain';

export const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
export const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export async function enabledNetwork(tx: Tx, chainId: number): Promise<Row> {
  const [network] = await tx<Row[]>`select * from app.chain_networks where chain_id=${chainId} and enabled`;
  if (!network) throw new CommandError('This network is not enabled for payments', 'FEATURE_DISABLED');
  if (network.mode === 'LOCAL' && !localChainsEnabled()) throw new CommandError('The local devnet is not available in this environment', 'FEATURE_DISABLED');
  if (network.mode === 'MAINNET') throw new CommandError('Mainnet settlement is not enabled', 'FEATURE_DISABLED');
  return network;
}

/** USD cents → atomic units of a USD-pegged asset. Exact; refuses assets without cent precision. */
export function usdMinorToAtomic(minor: bigint, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 2) throw new Error('USD-pegged assets need at least 2 decimals');
  return minor * 10n ** BigInt(decimals - 2);
}

/** Atomic → USD cents only when exact; otherwise null (never rounds). */
export function atomicToUsdMinor(atomic: bigint, decimals: number): bigint | null {
  const scale = 10n ** BigInt(decimals - 2);
  return atomic % scale === 0n ? atomic / scale : null;
}

/** Human decimal string without floating point, trailing zeros trimmed to at least 2 places. */
export function formatAtomic(atomic: bigint, decimals: number): string {
  const negative = atomic < 0n;
  const digits = (negative ? -atomic : atomic).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals) || '0';
  let fraction = decimals ? digits.slice(-decimals) : '';
  fraction = fraction.replace(/0+$/, '');
  if (fraction.length < 2 && decimals >= 2) fraction = fraction.padEnd(2, '0');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

export function parseDecimalToAtomic(value: string, decimals: number): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new Error('Invalid decimal amount');
  const fraction = match[2] ?? '';
  if (fraction.length > decimals) throw new Error(`Amount has more than ${decimals} decimal places`);
  return BigInt(match[1]!) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}

/** Maps an event's token field to a registry asset: the zero address is the chain's native asset. */
export async function assetForToken(tx: Tx, chainId: number, token: string): Promise<Row | undefined> {
  const address = token.toLowerCase();
  const [asset] = address === NATIVE_TOKEN
    ? await tx<Row[]>`select * from app.chain_assets where chain_id=${chainId} and kind='NATIVE'`
    : await tx<Row[]>`select * from app.chain_assets where chain_id=${chainId} and kind='ERC20' and contract_address=${address}`;
  return asset;
}

/** Escrow bucket of an order or a campaign pool on SpacaEscrow; opaque bytes32, no order data on chain (§11.3). */
export function escrowReference(kind: 'order' | 'pool', id: string): Hex {
  return `0x${createHash('sha256').update(`spaca:escrow:${kind}:${id}`).digest('hex')}`;
}

/** Opaque bytes32 reference; carries no order data on chain (no PII, §11.3). */
export function settlementReference(orderId: string, intentId: string): Hex {
  return `0x${createHash('sha256').update(`creator-marketplace:order:${orderId}:intent:${intentId}`).digest('hex')}`;
}
