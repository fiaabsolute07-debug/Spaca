/**
 * Release authorizations (master §11.3; CRY-10). The server signs EIP-712 typed data bound to chain id, settlement
 * contract, payout id, order reference, recipient, token, amount, a single-use nonce and an expiry. The settlement
 * contract (simulated locally) verifies the signer and refuses replays across nonces, chains, contracts and payouts.
 *
 * Custody: a local signer is generated per process for development and tests. Deployed environments need a managed
 * key (KMS/multisig) that is NOT implemented, so signing fails closed there.
 */
import { createHash, randomBytes } from 'node:crypto';
import { recoverTypedDataAddress, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

export const RELEASE_TYPES = {
  Release: [
    { name: 'payoutRef', type: 'bytes32' },
    { name: 'orderRef', type: 'bytes32' },
    { name: 'recipient', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'expiry', type: 'uint256' },
  ],
} as const;

export type ReleaseMessage = { payoutRef: Hex; orderRef: Hex; recipient: Hex; token: Hex; amount: bigint; nonce: Hex; expiry: bigint };
export type ReleaseDomain = { name: 'CreatorCapacitySettlement'; version: '1'; chainId: number; verifyingContract: Hex };
export type SignedRelease = { domain: ReleaseDomain; message: ReleaseMessage; signature: Hex };

const signerStore = globalThis as typeof globalThis & { __ccmReleaseSigner?: PrivateKeyAccount };

export function getReleaseSigner(): PrivateKeyAccount {
  if (process.env.NODE_ENV === 'production') throw new Error('Release signing needs a managed custody key, which is not implemented');
  const configured = process.env.RELEASE_SIGNER_PRIVATE_KEY;
  signerStore.__ccmReleaseSigner ??= privateKeyToAccount((configured && /^0x[0-9a-fA-F]{64}$/.test(configured) ? configured : generatePrivateKey()) as Hex);
  return signerStore.__ccmReleaseSigner;
}

export const bytes32Of = (value: string): Hex => `0x${createHash('sha256').update(value).digest('hex')}`;
export const newNonce = (): Hex => `0x${randomBytes(32).toString('hex')}`;

export function releaseDomain(chainId: number, settlement: string): ReleaseDomain {
  return { name: 'CreatorCapacitySettlement', version: '1', chainId, verifyingContract: settlement.toLowerCase() as Hex };
}

export async function signRelease(domain: ReleaseDomain, message: ReleaseMessage): Promise<SignedRelease> {
  const signature = await getReleaseSigner().signTypedData({ domain, types: RELEASE_TYPES, primaryType: 'Release', message });
  return { domain, message, signature };
}

/** What the settlement contract checks before moving funds; returns the recovered signer or throws. */
export async function verifyReleaseSignature(signed: SignedRelease, expected: { chainId: number; contract: string; signer: string; now: bigint }): Promise<Hex> {
  if (signed.domain.chainId !== expected.chainId) throw new Error('WRONG_CHAIN');
  if (signed.domain.verifyingContract.toLowerCase() !== expected.contract.toLowerCase()) throw new Error('WRONG_CONTRACT');
  if (signed.message.expiry <= expected.now) throw new Error('EXPIRED');
  const recovered = await recoverTypedDataAddress({ domain: signed.domain, types: RELEASE_TYPES, primaryType: 'Release', message: signed.message, signature: signed.signature });
  if (recovered.toLowerCase() !== expected.signer.toLowerCase()) throw new Error('BAD_SIGNATURE');
  return recovered;
}
