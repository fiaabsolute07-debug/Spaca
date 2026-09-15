# Bàn giao cho agent/phiên tiếp theo — spaca (cập nhật 2026-09-15, cuối phiên Claude)

> **CẬP NHẬT MỚI NHẤT (sau khi viết file này):** user yêu cầu **bỏ giới hạn số đơn (Order limit, giữ nút Pause)** và **bỏ đặt lịch ACCESS (Session availability)**. Đã làm trong migration `drizzle/0017_no_order_limit_no_scheduling.sql` và commit **cùng với toàn bộ code DIGITAL** (xem §4, §5).
> Mọi chỗ bên dưới nhắc tới `set_workload_limit`, `max_active_units`, `AT_CAPACITY`, slot/appointment/`mark_session`/`set_availability`, `ACCESS_BOOKING_ENABLED` hay `claude-P6-ACCESS.md` là **lịch sử, không còn trong code**.
> Tiến độ nghiệm thu hiện tại: **70 PASS / 54 PARTIAL / 11 NOT_RUN / 2 BLOCKED / 5 REMOVED**. REMOVED gồm CAP-01, CAP-02, CAP-07, CAP-11, XPL-03.
> Test: `vitest` **251 passed + 3 skipped** (gồm DIGITAL 5/5). E2E **14/15** (book-order fail do đơn mock mồ côi, §2.3). **E2E DIGITAL vẫn chưa pass** (§5.3).

> Đọc toàn bộ file này trước khi làm gì. Sau đó đọc theo thứ tự:
> 1. `docs/MASTER_PROMPT.md`: đặc tả gốc. Roadmap ở §16, bảng acceptance ở §18. Thanh toán Arc ở §11.7, campaign Performance ở §9.6.
> 2. `docs/ACCEPTANCE.md`: sổ nghiệm thu, mỗi dòng một ID §18.
> 3. `docs/UI_CONTRACT.md`: hợp đồng dữ liệu và lệnh cho UI.
> 4. `docs/evidence/claude-*.md`: bằng chứng từng đợt. Mới nhất là `claude-P6-ACCESS.md`, `claude-W9-ARC.md`, `claude-W8-PUB.md`.
> 5. `docs/COLLABORATION.md`: bảng việc.
>
> `docs/BUILD_STATUS.md` và `docs/HANDOFF.md` **đã cũ**. File này là nguồn đúng nhất.

---

## 0. Tóm tắt 30 giây

- **Sản phẩm:** spaca, marketplace nơi dự án web3 (chính) và AI/SaaS (phụ) thuê creator crypto-native trên X.
- **Bốn loại hàng:**
  - `CREATE`: nội dung bàn giao cho buyer;
  - `PUBLISH`: creator đăng bài trên kênh của mình;
  - `ACCESS`: buổi tư vấn (thời gian do hai bên tự thỏa thuận trong tin nhắn);
  - `DIGITAL`: file bán sẵn.
- **Ba cách mua:** Book Now, Request/hire (campaign nhiều creator), Auction (đang tạm hoãn).
- **Thanh toán:** thẻ qua mock provider; crypto qua escrow non-custodial `SpacaEscrow` trên Arc (mới chạy local/anvil, **chưa deploy testnet** vì ví deployer chưa có USDC testnet).
- **Stack:** Next.js 16 (webpack) + React 19 + TypeScript, postgres.js, PostgreSQL 18 embedded (local), Vitest, Playwright, Foundry (contracts).
- **Tiến độ nghiệm thu** (`docs/ACCEPTANCE.md`, 142 ID): **70 PASS / 54 PARTIAL / 11 NOT_RUN / 2 BLOCKED / 5 REMOVED**.
  - Sau khi đóng DIGITAL (§5), XPL-04/05/06 sẽ thành PASS: 73 PASS, 8 NOT_RUN.
- **Đang dở:** P6 DIGITAL. Code + migration 0016 + 5/5 DB test đã xong và đã commit; **E2E digital chưa pass**, docs DIGITAL chưa viết. Chi tiết ở §5.

---

## 1. Quyền hạn, quyết định của user và luật làm việc

### 1.1 Chỉ thị hiện hành của user (2026-09-15)

Nguyên văn:

> "tiếp tục build, bạn cứ lưu file trước chưa cần supabase, build nền chạy trên arc testnet trước và cho phép bạn truy cập mạng lẫn foundry / 4a / 5 có / 6: 1 / đấu giá thì tạm làm sau, và tiếp tục build để hoàn thành plan / chạy full plan, không cần hỏi gì thêm, sau khi build xong tự audit luôn"

Nghĩa là:
- **Lưu và commit** công việc. **Chưa dùng Supabase** cho sản phẩm; mọi thứ chạy PostgreSQL local.
- **Nền crypto chạy trên Arc testnet trước.** Được **truy cập mạng** và **dùng Foundry**. Được cài package (đã cài `@radix-ui/react-select`).
- **4a:** escrow model A, non-custodial (ADR `docs/adr/002-escrow-custody.md`).
- **5 có:** làm PUBLISH trước trong P6 (đã xong W8-PUB).
- **6: 1:** publish dịch vụ chỉ cần **1** sample đã duyệt (`MIN_PUBLIC_SAMPLES = 1`).
- **Đấu giá tạm hoãn.** Không mở rộng auction. ACCESS/DIGITAL bị chặn tạo auction.
- **Chạy hết plan, không hỏi thêm, xong thì tự audit.**

Yêu cầu UI sau đó (đã làm và commit):
- Logo SVG nền trong suốt, đen/trắng theo giao diện (commit fe8798b).
- Thay mọi `<select>` xám bằng thư viện đẹp: Radix UI Select (commit ea76a4c).
- **"xoá cái order limit đi, vô nghĩa"**. User chọn: bỏ giới hạn, giữ Pause. Creator nhận không giới hạn đơn; chỉ còn `set_accepting_orders`. Buyer thấy `ACCEPTING`/`PAUSED`.
- **"Session availability, để họ tự thương lượng nhé, xoá luôn phần này"**. ACCESS không còn lịch rảnh/slot/appointment. Listing chỉ có `access_session_minutes`. Order `terms.access = { session_minutes, scheduling: 'AGREED_IN_MESSAGES' }`. Đơn ACCESS đi luồng start/deliver/approve bình thường.
- **Không được** đưa lại giới hạn đơn hay đặt lịch nếu user không yêu cầu.

Tin nhắn cuối: user sắp hết quota và yêu cầu viết file bàn giao này.

### 1.2 Vẫn cấm hoặc cần hỏi

- **Không** dùng tiền thật, mainnet, deploy công khai (kể cả redeploy waitlist Vercel) hay gửi email/tin nhắn ra ngoài khi user chưa cho phép lần đó.
- **Không in secret ra output.** Không đọc `cat` các file `.env*` hay `contracts/.env.local`. Không dùng Mirai key. Không gõ mật khẩu/API key.
  - Đăng nhập local bằng `POST /api/dev/session {"persona": "..."}`.
- **Không gọi `codex exec`.** Claude/agent tự làm cả UI lẫn backend.
- **Phí nền tảng chưa chốt:**
  - Code vẫn cưỡng chế phí = 0 (`platform_fee_bps: 0`).
  - Không tự đặt con số phí.
  - Không viết "0% fee" trong copy marketing.
- **Nhãn:** giữ tách bạch mock / sandbox / LOCAL devnet / TESTNET / live. Không claim PASS nếu chưa có test thật chạy qua.
- **Git:**
  - Agent là người commit duy nhất.
  - Chỉ `git add <đường dẫn cụ thể>`, **không `-A`**.
  - **Không** `reset`, `rebase`, `stash`.
  - **Luôn** chạy `git diff --cached --stat` trước khi commit.
  - Commit message kết thúc bằng `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` (hoặc trailer của agent tương ứng).
  - Không commit `next-env.d.ts`: Next dev tự sửa file này, luôn hiện "modified".
  - Muốn commit một phần file: tạo patch chỉ gồm các hunk cần, rồi `git apply --cached` (xem cách làm ở §5.6).

### 1.3 Sự cố bảo mật cần nhớ

- User từng dán **Resend API key** và **Supabase service_role key** vào chat. Đã khuyên rotate. Không bao giờ dùng lại hay in ra.
- Trong W9-ARC, zsh word-splitting từng **in ra 2 private key testnet vừa sinh** (chưa có tiền). Đã hủy ngay, sinh lại bằng script ghi file không in. Ghi trong `docs/evidence/claude-W9-ARC.md`.
- **Khi sinh key/secret:** chỉ ghi thẳng vào file mode 600, không echo.

---

## 2. Môi trường local (macOS, thư mục repo `outputs/creator-marketplace`)

### 2.1 Node, pnpm

```bash
export PATH=/Users/dohoangphi/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/dohoangphi/.local/node/bin:$PATH
node -v   # v24.19.0
```

- Không có binary `pnpm`. Dùng corepack (có mạng):
  - `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm add <pkg>`
  - Lockfile `pnpm-lock.yaml` v9, pnpm 11.19.0.
- Binary dùng trực tiếp: `./node_modules/.bin/{tsx,tsc,vitest,playwright,next}`.
- **Không có `eslint.config.*`**, nên `eslint` không chạy. Gap FND đã biết.

### 2.2 PostgreSQL embedded

- Địa chỉ `127.0.0.1:55432`, user admin `postgres` / `local_dev_only`, user app `app_server`.
- Hai DB: `creator_marketplace` (dev) và `creator_marketplace_test` (vitest).
- Kiểm tra cổng: `nc -z 127.0.0.1 55432`. Nếu đóng: `./node_modules/.bin/tsx scripts/postgres.ts start`.
- Migrate DB dev: `./node_modules/.bin/tsx scripts/migrate.ts`. File `drizzle/00NN_*.sql` chạy theo thứ tự, file đã chạy thì "skip".
- Chuẩn bị DB test (migrate + seed fixture): `./node_modules/.bin/tsx scripts/test-db.ts`.
- Seed DB dev: `./node_modules/.bin/tsx scripts/seed.ts`.
- Cả hai DB **đang ở migration 0017** (đã apply `0016_digital_products.sql` và `0017_no_order_limit_no_scheduling.sql`).
- **Backup cũ nên xóa khi audit xong:** `creator_marketplace_bak_0011`, `creator_marketplace_test_bak_0011`.
- Muốn chạy SQL ad-hoc: viết file `scripts/.q-tmp.ts` import `postgres`, chạy bằng tsx, rồi xóa file. Không có psql trong PATH.

### 2.3 Dev server và E2E

- `.claude/launch.json`:
  - `marketplace-dev`: Next dev `--webpack` ở **3100**;
  - `waitlist-dev`: port 3200, cwd `waitlist/`.
- E2E: `TZ=UTC ./node_modules/.bin/playwright test [file]`.
  - Dùng Chrome hệ thống, baseURL 3100, 1 worker, không tự khởi động server.
- **Mock payment provider và devnet giả lập nằm trong bộ nhớ process Next** (`globalThis`).
  - Restart dev server là mất state funding.
  - Đơn đã approve trước khi restart sẽ khiến job `release_ready_settlements` báo `ERROR` ("funding reference not found"), và `runJobs()` trong E2E fail.
  - **Hiện có đúng một đơn như vậy** trong DB dev: `c95bd250-1559-4f48-834e-80484a072e24` (PUBLISH, APPROVED, settlement READY, từ 2026-09-14). Nó làm `tests/e2e/book-order.spec.ts` fail.
  - Cách xử lý sạch: tạo lại DB dev (drop + create `creator_marketplace`, migrate, seed), hoặc viết job/runbook xử lý settlement mồ côi thành case.
  - **Không** tự sửa tay thành RELEASED, vì như vậy là bịa dữ kiện thanh toán.
- Chạy job local: `POST /api/dev/jobs` (cần same-origin). `runJobsOnce` chạy 13+ job.
- Persona fixture (`src/lib/fixtures.ts`): `creator_c`, `creator_d`, `buyer_a`, `buyer_b`, `dual_e`, `suspended`, `moderator`, `finance`, `admin`. Trang `/sign-in` có nút đăng nhập nhanh cho test account.

### 2.4 Lệnh kiểm tra chuẩn

```bash
./node_modules/.bin/tsc --noEmit -p tsconfig.json --incremental false        # type
RUN_DB_INTEGRATION=1 ./node_modules/.bin/vitest run                          # unit + DB (≈30 file)
RUN_DB_INTEGRATION=1 ./node_modules/.bin/vitest run tests/integration/<x>.db.test.ts
RUN_ANVIL=1 RUN_DB_INTEGRATION=1 ./node_modules/.bin/vitest run tests/integration/escrow.anvil.test.ts   # cần anvil
./node_modules/.bin/tsx scripts/release-check.ts                             # gồm chặn mainnet
./node_modules/.bin/tsx scripts/discovery-benchmark.ts                       # DSC-06 benchmark
cd contracts && ./install-deps.sh && forge build && forge test               # Foundry 17 test (fuzz/invariant)
cd waitlist && ../node_modules/.bin/tsc --noEmit -p tsconfig.json            # waitlist
```

### 2.5 Arc testnet

- **Thông số** (đã kiểm với RPC thật 2026-09-15):
  - chain id `5042002`, RPC `https://rpc.testnet.arc.io`, explorer `https://testnet.arcscan.app`, faucet `https://faucet.circle.com` (có CAPTCHA, cần người).
  - USDC ERC-20 `0x3600000000000000000000000000000000000000` (6 decimals). Native gas là USDC 18 decimals.
  - Finality 1 confirmation, base fee tối thiểu 20 gwei.
- **Key testnet:** `contracts/.env.local` (git-ignored, mode 600). **Không in ra.**
  - Deployer/executor: `0x7758186cD9FE0156fd5F631e5c944445D9c1e97F`, **đang 0 USDC**.
  - Release signer: `0x4721DD4B6f1C9b66BDf22784B988EAAEBB7663e2`.
- **Runbook deploy:** `docs/ARC_TESTNET.md`.
  1. User nạp faucet cho deployer.
  2. `forge script script/Deploy.s.sol --broadcast`.
  3. `ESCROW_ADDRESS=... tsx scripts/arc-testnet.ts register`.
- Kiểm tra mạng: `./node_modules/.bin/tsx scripts/arc-testnet.ts check`.

---

## 3. Kiến trúc và quy ước code (bắt buộc làm theo để code mới đồng nhất)

### 3.1 Cấu trúc

- `drizzle/00NN_<tên>.sql`: migration SQL thuần.
  - Mọi bất biến tài chính/tồn kho **phải có ở DB**: CHECK, trigger, exclusion constraint, unique partial index. Không chỉ dựa vào code.
  - Trigger chuyển trạng thái đơn: `app.order_transition_guard` (0004).
  - `app.reject_mutation()` dùng cho bảng append-only.
- `src/lib/commands.ts`:
  - `CommandHandler`, `CommandError(message, code)`, `statusForCode`.
  - Mã lỗi gồm `SLOT_TAKEN` và `SOLD_OUT` (409, SOLD_OUT thêm trong phần DIGITAL chưa commit), `SLOT_EXPIRED` (422), `FEATURE_DISABLED` (422), `RATE_LIMITED` (429).
  - Helper `text`, `integer`, `money`, `uuid`, `httpUrl`, `orderEvent`.
- `src/modules/commands.ts`: registry gộp handler từ các module. Tên command trùng thì throw.
  - Module hiện có: catalog, orders, requests, auctions, rewards, crypto, pools, publish, moderation, access, digital (chưa commit), admin.
- `src/app/api/commands/route.ts`: envelope POST form cho mọi lệnh.
  - Kiểm same-origin, session, idempotency key, map lỗi.
  - Hint trigger `CAPACITY_UNAVAILABLE`/`NOT_ACCEPTING_ORDERS` được map thành 409.
- `src/lib/json-route.ts`: route JSON (assets, wallets, digital download).
- `src/lib/read-model.ts`: dữ liệu cho page: `getServiceData`, `getOrderData`, `getDashboardData`, `serviceRows`…
- `src/modules/*`, mỗi domain một thư mục:
  - `capacity`: giới hạn đơn đang làm, `workload_claims`.
  - `access`: lịch ACCESS.
  - `digital`: đang dở.
  - `publish`, `moderation`.
  - `payments/funding.ts`: mọi dữ kiện funding/refund/release, cả rail CRYPTO/POOL.
  - `crypto`: registry, chain simulator, EVM adapter, payout outbox.
  - `pools`, `requests`, `auctions`, `storage`, `jobs`, `notifications`, `discovery`, `admin`.
- UI:
  - `src/app/**/page.tsx` là server component.
  - `src/components/ui.tsx` có `CommandForm` (form POST thuần tới `/api/commands`), `Field`, `Badge`, `availabilityLabel`.
  - `src/components/select.tsx` có `Select` và `SelectField` (Radix UI).
  - CSS thuần trong `src/app/globals.css`, landing dùng `src/components/landing/landing.module.css`.
  - Phong cách: trắng đen kiểu Apple, màu chỉ dùng cho ý nghĩa (xanh = xong, cam = chờ, đỏ = lỗi).
- Contracts: `contracts/src/SpacaEscrow.sol`, test ở `contracts/test/`.

### 3.2 Quy ước quan trọng

- **Lock order** (master §6.4): aggregate (request/auction/pool) → workload creator → appointment/entitlement → order → funding → settlement.
  - Advisory lock dùng `pg_advisory_xact_lock(hashtextextended('<key>', 0))`.
- **Không gọi chain/provider bên ngoài trong DB transaction.**
  - Payout crypto đi qua outbox `app.chain_payouts` và worker `dispatch_chain_payouts`.
- **Terms snapshot:** `orders.terms` (jsonb) chụp điều khoản lúc mua, gồm `publish`, `access`, `digital`. Mọi rule sau đó đọc từ snapshot, không đọc listing hiện tại.
- **Flags** (`app.feature_flags`, thiếu dòng = tắt):
  - `BOOKING_ENABLED`, `REQUESTS_ENABLED`, `AUCTIONS_ENABLED`, `CRYPTO_CHECKOUT_ENABLED`, `TOKEN_REWARDS_ENABLED`, `NFT_REWARDS_ENABLED`, `DISCOVERY_ADVANCED_ENABLED`, `ACCESS_BOOKING_ENABLED`, `DIGITAL_PRODUCTS_ENABLED`, `LIVE_PAYMENTS_ENABLED`, `CHECKOUT_CREATION_ENABLED`, `BIDDING_ENABLED`, `PAYOUT_CREATION_ENABLED`.
  - Admin bật/tắt ở `/admin/flags` (bắt buộc ghi lý do audit).
  - **DB dev hiện đang BẬT `ACCESS_BOOKING_ENABLED` và `DIGITAL_PRODUCTS_ENABLED`** do E2E. Migration để mặc định tắt.
- **Test DB** (`tests/integration/*.db.test.ts`):
  - `vi.mock('next/headers')` đọc `sessionState.token`, gọi thẳng route handler qua `callRoute`.
  - Harness `tests/integration/harness.ts`: `createUser`, `key`, `createPublishedService`, `workloadCounters`, `workloadDrift`, `linkXAccount`.
  - Test tự bật flag bằng `update app.feature_flags` rồi tắt lại ở `afterAll`.
  - Giả lập thời gian: `vi.useFakeTimers({ toFake: ['Date'] })` + `vi.setSystemTime(...)`. Chỉ fake Date, không fake timer của postgres.js.
  - `fileParallelism: false`.
- **Test E2E** (`tests/e2e/helpers.ts`):
  - `login(page, persona)`, `visit`, `submit` (chờ navigation, không có `?error=`), `orderPath`, `expectOrderState`, `payOrder`, `runJobs`, `createPublishedService`.
  - `chooseOption(page, scope, label, optionText)` cho select Radix: mở combobox theo label, click option theo chữ hiển thị.
  - **Bẫy hydration:** client component (upload file, slot picker, select) không phản hồi nếu thao tác trước khi React hydrate.
    - Cách xử lý: chờ element có key `__reactProps…`, hoặc dùng `expect(...).toPass()` như `chooseOption`.
    - Form lịch rảnh (`AvailabilityEditor`) cố ý là form HTML thuần để khỏi dính lỗi này.
- **Evidence:** mỗi đợt xong viết `docs/evidence/claude-<ID>.md` (mẫu: `claude-P6-ACCESS.md`). Sau đó:
  - cập nhật dòng + tổng đếm trong `docs/ACCEPTANCE.md`;
  - thêm section trong `docs/UI_CONTRACT.md`;
  - thêm dòng trong `docs/COLLABORATION.md`.

---

## 4. Đã xong và đã commit (mới nhất ở trên)

| Commit | Nội dung chính | Evidence / Acceptance |
|---|---|---|
| **(commit mới nhất)** | Bỏ order limit + bỏ đặt lịch ACCESS (migration 0017, xóa `src/modules/access`, slots API, slot picker, availability editor, session panel, test ACCESS). Khung "New orders" chỉ còn số đơn đang làm + Pause. **Kèm toàn bộ code DIGITAL** (migration 0016, `src/modules/digital`, UI, `digital.db.test.ts` 5/5; E2E digital chưa pass). | vitest 251/254 (3 skip), E2E 14/15 |
| **ea76a4c** | UI: thay 17 `<select>` bằng Radix UI Select (`src/components/select.tsx`). Native select ẩn giữ giá trị cho form POST/GET. Label danh mục "Create · content you deliver"… E2E dùng `chooseOption`. | E2E 10/11 (book-order fail do đơn mồ côi, §2.3) |
| **fe8798b** | Logo SVG không nền, `currentColor` (đen trên sáng, trắng trên tối). Favicon SVG đổi màu theo `prefers-color-scheme`. Email chào mừng dùng `waitlist/public/email/spaca-icon.svg` (fill tối cố định). **Waitlist trên Vercel chưa redeploy.** | Test email 3/3, E2E public/responsive 5/5 |
| **96dabf0** | **P6-ACCESS**: migration 0015 (availability windows, appointments có GiST exclusion [start, end+buffer), trigger sync với đơn), `src/modules/access/{time,index,commands}.ts`, `GET /api/services/[id]/slots`, slot picker, form lịch rảnh, Session panel. | `claude-P6-ACCESS.md`; CAP-11, XPL-03 PASS |
| **a26abb4** | **W9-ARC**: contract `SpacaEscrow` (bucket theo đơn/pool-asset, EIP-712 release/refund/freeze, payer reclaim, guardian pause, Ownable2Step), Foundry 17 test, migration 0014 (`chain_payouts` outbox), viem adapter, anvil E2E, script Arc, chặn mainnet trong release-check, ADR 002. | `claude-W9-ARC.md`; CRY-04/05/07/10/11/13/14 PASS local |
| **bce2dff** | **W8-PUB**: social accounts self-reported, điều khoản PUBLISH, bằng chứng bài đăng trên đúng kênh, lọc nội dung, report queue, publish với 1 sample. Migration 0013. | `claude-W8-PUB.md`; XPL-01/02, MOD-01/02, SUP-01/05/06 PASS |
| **5d169eb** | Redesign UI spaca + **W7-CAP** (capacity = số đơn đang làm cùng lúc, migration 0012), tài khoản test ở `/sign-in`. | `claude-W7-CAP.md` |
| c3570b6 | Master: thanh toán Arc §11.7, Performance campaigns §9.6, `docs/MARKETING_BRIEF.md` | — |
| 1d9e950 | Waitlist `waitlist/` (Supabase + Resend), đã deploy https://spaca-waitlist.vercel.app | — |
| 7244b8a … trước | P0, P1A/P1B, W2-B admin/roles/flags, W2-S storage, W3-R requests, W4-A auctions, W5-C1 crypto checkout devnet, W5-C2 pools, W6-D discovery, C3/C5/C6 | `claude-W1..W6*.md` |

**Kết quả kiểm chứng full gần nhất** (ngay sau commit ACCESS, **trước** DIGITAL và Select):
- `vitest` 261 passed + 3 skipped (anvil opt-in);
- tsc 0 lỗi;
- E2E ACCESS 1/1;
- Foundry 17/17;
- release-check PASS.

**Sau DIGITAL + Select chưa chạy lại full suite.** Việc đầu tiên ở §5.

---

## 5. VIỆC ĐANG DỞ: P6 DIGITAL (XPL-04, XPL-05, XPL-06). Code ĐÃ commit, còn E2E + docs

> Toàn bộ file liệt kê ở §5.2 **đã nằm trong commit mới nhất**, cùng việc bỏ order limit/ACCESS scheduling. Các chỗ "chưa commit" ở §5.2/§5.4 bước 9 là lịch sử. Còn lại: §5.3 (E2E) và §5.4 bước 2–8, sau đó commit docs/test.
> Bỏ qua mọi nhắc tới access ở §5.2 (vd. `ACCESS_COLUMNS` giờ chỉ còn `access_session_minutes`; `next-step-panel` không còn `appointment`).

### 5.1 Thiết kế đã chốt (đã code)

- Listing `DIGITAL` bán **licence cho file có sẵn, có version**. Master §16.9 P6-05/06.
- **Không chiếm workload creator** (XPL-04). Giữ chỗ bằng **entitlement** thay cho `workload_claims`.
- **Licence:**
  - `NON_EXCLUSIVE`: bán nhiều bản; `digital_stock` null = không giới hạn.
  - `EXCLUSIVE`: stock bắt buộc = 1 (CHECK). Chỉ 1 người giữ tại một thời điểm.
- **Update policy:** `LATEST` (nhận mọi version mới) hoặc `PURCHASED_VERSION` (chỉ version ≤ version lúc mua).
- `digital_download_limit`: số lần tải cho mỗi lần mua (1–1000, mặc định 10).
- **Vòng đời:**
  1. `book` tạo đơn `AWAITING_PAYMENT` và entitlement `HELD` (hết hạn theo hold checkout 15 phút).
  2. Thanh toán thành công → trigger đổi entitlement thành `ACTIVE`, rồi `fulfillDigitalOrder` chuyển đơn FUNDED → IN_PROGRESS → **DELIVERED**, tạo delivery hệ thống v1, đặt review window, gửi notification `order.delivered`.
  3. Buyer approve (hoặc auto-accept khi có consent), rồi settlement bình thường.
- **Refund (policy `digital-v1`):**
  - Buyer được tự hủy **trước lần tải đầu tiên** và trong review window: lệnh `refund_digital_purchase` → CANCELLED + refund toàn phần → entitlement `REVOKED`.
  - Sau khi đã tải: chỉ còn dispute hoặc mutual cancellation (`request_cancellation`/`respond_cancellation`). Khi CANCELLED/REFUNDED thì cũng REVOKED.
  - `start`/`deliver`/`revision` bị từ chối với đơn digital.
- **Tải file:** chỉ buyer có entitlement `ACTIVE`.
  - `POST /api/digital/entitlements/[id]/download-url {version?}` trả URL ký 5 phút, tăng `download_count`, ghi `app.digital_downloads`.
  - Người khác nhận 404. Route asset thường (`/api/assets/[id]/download-url`) với purpose `DIGITAL` chỉ cho **creator chủ file**.
- **DB chặn bán trùng:** trigger `digital_entitlement_guard` lấy advisory lock theo sản phẩm, kiểm stock/exclusive (HINT `SOLD_OUT`), cộng unique partial index `digital_entitlements_one_exclusive`.
- **Không auction ACCESS/DIGITAL:** `createAuction` từ chối.

### 5.2 File đã tạo/sửa (chưa commit)

**Mới (untracked):**
- `drizzle/0016_digital_products.sql`:
  - purpose storage `DIGITAL` + bucket `private-products`;
  - cột `digital_*` trên `services`/`service_versions` + CHECK;
  - bảng `digital_releases` (append-only), `digital_entitlements` (trigger guard + sync với đơn), `digital_downloads`;
  - cập nhật `storage_asset_guard` (không xóa file đang là release).
  - **Đã apply ở DB dev và test.**
- `src/modules/digital/index.ts`: `digitalFields`, `digitalTermsOf`, `latestReleaseVersion`, `digitalAvailability`, `holdEntitlement`, `fulfillDigitalOrder`, `downloadableReleases`, `createEntitlementDownload`.
- `src/modules/digital/commands.ts`: `add_digital_release`, `refund_digital_purchase`.
- `src/app/api/digital/entitlements/[id]/download-url/route.ts`
- `src/components/digital/download-button.tsx` (client)
- `src/components/order-workspace/digital-panel.tsx` ("Files for this purchase")
- `tests/integration/digital.db.test.ts`: **5/5 PASS**.
- `tests/e2e/digital.spec.ts`: **đang FAIL**, xem §5.3.

**Sửa (modified, chưa commit):**
- `src/lib/commands.ts`: mã `SOLD_OUT` (409).
- `src/modules/commands.ts`: đăng ký `digitalCommands`.
- `src/modules/catalog/commands.ts`:
  - `DIGITAL_COLUMNS`, snapshot version, `assertPublishable` (flag + đủ terms + có release);
  - create/update service nhận `digital_*`;
  - `book`: DIGITAL không cần brief, cần `accept_license=on`, `digitalPurchaseOf`, `holdEntitlement` thay cho `claimWorkload`, `terms.capacity = { model: 'DIGITAL_STOCK', units: 0 }`.
- `src/modules/orders/commands.ts`: chặn start/deliver/revision với digital.
- `src/modules/payments/funding.ts`: `lockCheckoutHold` (claim **hoặc** entitlement) ở `ensureFundingIntent`, funding mock và funding chain; gọi `fulfillDigitalOrder` sau funding mock và chain (không gọi ở pool).
- `src/modules/crypto/commands.ts`: kiểm hold có `union all` với entitlement.
- `src/modules/jobs/index.ts`:
  - `expireCheckoutHolds` quét cả entitlement hết hạn (`hold_table`);
  - `cleanup_storage` dọn cả file DIGITAL mồ côi (chưa thành release sau 24 h).
- `src/modules/auctions/commands.ts`: chặn ACCESS/DIGITAL.
- `src/modules/storage/{policy,provider,service}.ts`: purpose `DIGITAL`, kind `archive` (`application/zip`, 100 MB), bucket `private-products`, quyền download purpose DIGITAL chỉ cho owner.
- `src/modules/discovery/search.ts`: `availability_status` của DIGITAL = `SOLD_OUT`/`ACCEPTING` theo stock.
- `src/lib/read-model.ts`: `withAvailability` cho DIGITAL; `getOrderData().digital` (entitlement + releases); `getServiceData().digital`; `serviceRows` owner có `releases`, `licenses`.
- `src/components/ui.tsx`: nhãn `SOLD_OUT` = "Sold out".
- `src/components/files/file-upload-field.tsx`: purpose `DIGITAL`, nhận `.zip`, chuẩn hóa MIME zip.
- `src/components/order-workspace/next-step-panel.tsx`: prop `digital` (ẩn revision, chữ hủy "reserved copy").
- `src/app/orders/[orderId]/page.tsx`: render `OrderDigitalPanel`.
- `src/app/services/[id]/page.tsx`: điều khoản licence, checkbox `accept_license`, nút "Buy license", trạng thái Sold out / Purchases paused.
- `src/app/creator/services/page.tsx`: card DIGITAL có danh sách version + form "Add product file"/"Add new version" (`FileUploadField purpose="DIGITAL" maxFiles={1}`).
- `src/app/creator/services/new/page.tsx`: **hunk DIGITAL** ("If you chose DIGITAL": License, Buyers get, Copies, Downloads per purchase, rights text). Các hunk Select khác của file này đã commit.
- `src/app/globals.css`: **hunk DIGITAL CSS** (`.digital-releases`, `.release-list`, `.download-action`). Phần Select CSS đã commit.
- `next-env.d.ts`: **bỏ qua, không commit.**

### 5.3 Lỗi E2E DIGITAL và cách sửa đề xuất (chưa áp dụng)

- **Triệu chứng:** ở `tests/e2e/digital.spec.ts`, sau `setInputFiles` trên card dịch vụ, không thấy chữ "Ready". Danh sách file trống.
- **Nguyên nhân:** `FileUploadField` là client component. File được chọn **trước khi hydrate**, nên `onChange` không chạy.
- **Sửa đề xuất:** thay dòng `await card.locator('input[type="file"]').setInputFiles(...)` bằng:

```ts
const fileInput = card.locator('input[type="file"]');
// The upload field is a client component: files chosen before hydration would never be sent.
await expect.poll(() => fileInput.evaluate((el) => Object.keys(el).some((k) => k.startsWith('__reactProps')))).toBe(true);
await fileInput.setInputFiles({ name: 'launch-kit.zip', mimeType: 'application/zip', buffer: fileBytes });
```

- User đã **từ chối (interrupt) lần gọi tool áp dụng sửa này** rồi hỏi chuyện khác. Chưa rõ user phản đối cách sửa hay chỉ muốn dừng.
  - Nếu tiếp tục: áp dụng cách trên, hoặc cách tương đương dùng `expect(async () => {...}).toPass()` như `chooseOption`.
- **Các bước sau trong spec có thể lỗi tiếp** (chưa chạy tới):
  1. Nút `Add product file` phải xuất hiện (label phụ thuộc chưa có release).
  2. `Version 1 · launch-kit.zip` phải hiện.
  3. Trang dịch vụ của buyer: checkbox "I accept the license above for version 1".
  4. Sau `payOrder` đơn phải là `DELIVERED`.
  5. `page.waitForEvent('download')` khi bấm "Download version 1". Route dev download trả `content-disposition: attachment`.
  6. Reload thấy "1 of 3 used" và mất nút "Cancel before downloading".
  7. `buyer_b` mở đơn → 404.
  8. Viewport 390 px không tràn ngang.
- Spec đã dùng `chooseOption` cho flag và danh mục ("Digital · ready-made files").

### 5.4 Việc cần làm để đóng DIGITAL (theo thứ tự)

1. `tsc` → sửa E2E như §5.3 → `TZ=UTC ./node_modules/.bin/playwright test tests/e2e/digital.spec.ts` cho tới khi PASS.
2. Chạy full: `RUN_DB_INTEGRATION=1 ./node_modules/.bin/vitest run`, cần 0 fail.
   - Chú ý test storage có thể kiểm danh sách purpose/bucket.
   - `tests/integration/crypto.db.test.ts` và `pools.db.test.ts` chạm funding (đã đổi `lockCheckoutHold`).
3. Chạy lại E2E liên quan: `book-order` (xử lý đơn mồ côi §2.3 trước), `request-hire`, `revision-dispute`, `access`, `publish`, `admin`, `auction`, `public`, `responsive`.
4. `./node_modules/.bin/tsx scripts/release-check.ts` và `scripts/discovery-benchmark.ts`.
   - Benchmark có thể cần cột `digital_*` cho listing DIGITAL sinh ra, giống cách đã thêm `access_*` trong `scripts/discovery-benchmark.ts`.
   - **Kiểm tra thật.** CHECK `services_digital_terms_complete` sẽ chặn listing DIGITAL PUBLISHED thiếu terms, và benchmark insert taxonomy DIGITAL.
5. **Viết `docs/evidence/claude-P6-DIGITAL.md`** theo mẫu `claude-P6-ACCESS.md`:
   - What changed: nội dung §5.1–5.2.
   - Tests run: số liệu thật.
   - Limits:
     - không có quét antivirus thật (chỉ kiểm chữ ký file);
     - đơn DIGITAL qua Request/hire không tạo entitlement;
     - dispute resolve về IN_PROGRESS cho đơn digital sẽ kẹt vì deliver bị chặn;
     - licence là text do creator viết, chưa có review pháp lý;
     - download URL ký sau commit (nếu ký lỗi thì mất 1 lượt tải).
6. **`docs/ACCEPTANCE.md`:**
   - XPL-04, XPL-05, XPL-06 → PASS, cột bằng chứng trỏ evidence;
   - sửa dòng tổng: **78 PASS, 54 PARTIAL, 8 NOT_RUN, 2 BLOCKED** (nếu đúng).
7. **`docs/UI_CONTRACT.md`:** thêm section "P6-DIGITAL additions" gồm:
   - field service `digital_license`, `digital_rights_text`, `digital_stock`, `digital_updates`, `digital_download_limit`;
   - `book` với `accept_license`;
   - lỗi 409 `SOLD_OUT`, 422 `FEATURE_DISABLED`;
   - `terms.digital`;
   - `getOrderData().digital`, `getServiceData().digital`, `availability_status SOLD_OUT`;
   - lệnh `add_digital_release {service_id, asset_ids, notes}` và `refund_digital_purchase {order_id, reason?}`;
   - route download;
   - upload purpose `DIGITAL`;
   - event `DIGITAL_DELIVERED`, `DIGITAL_PURCHASE_CANCELLED`.
8. **`docs/COLLABORATION.md`:** đổi dòng `W7 | P6 remaining: DIGITAL…` thành dòng `P6-DIGITAL … DONE`.
9. **Commit** (một commit "P6-DIGITAL: …"):
   - `git add` từng file ở §5.2 (trừ `next-env.d.ts`) + docs.
   - Riêng `src/app/globals.css` và `src/app/creator/services/new/page.tsx`: lúc này chỉ còn hunk DIGITAL chưa commit, nên `git add` cả file được. Kiểm bằng `git diff <file>` trước.
   - `git diff --cached --stat` trước khi commit.

---

## 6. VIỆC CÒN LẠI SAU DIGITAL (làm theo thứ tự; mỗi việc cần migration + commands + tests DB + E2E khi có UI + evidence + ACCEPTANCE/UI_CONTRACT)

### 6.1 NOT_RUN tự làm được ở local

| # | ID | Yêu cầu (master §18) | Gợi ý thiết kế cụ thể |
|---|---|---|---|
| 1 | **ORD-12** | Gia hạn deadline do hai bên đồng ý, lưu thành amendment bất biến | Xem chi tiết bên dưới bảng. |
| 2 | **ORD-14** | Giữ lịch sử đơn đã COMPLETED khi bị chargeback | Xem chi tiết bên dưới bảng. |
| 3 | **PAY-15** | Theo dõi thiếu hụt khi refund sau khi đã chuyển tiền cho creator, không bịa tiền đã thu hồi | Tài khoản ledger `creator_recovery_receivable:<creator>` / `platform_loss:<order>`, bảng `refund_deficits` (amount, recovered_minor, status OPEN/RECOVERED/WRITTEN_OFF), chỉ RECOVERED khi có dữ kiện thật. Case cho finance. |
| 4 | **PAY-16** | Chi phí thực tế đến muộn (phí provider…) có trần rõ ràng, không tạo nợ tùy ý | Bảng `late_costs` với cap theo policy snapshot (vd. ≤ provider_fee đã báo + X). Vượt cap thì mở case, không trừ vào creator. |
| 5 | **BNK-01** | Chờ funding ngân hàng async được xác minh rồi mới làm | Xem chi tiết bên dưới bảng. |
| 6 | **BNK-02** | Hold riêng cho bank, xử lý funding muộn và tiền bị trả lại (return) | Xem chi tiết bên dưới bảng. |
| 7 | **BNK-03** | Từ chối funding bank bị tắt/không hỗ trợ qua API trực tiếp | Test lệnh trực tiếp khi flag off (422 `FEATURE_DISABLED`) và method không hỗ trợ (400). |
| 8 | **OPS-02** | Restore backup vào DB cô lập và replay an toàn, bảo toàn nghĩa vụ tài chính | Xem chi tiết bên dưới bảng. |

**Chi tiết ORD-12:**
- Bảng `order_amendments` (order_id, kind DEADLINE_EXTENSION, proposed_by, counterparty, old_due, new_due, reason, status REQUESTED/ACCEPTED/REJECTED/EXPIRED/WITHDRAWN, order_version, responded_at). Trigger bất biến sau khi quyết.
- Lệnh `request_deadline_extension` và `respond_deadline_extension`. Khi ACCEPTED: `delivery_due_at = new_due`, event `DEADLINE_EXTENDED`.
- Hết hạn khi có delivery/dispute, mẫu giống `cancellation_requests` trong `src/modules/orders/commands.ts`.
- Test: không tự gia hạn một phía; version conflict; lịch sử giữ nguyên.

**Chi tiết ORD-14:**
- Thêm dữ kiện `payment.dispute_opened/won/lost` vào `MockPaymentProvider` và `funding.ts`.
- Đơn COMPLETED **không đổi status**. Thêm cột `chargeback_status` (NONE/OPEN/WON/LOST) + bảng `payment_disputes`.
- Ledger đảo khi LOST, mở case HIGH, không xóa review/delivery.
- Test: webhook ký đúng/sai, idempotent.

**Chi tiết BNK-01:**
- Flag `BANK_FUNDING_ENABLED` (mặc định off), `payment_rail='BANK'`.
- Mock bank provider: `bank.transfer_pending` → `bank.settled` / `bank.failed` / `bank.returned`.
- Đơn giữ `AWAITING_PAYMENT` (payment_status PROCESSING) tới khi `settled`.
- Workload claim/entitlement dùng **hold riêng dài hơn** (vd. 3 ngày làm việc), không tái dùng hold 15 phút.
- Không nhận screenshot chuyển khoản làm bằng chứng.

**Chi tiết BNK-02:**
- `bank.settled` sau khi hold đã hết thì theo đường LATE_FUNDING (case + refund), giống card.
- `bank.returned` sau khi FUNDED thì mở case, freeze settlement, không release.
- Có policy snapshot `bank-v1`.

**Chi tiết OPS-02:**
- Script `scripts/restore-rehearsal.ts`:
  1. `pg_dump` DB dev (dùng binary embedded-postgres trong node_modules) → restore vào `creator_marketplace_restore_<ts>`;
  2. chạy migrate;
  3. chạy job reconcile ở chế độ dry-run;
  4. kiểm bất biến: tổng ledger theo order = 0, `workload_counter_drift` = 0, pool conservation, không có payout QUEUED bị gửi lặp.
- Runbook `docs/runbooks/NN-restore.md`, xong thì xóa DB tạm.

### 6.2 Tính năng sản phẩm/UI còn thiếu (backend có hoặc spec có)

1. **Performance campaigns** (master §9.6):
   - Campaign trả theo kết quả đo bằng click/on-chain, không đếm view X.
   - Adapter metrics (mock), flag mặc định off, không hứa doanh thu.
2. **Explore theo mục tiêu:** goal → playbook → danh sách creator → xem sample.
   - Ngân sách micro (master §11.7). Cần trang và read model mới.
3. **UI campaign pool** (W5-C2 đã có backend `src/modules/pools`): tạo pool, nạp, template phần thưởng, allocation khi hire, refund phần chưa dùng.
4. **UI liên kết ví** (W5-C1: `src/modules/crypto/wallets.ts`, API `/api/wallets`): chứng minh sở hữu ví qua browser wallet, hiển thị nhãn LOCAL/TESTNET.
5. **REQ-11:** sort/filter màn so sánh báo giá, xuất CSV, analytics hires vs applications.
6. Request/hire cho ACCESS (tạo appointment khi hire) và DIGITAL (hiện chưa có). Ghi trong limits.

### 6.3 PARTIAL làm được ở local (54 dòng; ưu tiên các dòng dưới)

- **Race tests:**
  - CAP-04 (UNKNOWN payment + checkout cạnh tranh), CAP-05 (funding muộn sau khi slot đã bán lại), CAP-10 (funding vs expiry đồng thời);
  - REQ-07 (offer expiry/accept/webhook), ORD-10, ORD-15, PAY-13, PAY-14.
  - Dùng `Promise.all` như `access.db.test.ts`.
- **Crash recovery:** PAY-11 và OPS-01 (remote transfer thành công rồi DB crash, restart không release trùng). Cần tách journal.
- **Security matrices:**
  - SEC-01/02/04 (foreign buyer/creator, client gửi fee/payee);
  - SEC-07 (script/URL/SSRF);
  - SEC-08 (session hết hạn trên lệnh tài chính);
  - SEC-10 (seller bị suspend vẫn truy cập nghĩa vụ);
  - SEC-11 (scan log/bundle không lộ secret).
- **Browser evidence:**
  - FND-04, SUP-02 ("New creator/—"), SUP-03 (consent khi đổi version), ORD-02, REV-03, DSC-02 (empty/error state), OPS-07 (768/1440, chỉ bàn phím, text dài).
- **Khác:**
  - ORD-03 (case CREATE không qua auction), ORD-07 (link delivery không truy cập được), ORD-11, ORD-13, ORD-16;
  - PAY-01..04, PAY-06/08/09/17/20;
  - FND-01/02 (clean checkout + frozen install + CI), FND-05, FND-07;
  - OPS-03 (app cũ trên schema mới / rollback), OPS-05, OPS-06 (báo cáo tuần), OPS-08.
- **Hạ tầng:**
  - thêm `eslint.config.mjs`;
  - rate limiter chung;
  - MFA cho admin;
  - scheduler thật (Inngest có trong deps);
  - `reconcile:dry-run`.
- Danh sách đầy đủ kèm lý do: `grep "| PARTIAL |" docs/ACCEPTANCE.md`.

### 6.4 Tự audit cuối (user yêu cầu)

1. Chạy toàn bộ: tsc, `RUN_DB_INTEGRATION=1 vitest run`, anvil test, `forge test`, toàn bộ E2E, release-check, benchmark.
2. Review bảo mật từng module mới (access, digital, escrow, payouts):
   - quyền truy cập theo actor;
   - lock order;
   - không gọi bên ngoài trong transaction;
   - không lộ URL private/secret trong event/log;
   - CHECK/trigger đủ.
3. Rà `docs/ACCEPTANCE.md`: không claim PASS sai. Cập nhật `BUILD_STATUS.md`, `HANDOFF.md`, `REQUIREMENTS_TRACEABILITY.md`, runbooks.
4. Xóa DB backup `*_bak_0011`. Tắt các flag bật tạm ở DB dev nếu cần.
5. Báo cáo cho user:
   - con số thật;
   - việc bị chặn (§7);
   - nhắc nạp faucet;
   - nhắc rotate key;
   - sự cố in key.

---

## 7. Bị chặn bởi bên ngoài / cần user

| Việc | Cần gì |
|---|---|
| Deploy `SpacaEscrow` lên **Arc testnet** (CRY-01 PARTIAL) | User nạp USDC testnet cho `0x7758186cD9FE0156fd5F631e5c944445D9c1e97F` tại https://faucet.circle.com (Arc Testnet). Sau đó chạy runbook `docs/ARC_TESTNET.md`. Luồng browser wallet chưa thử với ví thật. |
| **SEC-03** (chặn Data API vào schema private) | Supabase/staging thật (user nói chưa cần Supabase). |
| **PAY-19** (chi trả ngân hàng) và nhiều PAY PARTIAL | Provider thanh toán/payout thật, tài khoản của user. |
| Mức phí nền tảng | User quyết định. |
| Pháp lý (escrow giữ tiền người dùng, licence DIGITAL, Privacy, địa chỉ gửi thư) | Luật sư/user. |
| Mainnet | Audit bảo mật độc lập, multisig owner/guardian, signer KMS, xem lại Arc mainnet (ADR 002 §Before mainnet). |
| Waitlist | Redeploy Vercel để lên logo SVG (cần user cho phép). Verify domain Resend (hiện gửi từ `onboarding@resend.dev`). Điền `WAITLIST_MAILING_ADDRESS`, sửa dòng `[REVIEW WITH LEGAL…]` ở `/privacy`. Lưu ý Gmail/Outlook desktop không hiện ảnh SVG trong email; nếu user muốn icon hiện mọi nơi, riêng email phải quay lại PNG nền trong suốt. |

---

## 8. Waitlist (tách khỏi sản phẩm chính)

- **Code:** `waitlist/` (Next riêng, port 3200 local).
- **Production:** Vercel project `spaca-waitlist`, https://spaca-waitlist.vercel.app.
- **Dữ liệu:** Supabase schema `waitlist.signups` (SQL gộp ở `waitlist/supabase-setup.sql`).
- **Email chào mừng:** Resend, template `waitlist/lib/email/welcome.ts`, xem trước ở `/email-preview`.
- **Env trên Vercel** (user tự nhập, không in ra): `WAITLIST_DATABASE_URL`, `WAITLIST_IP_SALT`, `RESEND_API_KEY`, `WAITLIST_EMAIL_FROM`, `WAITLIST_EMAIL_REPLY_TO`.
- `waitlist/.env.local` có secret, git-ignored, **không đọc/in**.
- Liên hệ trên trang Privacy: fia.absolute07@gmail.com.

---

## 9. Yêu cầu riêng, KHÔNG gộp vào việc build

User từng yêu cầu "đóng vai Head of Design, tạo prompt xây UI tham khảo Fiverr". Việc này bị gián đoạn: mới mở fiverr.com, chưa phân tích, chưa viết prompt. Nếu làm thì làm ở phiên riêng.
