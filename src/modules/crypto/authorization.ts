/**
 * Payout authorizations for SpacaEscrow (master §11.3; CRY-10). The server signs EIP-712 typed data bound to chain id,
 * escrow contract, payout reference, escrow bucket, recipient, token, amount, a single-use nonce and an expiry.
 * The contract (and the local simulator) verifies the signer and refuses replays across nonces, chains, contracts and
 * payouts. Refunds carry no recipient: the contract always pays the bucket's payer.
 *
 * Custody: development and testnet use RELEASE_SIGNER_PRIVATE_KEY or a per-process key. Production needs a managed key
 * (KMS/multisig, docs/adr) that is NOT implemented, so signing fails closed there.
 */
import { createHash, randomBytes } from 'node:crypto';
import { recoverTypedDataAddress, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

export const RELEASE_TYPES = {
  Release: [
    { name: 'payoutRef', type: 'bytes32' },
    { name: 'escrowRef', type: 'bytes32' },
    { name: 'recipient', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'expiry', type: 'uint256' },
  ],
} as const;

export const REFUND_TYPES = {
  Refund: [
    { name: 'payoutRef', type: 'bytes32' },
    { name: 'escrowRef', type: 'bytes32' },
    { name: 'amount', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'expiry', type: 'uint256' },
  ],
} as const;

export const FREEZE_TYPES = {
  Freeze: [
    { name: 'escrowRef', type: 'bytes32' },
    { name: 'frozen', type: 'bool' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'expiry', type: 'uint256' },
  ],
} as const;

export type ReleaseMessage = { payoutRef: Hex; escrowRef: Hex; recipient: Hex; token: Hex; amount: bigint; nonce: Hex; expiry: bigint };
export type RefundMessage = { payoutRef: Hex; escrowRef: Hex; amount: bigint; nonce: Hex; expiry: bigint };
export type FreezeMessage = { escrowRef: Hex; frozen: boolean; nonce: Hex; expiry: bigint };
export type EscrowDomain = { name: 'SpacaEscrow'; version: '1'; chainId: number; verifyingContract: Hex };
export type SignedRelease = { domain: EscrowDomain; message: ReleaseMessage; signature: Hex };
export type SignedRefund = { domain: EscrowDomain; message: RefundMessage; signature: Hex };
export type SignedFreeze = { domain: EscrowDomain; message: FreezeMessage; signature: Hex };

const signerStore = globalThis as typeof globalThis & { __ccmReleaseSigner?: PrivateKeyAccount };

export function getReleaseSigner(): PrivateKeyAccount {
  if (process.env.NODE_ENV === 'production') throw new Error('Release signing needs a managed custody key, which is not implemented');
  const configured = process.env.RELEASE_SIGNER_PRIVATE_KEY;
  signerStore.__ccmReleaseSigner ??= privateKeyToAccount((configured && /^0x[0-9a-fA-F]{64}$/.test(configured) ? configured : generatePrivateKey()) as Hex);
  return signerStore.__ccmReleaseSigner;
}

export const bytes32Of = (value: string): Hex => `0x${createHash('sha256').update(value).digest('hex')}`;
export const newNonce = (): Hex => `0x${randomBytes(32).toString('hex')}`;

export function escrowDomain(chainId: number, escrow: string): EscrowDomain {
  return { name: 'SpacaEscrow', version: '1', chainId, verifyingContract: escrow.toLowerCase() as Hex };
}

export async function signRelease(domain: EscrowDomain, message: ReleaseMessage): Promise<SignedRelease> {
  const signature = await getReleaseSigner().signTypedData({ domain, types: RELEASE_TYPES, primaryType: 'Release', message });
  return { domain, message, signature };
}

export async function signRefund(domain: EscrowDomain, message: RefundMessage): Promise<SignedRefund> {
  const signature = await getReleaseSigner().signTypedData({ domain, types: REFUND_TYPES, primaryType: 'Refund', message });
  return { domain, message, signature };
}

export async function signFreeze(domain: EscrowDomain, message: FreezeMessage): Promise<SignedFreeze> {
  const signature = await getReleaseSigner().signTypedData({ domain, types: FREEZE_TYPES, primaryType: 'Freeze', message });
  return { domain, message, signature };
}

type Expected = { chainId: number; contract: string; signer: string; now: bigint };

function checkDomain(domain: EscrowDomain, expiry: bigint, expected: Expected) {
  if (domain.chainId !== expected.chainId) throw new Error('WRONG_CHAIN');
  if (domain.verifyingContract.toLowerCase() !== expected.contract.toLowerCase()) throw new Error('WRONG_CONTRACT');
  if (expiry < expected.now) throw new Error('EXPIRED');
}

/** What the escrow contract checks before moving funds; returns the recovered signer or throws. */
export async function verifyReleaseSignature(signed: SignedRelease, expected: Expected): Promise<Hex> {
  checkDomain(signed.domain, signed.message.expiry, expected);
  const recovered = await recoverTypedDataAddress({ domain: signed.domain, types: RELEASE_TYPES, primaryType: 'Release', message: signed.message, signature: signed.signature });
  if (recovered.toLowerCase() !== expected.signer.toLowerCase()) throw new Error('BAD_SIGNATURE');
  return recovered;
}

export async function verifyRefundSignature(signed: SignedRefund, expected: Expected): Promise<Hex> {
  checkDomain(signed.domain, signed.message.expiry, expected);
  const recovered = await recoverTypedDataAddress({ domain: signed.domain, types: REFUND_TYPES, primaryType: 'Refund', message: signed.message, signature: signed.signature });
  if (recovered.toLowerCase() !== expected.signer.toLowerCase()) throw new Error('BAD_SIGNATURE');
  return recovered;
}

export async function verifyFreezeSignature(signed: SignedFreeze, expected: Expected): Promise<Hex> {
  checkDomain(signed.domain, signed.message.expiry, expected);
  const recovered = await recoverTypedDataAddress({ domain: signed.domain, types: FREEZE_TYPES, primaryType: 'Freeze', message: signed.message, signature: signed.signature });
  if (recovered.toLowerCase() !== expected.signer.toLowerCase()) throw new Error('BAD_SIGNATURE');
  return recovered;
}
