/**
 * Arc testnet operations for SpacaEscrow (master §11.1: re-verify chain facts at execution time).
 *
 *   tsx scripts/arc-testnet.ts check
 *     Reads chain id, head block, USDC ERC-20 decimals and, when ARC_DEPLOYER_ADDRESS / ARC_EXECUTOR_ADDRESS are set,
 *     their USDC balances (gas on Arc is paid in USDC). Read-only.
 *
 *   ESCROW_ADDRESS=0x… tsx scripts/arc-testnet.ts register
 *     After `forge script script/Deploy.s.sol --rpc-url arc_testnet --broadcast` (see docs/ARC_TESTNET.md): verifies the
 *     contract's release signer and token allowlist on chain, then upserts the TESTNET network and USDC asset in the
 *     local database (DATABASE_URL). It never enables MAINNET and never moves funds.
 */
import { createPublicClient, getAddress, http, isAddress, parseAbi, type Hex } from 'viem';

export const ARC_TESTNET = {
  chainId: 5042002,
  rpcUrl: process.env.ARC_RPC_URL ?? 'https://rpc.testnet.arc.io',
  explorer: 'https://testnet.arcscan.app',
  faucet: 'https://faucet.circle.com',
  // Official contract-addresses page: USDC native gas token (18 decimals) with an optional ERC-20 interface (6 decimals).
  usdcErc20: '0x3600000000000000000000000000000000000000' as Hex,
  usdcErc20Decimals: 6,
  // Docs: deterministic finality on inclusion; one confirmation is sufficient.
  finalityConfirmations: 1,
  docsCheckedAt: '2026-09-15',
} as const;

const ERC20 = parseAbi(['function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)']);
const ESCROW = parseAbi(['function releaseSigner() view returns (address)', 'function allowedToken(address) view returns (bool)', 'function paused() view returns (bool)', 'function reclaimDelay() view returns (uint64)']);

const client = createPublicClient({ transport: http(ARC_TESTNET.rpcUrl, { timeout: 15_000 }) });
const usdc = (value: bigint) => `${value / 10n ** 6n}.${(value % 10n ** 6n).toString().padStart(6, '0')} USDC`;

async function check() {
  const chainId = await client.getChainId();
  if (chainId !== ARC_TESTNET.chainId) throw new Error(`RPC reports chain ${chainId}, expected ${ARC_TESTNET.chainId}`);
  const [block, decimals] = await Promise.all([
    client.getBlockNumber(),
    client.readContract({ address: ARC_TESTNET.usdcErc20, abi: ERC20, functionName: 'decimals' }),
  ]);
  if (decimals !== ARC_TESTNET.usdcErc20Decimals) throw new Error(`USDC ERC-20 decimals ${decimals}, expected ${ARC_TESTNET.usdcErc20Decimals}`);
  console.log(`Arc testnet OK: chain ${chainId}, head block ${block}, USDC ERC-20 ${ARC_TESTNET.usdcErc20} decimals ${decimals}`);
  for (const name of ['ARC_DEPLOYER_ADDRESS', 'ARC_EXECUTOR_ADDRESS'] as const) {
    const address = process.env[name];
    if (!address) continue;
    if (!isAddress(address)) throw new Error(`${name} is not an address`);
    const balance = await client.readContract({ address: ARC_TESTNET.usdcErc20, abi: ERC20, functionName: 'balanceOf', args: [address] });
    console.log(`${name} ${getAddress(address)}: ${usdc(balance)}${balance === 0n ? ` (fund it at ${ARC_TESTNET.faucet})` : ''}`);
  }
}

async function register() {
  const escrow = process.env.ESCROW_ADDRESS;
  if (!escrow || !isAddress(escrow)) throw new Error('ESCROW_ADDRESS must be the deployed SpacaEscrow address');
  await check();
  const code = await client.getCode({ address: escrow });
  if (!code || code === '0x') throw new Error(`No contract code at ${escrow} on Arc testnet`);
  const [signer, allowed, paused, delay] = await Promise.all([
    client.readContract({ address: escrow, abi: ESCROW, functionName: 'releaseSigner' }),
    client.readContract({ address: escrow, abi: ESCROW, functionName: 'allowedToken', args: [ARC_TESTNET.usdcErc20] }),
    client.readContract({ address: escrow, abi: ESCROW, functionName: 'paused' }),
    client.readContract({ address: escrow, abi: ESCROW, functionName: 'reclaimDelay' }),
  ]);
  if (!allowed) throw new Error('USDC is not allowlisted on the escrow');
  const expectedSigner = process.env.RELEASE_SIGNER_ADDRESS;
  if (expectedSigner && getAddress(expectedSigner) !== getAddress(signer)) throw new Error(`Escrow release signer ${signer} differs from RELEASE_SIGNER_ADDRESS`);
  console.log(`Escrow ${getAddress(escrow)}: signer ${signer}, paused ${paused}, reclaim delay ${Number(delay) / 86400} days`);

  const { sql } = await import('../src/lib/db');
  const note = `SpacaEscrow ${escrow.toLowerCase()} verified on chain; Arc docs checked ${ARC_TESTNET.docsCheckedAt}; USDC via ERC-20 interface (6 decimals)`;
  await sql.begin(async (tx) => {
    await tx`insert into app.chain_networks (chain_id,name,mode,settlement_address,finality_confirmations,enabled,verified_at,verification_note)
      values (${ARC_TESTNET.chainId},'Arc testnet','TESTNET',${escrow.toLowerCase()},${ARC_TESTNET.finalityConfirmations},true,now(),${note})
      on conflict (chain_id) do update set settlement_address=excluded.settlement_address,finality_confirmations=excluded.finality_confirmations,
        enabled=true,verified_at=now(),verification_note=excluded.verification_note`;
    await tx`insert into app.chain_assets (chain_id,symbol,kind,contract_address,decimals,balance_key,usd_pegged,transfer_behavior,allowlisted)
      values (${ARC_TESTNET.chainId},'USDC','ERC20',${ARC_TESTNET.usdcErc20.toLowerCase()},${ARC_TESTNET.usdcErc20Decimals},'USDC',true,'STANDARD',true)
      on conflict do nothing`;
  });
  await sql.end({ timeout: 5 });
  console.log(`Registered Arc testnet in the database. Set CHAIN_RPC_URL_${ARC_TESTNET.chainId} and CHAIN_EXECUTOR_KEY_${ARC_TESTNET.chainId} for the payout worker.`);
}

const command = process.argv[2];
if (command === 'check') await check();
else if (command === 'register') await register();
else {
  console.error('usage: tsx scripts/arc-testnet.ts check|register');
  process.exit(2);
}
