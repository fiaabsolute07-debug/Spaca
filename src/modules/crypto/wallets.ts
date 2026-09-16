/**
 * Wallet proof of control (master §11.2): a server-built EIP-4361-style message bound to domain, URI, chain, nonce
 * and expiry. The signature proves control of the address only; it never replaces the app session.
 */
import { randomBytes } from 'node:crypto';
import { getAddress, isAddress, verifyMessage, type Hex } from 'viem';
import type { Actor } from '@/lib/auth';
import { CommandError, UUID_PATTERN, type Row } from '@/lib/commands';
import { sql } from '@/lib/db';
import { enabledNetwork } from './registry';

export const WALLET_CHALLENGE_MINUTES = 10;
const MAX_CHALLENGES_PER_WINDOW = 10;

export function walletMessage(challenge: Row): string {
  return [
    `${challenge.domain} wants you to sign in with your Ethereum account:`,
    getAddress(String(challenge.address)),
    '',
    'Link this wallet to your Creator Capacity account. This signature does not authorize any payment.',
    '',
    `URI: ${challenge.uri}`,
    'Version: 1',
    `Chain ID: ${challenge.chain_id}`,
    `Nonce: ${challenge.nonce}`,
    `Issued At: ${new Date(String(challenge.issued_at)).toISOString()}`,
    `Expiration Time: ${new Date(String(challenge.expires_at)).toISOString()}`,
  ].join('\n');
}

/** The account's verified wallets, newest first, with the network they belong to. */
export async function listVerifiedWallets(userId: string): Promise<Row[]> {
  return sql<Row[]>`select w.id,w.address,w.chain_id,w.verified_at,n.name as network_name,n.mode as network_mode
    from app.wallets w join app.chain_networks n on n.chain_id=w.chain_id
    where w.user_id=${userId} and w.revoked_at is null order by w.verified_at desc`;
}

export async function createWalletChallenge(actor: Actor, input: { chainId: number; address: string; domain: string; uri: string }) {
  if (!isAddress(input.address, { strict: false })) throw new CommandError('Enter a valid wallet address');
  return sql.begin(async (tx) => {
    await enabledNetwork(tx, input.chainId);
    const [{ recent }] = await tx<{ recent: number }[]>`select count(*)::int as recent from app.wallet_challenges where user_id=${actor.id} and issued_at > now() - interval '10 minutes'`;
    if (recent >= MAX_CHALLENGES_PER_WINDOW) throw new CommandError('Too many wallet link attempts. Try again in a few minutes.', 'RATE_LIMITED');
    const [challenge] = await tx<Row[]>`insert into app.wallet_challenges (user_id,chain_id,address,nonce,domain,uri,expires_at)
      values (${actor.id},${input.chainId},${input.address.toLowerCase()},${randomBytes(16).toString('hex')},${input.domain},${input.uri},now() + (${WALLET_CHALLENGE_MINUTES} * interval '1 minute'))
      returning *`;
    return { challenge_id: String(challenge!.id), message: walletMessage(challenge!), expires_at: new Date(String(challenge!.expires_at)).toISOString() };
  });
}

/** Single-use: the nonce is consumed on success; a different domain, expired or reused challenge never links. */
export async function verifyWalletChallenge(actor: Actor, input: { challengeId: string; signature: string; domain: string }) {
  if (!UUID_PATTERN.test(input.challengeId)) throw new CommandError('Challenge not found', 'NOT_FOUND');
  if (!/^0x[0-9a-fA-F]+$/.test(input.signature)) throw new CommandError('Signature is malformed');
  return sql.begin(async (tx) => {
    const [challenge] = await tx<Row[]>`select *, expires_at < now() as expired from app.wallet_challenges where id=${input.challengeId} and user_id=${actor.id} for update`;
    if (!challenge) throw new CommandError('Challenge not found', 'NOT_FOUND');
    if (challenge.used_at) throw new CommandError('This challenge was already used; request a new one', 'ORDER_STATE_CONFLICT');
    if (challenge.expired) throw new CommandError('This challenge expired; request a new one', 'DOMAIN_RULE');
    if (challenge.domain !== input.domain) throw new CommandError('This challenge was issued for a different site', 'FORBIDDEN');
    const valid = await verifyMessage({ address: getAddress(String(challenge.address)), message: walletMessage(challenge), signature: input.signature as Hex }).catch(() => false);
    if (!valid) throw new CommandError('The signature does not match this wallet and message', 'DOMAIN_RULE');
    await tx`update app.wallet_challenges set used_at=now() where id=${input.challengeId}`;
    const [existing] = await tx<Row[]>`select * from app.wallets where chain_id=${challenge.chain_id} and address=${challenge.address} and revoked_at is null for update`;
    if (existing && String(existing.user_id) !== actor.id) throw new CommandError('This wallet is linked to another account', 'ORDER_STATE_CONFLICT');
    if (existing) return { wallet_id: String(existing.id), address: getAddress(String(existing.address)), chain_id: Number(existing.chain_id) };
    const [wallet] = await tx<Row[]>`insert into app.wallets (user_id,chain_id,address,challenge_id) values (${actor.id},${challenge.chain_id},${challenge.address},${input.challengeId}) returning *`;
    return { wallet_id: String(wallet!.id), address: getAddress(String(wallet!.address)), chain_id: Number(wallet!.chain_id) };
  });
}
