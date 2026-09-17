# Launch prep: the checks behind LAUNCH_READINESS (2026-09-17)

Continues the launch work started in the parallel session, whose stated next step was "the full Vitest suite,
release check, and a production build with the launch configuration". All three are done, plus the browser suite
that `docs/LAUNCH_READINESS.md` §5 was waiting on. Nothing was deployed and no real money moved.

## Results

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `RUN_DB_INTEGRATION=1 vitest run` | **442 passed, 3 skipped** (58 files; the 3 skipped are the anvil suite) |
| `tsx scripts/release-check.ts` | **every check PASS** |
| Production build (`NEXT_DIST_DIR=.next-scan`, local fixture `DATABASE_URL`) | **compiles, no warnings** |
| `tsx scripts/secret-scan.ts --client-dir .next-scan/static` | **clean** — 554 tracked files, 42 client bundle files |
| `cd contracts && forge test` | 17 passed |
| Playwright, full suite | 78 tests; see below |

## A launch gate that was failing

The secret scan — a launch gate — reported a finding in `tests/unit/env-rules.test.ts`: the fixture for
`SUPABASE_SERVER_SECRET_KEY` was a literal in the shape of a real key (`sb_secret_…`), which is what
`scripts/secret-scan.ts` looks for.

It was a fixture, not a live credential, but a tracked file should not carry a string that reads as one. The rule
it exercises (`scripts/lib/env-rules.ts`) only asks for 20 characters or more that do not begin with
`sb_publishable_`, so the fixture never needed a real key's prefix. It is now plainly fake, the nine env-rules
tests still pass, and the scan is clean.

`tsconfig.json` was also restored: `next build` rewrites it and injects `.next-scan` include paths. That is a
build artifact, not work, and the parallel session had reverted the same thing earlier.

## The browser suite, honestly

The first full run reported **67 passed, 11 failed in 21.1 minutes** — and that number should not be used. Two
things spoiled it. A Playwright run from an earlier attempt was still alive and competing for the same dev server
and database, and partway through **the dev server died** (`ECONNREFUSED 127.0.0.1:3100`), which fails every test
that follows. Playwright's exit code was also masked by a `| tail` in the command, reporting 0 for a failing run.

Each failing spec was then re-run on its own, against a restarted dev server, with nothing else running:

| Spec | Alone | Verdict |
|---|---|---|
| `admin`, `auth-dialog`, `explore-create`, `funds` | 12 passed, 2 failed — both `ECONNREFUSED` | the dead dev server |
| `honest-states` | **8/8 passed** | interference |
| `onboarding`, `performance`, `request-hire` | passed | interference |
| `item-auctions` | failed, then **3/3 after a fix** | **a real regression, mine — see below** |
| `publish` | failed again, same reason both times | real, and blocked on data |

So of eleven reported failures, nine were the environment, one was a regression this session introduced and has
fixed, and one is the long-standing data problem.

### The regression was mine

`item-auctions.spec.ts` waits for the bid field to read "Your bid (USD, at least $110.00)": a $100 listing plus a
$10 step. Its `listItem()` helper never filled **Minimum increment**, so it inherited the form's default — and
`258ecce` lowered that default from $10 to $5 as part of making the price examples reasonable. The step became
$5, the expected label never appeared, and the test timed out.

The fix is in the test, not the product: `listItem()` now fills the increment explicitly, because the bid amounts
the test asserts are arithmetic on that step, and a suggested default is a presentation choice that may change
again. `item-auctions` is 3/3.

### The one real failure left

`publish.spec.ts` fails in its own fixture helper with **"no removable test account left to free a slot"**:
`creator_d` holds the maximum linked X accounts from earlier runs, each held by a published service, so the
helper cannot free one. `docs/HANDOFF_PROMPT.md` already records this as the single real failure from the
previous full run, and it clears only with the development database cleanup that is still waiting on the owner's
**"đồng ý dọn"**. No product code is involved.

## Reviewing the launch code before committing it

This work came from another session, so the risky parts were read rather than assumed, and committed as `6d0a2d9`:

- **`/api/cron/jobs`** answers 404 unless `CRON_SECRET` is at least 32 characters, compares the bearer token with
  `timingSafeEqual` after a length check, sends `no-store`, and returns only job names and counts.
  `runJobsIsolated` wraps each job so one failure cannot stop the rest.
- **`PAYMENT_MODE=off`**, the rail behind the owner's "no money at launch" decision, is enforced where money
  would move and not only in copy: funding refuses, and every money flag — checkout, bidding, payouts, bank
  funding, crypto checkout, live payments — reads as disabled and throws on use, fail closed, whatever the flag
  rows say. Item auctions are covered through those same flags.
- **Supabase Storage** signs uploads and downloads, buckets carry the size limits a signed upload URL cannot, and
  local development stays on the local adapter unless `STORAGE_PROVIDER=supabase`.

## Environment notes

- The dev server was restarted from Bash with the `marketplace-dev` arguments in `.claude/launch.json` after it
  died mid-run. As documented, that loses the in-memory mock payment provider history.
- Running two Playwright suites at once is what caused the ENOENT trace errors and the competing-run failures.
  One run at a time, one `--output` directory each.
