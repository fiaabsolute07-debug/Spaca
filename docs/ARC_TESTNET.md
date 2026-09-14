# Arc testnet runbook (SpacaEscrow)

Checked against Arc docs and the live RPC on 2026-09-15:
- Chain id 5042002, RPC `https://rpc.testnet.arc.io`, explorer `https://testnet.arcscan.app`, faucet `https://faucet.circle.com`.
- USDC is the native gas token (18 decimals) with an ERC-20 interface at `0x3600000000000000000000000000000000000000` (6 decimals). spaca uses the ERC-20 interface only.
- Finality is deterministic on inclusion (1 confirmation). The minimum base fee is 20 gwei.

Re-check before each deployment:

```bash
./node_modules/.bin/tsx scripts/arc-testnet.ts check
```

## 1. Keys (testnet only)

`contracts/.env.local` is git-ignored and mode 600. It holds a generated deployer/executor key and a separate release-signer key. Never print it, commit it, or reuse these keys on mainnet.

The deployer address must hold testnet USDC for gas. Request it at the faucet: choose **Arc Testnet** and **USDC**, and paste the deployer address. The faucet needs a human (CAPTCHA). Then confirm the balance:

```bash
set -a; . contracts/.env.local; set +a; ./node_modules/.bin/tsx scripts/arc-testnet.ts check
```

## 2. Test and deploy

```bash
cd contracts && ./install-deps.sh && forge build && forge test
```

```bash
cd contracts && set -a && . ./.env.local && set +a && forge script script/Deploy.s.sol --rpc-url arc_testnet --broadcast --private-key "$ARC_DEPLOYER_PRIVATE_KEY"
```

Record the printed `SpacaEscrow` address and check it on the explorer.

## 3. Register in the app database

```bash
set -a; . contracts/.env.local; set +a; ESCROW_ADDRESS=<deployed address> ./node_modules/.bin/tsx scripts/arc-testnet.ts register
```

`register` reads the contract on chain and refuses in either case:
- no code at the address, or USDC not allowlisted;
- a release signer that differs from `RELEASE_SIGNER_ADDRESS`.

It then upserts the TESTNET network (`enabled`, `verified_at`, note) and the USDC asset.

## 4. Run the app against Arc testnet

Server environment (from a secret store, not the repository):

```text
CHAIN_RPC_URL_5042002=https://rpc.testnet.arc.io
CHAIN_EXECUTOR_KEY_5042002=<ARC_DEPLOYER_PRIVATE_KEY>
RELEASE_SIGNER_PRIVATE_KEY=<RELEASE_SIGNER_PRIVATE_KEY>
```

- The buyer pays with a browser wallet on the order page: approve, then fund the escrow. The server verifies the `Funded` log.
- Settlement and refunds are queued. `POST /api/dev/jobs` (or the scheduler) runs `dispatch_chain_payouts`.

## 5. Incident

1. Pause from the guardian (`cast send <escrow> "pause()" --rpc-url arc_testnet --private-key …`). Queued payouts wait in RETRY with `EnforcedPause`.
2. Rotate the signer from the owner: `setReleaseSigner(address)`. Update `RELEASE_SIGNER_PRIVATE_KEY`, then `unpause()`.
3. Payers can still `reclaim(escrowRef)` after their bucket's reclaim time.

See [ADR 002](adr/002-escrow-custody.md) and runbook [08](runbooks/README.md) for wrong-chain or mixed payouts.
