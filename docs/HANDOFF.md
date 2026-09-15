# HANDOFF

Start with [NEXT_SESSION.md](NEXT_SESSION.md) (Vietnamese; full rules, environment and state). Then read [MASTER_PROMPT.md](MASTER_PROMPT.md), [BUILD_STATUS.md](BUILD_STATUS.md), [ACCEPTANCE.md](ACCEPTANCE.md) and [UI_CONTRACT.md](UI_CONTRACT.md).

As of 2026-09-15 (commit `d898592`): Claude builds UI and backend and is the only committer; do not run `codex exec`. The platform fee is enforced at 0 and the model is undecided. Never write "0% fee" in marketing copy.

## Rules that must hold
- **Permission first:** no real money, mainnet, public deploys (including the Vercel waitlist), or outbound email or messages without the user's permission for that action.
- **Secrets:** never read `.env*` or `contracts/.env.local`, and never print secrets. Sign in locally with `POST /api/dev/session`.
- **Git:** `git add` explicit paths only, never `-A`. No reset, rebase or stash. Run `git diff --cached --stat` before committing. Do not commit `next-env.d.ts`.
- **Honest results:** keep mock / LOCAL devnet / TESTNET / live labels separate. No PASS without a real run. Never mark settlements RELEASED by hand.

## State
Acceptance: 116 PASS / 19 PARTIAL / 0 NOT_RUN / 2 BLOCKED / 5 REMOVED. Results and gaps are in [BUILD_STATUS.md](BUILD_STATUS.md) and [the audit](evidence/claude-AUDIT-2026-09-15.md).

## User decisions to keep
- Separate buyer and creator accounts.
- No order limit (pause only), and no ACCESS scheduling.
- Auctions paused.
- The profile is its own area, opened from the header avatar.
- No tab strip above Explore, Campaigns and Auctions.
- Visual choice cards instead of dropdowns, and color only on key elements.

## Blocked on the user or outside
- Arc testnet faucet funds for deployer `0x7758186cD9FE0156fd5F631e5c944445D9c1e97F`.
- Supabase/staging (SEC-03).
- A real payment and payout provider (PAY-19).
- The fee model decision.
- Legal review.
- An independent contract audit before mainnet.
- Rotating the Resend and Supabase service_role keys that were pasted in chat earlier.
