# Bàn giao cho agent/phiên tiếp theo — spaca (cập nhật 2026-09-15, cuối phiên Claude, commit `d898592`)

> Đọc hết file này trước khi làm. Sau đó đọc theo thứ tự:
> 1. `docs/MASTER_PROMPT.md`: đặc tả gốc. Roadmap ở §16, bảng acceptance ở §18.
> 2. `docs/ACCEPTANCE.md`: sổ nghiệm thu, mỗi dòng một ID §18.
> 3. `docs/UI_CONTRACT.md`: hợp đồng dữ liệu và lệnh cho UI.
> 4. `docs/evidence/claude-*.md`: bằng chứng từng đợt. Mới nhất: `claude-AUDIT-2026-09-15.md`, `claude-UX-WORKSPACE.md`, `claude-SEC-11-DSC-05.md`.

## 0. Tóm tắt 30 giây

- **Sản phẩm:** spaca, marketplace nơi dự án web3 (chính) và AI/SaaS (phụ) thuê creator crypto-native trên X.
- **Bốn loại hàng:**
  - `CREATE`: nội dung bàn giao cho buyer;
  - `PUBLISH`: creator đăng bài trên kênh của mình;
  - `ACCESS`: buổi tư vấn, hai bên tự hẹn giờ trong tin nhắn;
  - `DIGITAL`: file bán sẵn.
- **Ba cách mua:** Book Now, Request/hire (campaign nhiều creator), Auction (tạm hoãn mở rộng).
- **Tài khoản:** mỗi tài khoản là buyer **hoặc** creator. Tài khoản test cũ có thể có cả hai.
- **Thanh toán:** thẻ và chuyển khoản ngân hàng qua mock provider. Crypto qua escrow non-custodial `SpacaEscrow`, mới chạy LOCAL devnet/anvil, **chưa deploy Arc testnet** (ví deployer chưa có USDC testnet).
- **Stack:** Next.js 16 (webpack) + React 19 + TypeScript 7, postgres.js, PostgreSQL 18 embedded, Vitest, Playwright, Foundry.
- **Nghiệm thu:** **116 PASS / 19 PARTIAL / 0 NOT_RUN / 2 BLOCKED / 5 REMOVED** (142 ID).
- **Kiểm tra cuối (commit `d898592`):**
  - tsc sạch; Vitest 316 passed + 3 skipped; E2E 37/37; forge 17/17; anvil 3/3.
  - release-check, benchmark và quét secret đều đạt; diễn tập restore đạt.
  - Chi tiết: `docs/evidence/claude-AUDIT-2026-09-15.md`.
- **Việc dở:** không có. Mọi thứ đã commit. Phần còn lại ở §5 (PARTIAL, tính năng chưa làm) và §6 (bị chặn).

---

## 1. Quyền hạn, quyết định của user và luật làm việc

### 1.1 Chỉ thị hiện hành của user

Nguyên văn (2026-09-15):

> "tiếp tục build, bạn cứ lưu file trước chưa cần supabase, build nền chạy trên arc testnet trước và cho phép bạn truy cập mạng lẫn foundry / 4a / 5 có / 6: 1 / đấu giá thì tạm làm sau, và tiếp tục build để hoàn thành plan / chạy full plan, không cần hỏi gì thêm, sau khi build xong tự audit luôn"

Nghĩa là:
- **Lưu và commit** công việc. **Chưa dùng Supabase**; mọi thứ chạy PostgreSQL local.
- **Nền crypto nhắm Arc testnet.** Được truy cập mạng, dùng Foundry, cài package.
- **4a:** escrow model A, non-custodial (`docs/adr/002-escrow-custody.md`).
- **6: 1:** publish dịch vụ chỉ cần 1 sample đã duyệt.
- **Đấu giá tạm hoãn**, không mở rộng.
- Chạy hết plan, không hỏi thêm, xong thì tự audit (đã audit xong: `docs/evidence/claude-AUDIT-2026-09-15.md`).

### 1.2 Quyết định sản phẩm/UI của user — KHÔNG được làm ngược lại

- **Giới hạn đơn:** bỏ hẳn, chỉ còn nút Pause (`set_accepting_orders`).
- **Đặt lịch ACCESS:** bỏ hẳn (migration 0017).
- **Tài khoản:** tách buyer và creator (migration 0019, `src/lib/account.ts`).
- **Phí nền tảng:** chưa chốt. Code cưỡng chế phí = 0. Không tự đặt số. Không viết "0% fee" trong copy.
- **Hero landing:** video thay ngày 2026-09-15 (24.8 s, không tiếng), nằm trong `public/landing/`:
  - Bản máy tính 854×480: `hero.hevc.mp4` (1.19 MB) và `hero.mp4` (H.264, 1.84 MB).
  - Bản điện thoại 640×360 (màn ≤ 640px): `hero-640.hevc.mp4` (525 KB) và `hero-640.mp4` (748 KB).
  - Poster `hero-poster.jpg` (30 KB). Trình duyệt chỉ tải bản đầu tiên nó phát được (`src/app/page.tsx`, danh sách `HERO_SOURCES`).
  - Máy không có ffmpeg: đã mã hóa bằng AVFoundation (Swift) và giữ nguyên chuỗi codec đo từ file.
- **Điều hướng workspace:** nằm trong menu **"Account" ở góc phải header** (nhóm Workspace, Find work hoặc Hire, Account › Profile, và Log out).
  - **Không** có thanh bên, **không** có khối tên/email/avatar, **không** có nút avatar riêng trên header. User đã yêu cầu xóa từng thứ.
  - Trang con có link "‹ Back to …"; không mở tab mới trong luồng app.
- **Explore / Campaigns / Auctions:**
  - Chỉ link trên header tô xanh mục đang xem.
  - User **không muốn** thanh tab Services/Campaigns/Auctions phía trên danh sách (đã làm rồi xóa).
- **Form:** dùng thẻ/chip lựa chọn trực quan thay cho dropdown đơn lẻ (ví dụ "What do you need?" ở Post a brief).
- **Màu:** chỉ ở phần quan trọng.
  - Xanh `--accent` cho nút chính và vị trí hiện tại.
  - Mỗi loại campaign một màu.
  - Xanh lá / cam / đỏ giữ nghĩa trạng thái.
- **Campaign có ảnh dự án:** tối đa 6 ảnh; ảnh đầu làm cover của thẻ.

### 1.3 Vẫn cấm hoặc cần hỏi

- **Không** dùng tiền thật, mainnet, deploy công khai (kể cả redeploy waitlist Vercel) hay gửi email/tin nhắn ra ngoài khi user chưa cho phép lần đó.
- **Không in secret.** Không đọc `.env*` hay `contracts/.env.local`. Không dùng Mirai key. Không gõ mật khẩu/API key.
- **Đăng nhập local:** `POST /api/dev/session {"persona": "..."}`.
- **Không gọi `codex exec`.** Agent tự làm cả UI lẫn backend.
- **Nhãn:** giữ tách bạch mock / sandbox / LOCAL devnet / TESTNET / live. Không claim PASS nếu chưa có test thật chạy qua.
- **Không tự sửa tay** settlement thành RELEASED (bịa dữ kiện thanh toán).
- **Git:**
  - Agent là người commit duy nhất.
  - Chỉ `git add <đường dẫn cụ thể>`, không `-A`.
  - Không `reset`, `rebase`, `stash`.
  - Luôn chạy `git diff --cached --stat` trước khi commit.
  - Commit message kết thúc bằng `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
  - Không commit `next-env.d.ts` (Next dev tự sửa file này).

### 1.4 Sự cố bảo mật cần nhớ

- User từng dán **Resend API key** và **Supabase service_role key** vào chat. Đã khuyên rotate. Không bao giờ dùng lại hay in ra.
- Trong W9-ARC, zsh word-splitting từng **in ra 2 private key testnet vừa sinh** (chưa có tiền). Đã hủy, sinh lại bằng script ghi file không in (`docs/evidence/claude-W9-ARC.md`).
- **Khi sinh key/secret:** chỉ ghi thẳng vào file mode 600, không echo.

---

## 2. Môi trường local (macOS, repo `outputs/creator-marketplace`)

### 2.1 Node

```bash
export PATH=/Users/dohoangphi/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/dohoangphi/.local/node/bin:$PATH
```

- Không có binary `pnpm`. Dùng `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm add <pkg>`.
- Binary trực tiếp: `./node_modules/.bin/{tsx,tsc,vitest,playwright,next}`.
- **Không có ESLint config:** typescript-eslint chưa hỗ trợ TypeScript 7.

### 2.2 PostgreSQL embedded

- Địa chỉ `127.0.0.1:55432`, user app `app_server`. Mật khẩu admin nằm trong script local; không in ra.
- DB dev `creator_marketplace`, DB test `creator_marketplace_test`. **Cả hai đang ở migration 0025.**
- Backup `*_bak_0011` **đã xóa** trong audit.
- Nếu cổng đóng: `./node_modules/.bin/tsx scripts/postgres.ts start`.
- Migrate DB dev: `tsx scripts/migrate.ts`. Chuẩn bị DB test (migrate + seed): `tsx scripts/test-db.ts`.
- Không có `psql`. Muốn chạy SQL ad-hoc: viết file tạm dưới `scripts/` import `postgres`, chạy bằng tsx, rồi xóa.

### 2.3 Dev server và E2E

- Dev server: `.claude/launch.json` → `marketplace-dev` (Next dev `--webpack`, cổng **3100**). Khởi động bằng preview tool, không dùng Bash.
- Chạy E2E: `TZ=UTC ./node_modules/.bin/playwright test [file]`.
  - Chrome hệ thống, 1 worker, không tự khởi động server.
  - `tests/e2e/global-setup.ts` làm nóng route; mỗi request warmup tự hủy sau 90 giây.
- **Mock payment provider nằm trong bộ nhớ process Next.**
  - Restart dev server là mất lịch sử provider.
  - Đơn đã approve trước restart sẽ mở case `PROVIDER_OBJECT_MISSING`, không làm hỏng job.
  - Sửa class provider thì cần restart dev server.
- **Bẫy hay gặp:**
  - Thao tác client component (upload, select Radix) trước khi React hydrate thì không có phản ứng. Chờ `waitForHydration` hoặc `chooseOption`.
  - Chạy E2E **ngay sau khi sửa layout/CSS** dễ bị `ERR_CONNECTION_REFUSED` hoặc timeout vì dev server đang compile. Mở một trang cho server nóng rồi mới chạy.
  - Link có mũi tên `‹` trong `aria-hidden` thì tên truy cập là "Back to …" (không có mũi tên).
  - Lỗi "too many clients already" / trang báo "We could not load this workspace":
    - Nguyên nhân: trước đây mỗi route bundle và mỗi lần hot reload tạo một pool DB riêng.
    - Hiện `src/lib/db.ts` dùng chung một pool trong dev.
    - Nếu vẫn gặp: restart dev server (mất state mock provider).
- Chạy job local: `POST /api/dev/jobs` (same-origin).
- Persona: `creator_c`, `creator_d`, `buyer_a`, `buyer_b`, `dual_e`, `suspended`, `moderator`, `finance`, `admin`.
- DB dev đang bật `DIGITAL_PRODUCTS_ENABLED` và `CRYPTO_CHECKOUT_ENABLED` (để test tay UI pool). `BANK_FUNDING_ENABLED` đang tắt.

### 2.4 Lệnh kiểm tra chuẩn

```bash
./node_modules/.bin/tsc --noEmit -p tsconfig.json --incremental false
RUN_DB_INTEGRATION=1 ./node_modules/.bin/vitest run
RUN_ANVIL=1 RUN_DB_INTEGRATION=1 ./node_modules/.bin/vitest run tests/integration/escrow.anvil.test.ts   # sau `cd contracts && forge build`
TZ=UTC ./node_modules/.bin/playwright test
./node_modules/.bin/tsx scripts/release-check.ts
./node_modules/.bin/tsx scripts/discovery-benchmark.ts        # mặc định chạy trên DB test
./node_modules/.bin/tsx scripts/secret-scan.ts                # tracked files + .next/static
./node_modules/.bin/tsx scripts/restore-rehearsal.ts          # chạy khi không có E2E đang ghi DB dev
cd contracts && forge test
```

### 2.5 Arc testnet

- chain id `5042002`, RPC `https://rpc.testnet.arc.io`, explorer `https://testnet.arcscan.app`, faucet `https://faucet.circle.com` (có CAPTCHA, cần người).
- USDC ERC-20 `0x3600000000000000000000000000000000000000` (6 decimals).
- **Key testnet:** `contracts/.env.local` (git-ignored, mode 600). **Không in ra.**
  - Deployer/executor `0x7758186cD9FE0156fd5F631e5c944445D9c1e97F`: **đang 0 USDC**.
  - Release signer `0x4721DD4B6f1C9b66BDf22784B988EAAEBB7663e2`.
- **Runbook:** `docs/ARC_TESTNET.md`.
  1. User nạp faucet cho deployer.
  2. `forge script script/Deploy.s.sol --broadcast`.
  3. `ESCROW_ADDRESS=... tsx scripts/arc-testnet.ts register`.

---

## 3. Kiến trúc và quy ước code

### 3.1 Cấu trúc

- **Migration:** `drizzle/00NN_<tên>.sql` (hiện tới 0025).
  - Bất biến tài chính/tồn kho phải có ở DB: CHECK, trigger, foreign key ghép, unique partial index.
  - Ví dụ: `request_images` dùng FK `(request_id, buyer_id)` và `(asset_id, buyer_id, asset_purpose)`.
- **`src/lib/commands.ts`:** `CommandHandler`, `CommandError(message, code)`, `statusForCode`.
  - `CommandError` không có code thì trả **400**. Code không liệt kê (vd. `REQUEST_CLOSED`, `DOMAIN_RULE`) thì trả **422**.
- **Registry lệnh:** `src/modules/commands.ts` gộp handler theo module. Envelope POST ở `src/app/api/commands/route.ts`.
- **Loại tài khoản:** `src/lib/account.ts` — `CREATOR_COMMANDS` / `BUYER_COMMANDS`. Lệnh mới phải thêm vào đúng danh sách.
- **Log lỗi server:** luôn dùng `logError(context, error, ids)` trong `src/lib/log.ts`. Không `console.error(error)` thô, vì lỗi Postgres mang dữ liệu dòng trong `detail`.
- **Flash notice ký HMAC:** `withNotice` / `verifiedNotice` (`src/lib/notices.ts`).
- **Read model:** `src/lib/read-model.ts` (`getOrderData`, `getRequestData`, `getDashboardData`…).
- **Module:** `src/modules/*`
  - `payments/funding.ts`: mọi dữ kiện funding/refund/release, gồm dispute, refund sau release, late cost, bank.
  - `crypto`, `pools`, `requests` (có `compare.ts` cho REQ-11), `storage` (purpose `REQUEST_IMAGE` → bucket `public-campaigns`).
  - Còn lại: `publish`, `digital`, `moderation`, `jobs`, `notifications`, `discovery`, `admin`, `orders`, `catalog`, `capacity`, `auctions`.
- **UI:**
  - `src/components/site-chrome.tsx`: header/footer; thêm link "Back to" phía trên trang cho các segment `dashboard`, `buyer`, `creator`, `orders`, `settings`, `requests`, `auctions`, `services`, `creators`, `explore`.
  - `account-menu.tsx` (client): menu Account ở góc header (điều hướng workspace, Log out) và bản đồ "Back to".
  - `header-nav.tsx`: link header có trạng thái active.
  - `category.tsx`: thẻ loại campaign và màu. `order-workspace/receipt-panel.tsx`: biên nhận đơn.
  - CSS thuần trong `src/app/globals.css`.
- **Contracts:** `contracts/src/SpacaEscrow.sol`, test ở `contracts/test/`.

### 3.2 Quy ước quan trọng

- **Lock order:** aggregate (request/auction/pool) → workload creator → entitlement → order → funding → settlement. Advisory lock: `pg_advisory_xact_lock(hashtextextended('<key>', 0))`.
- **Không gọi chain/provider bên ngoài trong DB transaction.** Payout crypto đi qua outbox `app.chain_payouts`.
- **Terms snapshot:** `orders.terms` chụp điều khoản lúc mua. Rule sau đó đọc snapshot, không đọc listing hiện tại.
- **Feature flags:** `app.feature_flags` (thiếu dòng = tắt). Admin bật/tắt ở `/admin/flags`, bắt buộc ghi lý do.
- **Test DB** (`tests/integration/*.db.test.ts`):
  - `vi.mock('next/headers')` đọc `sessionState.token`, gọi route handler qua `callRoute`.
  - Harness: `createUser(label, roles)`, `key`, `createPublishedService`, `commandInstant`.
  - Fixture ghi vào DB test phải chạy lại được nhiều lần (upsert).
- **Test E2E:** `tests/e2e/helpers.ts` — `login`, `visit`, `submit`, `chooseOption`, `waitForHydration`, `payOrder`, `createPublishedService`.
- **Evidence:** mỗi đợt xong viết `docs/evidence/claude-<ID>.md`. Sau đó cập nhật:
  - dòng và tổng đếm trong `docs/ACCEPTANCE.md` (script đếm lại: xem cách làm trong audit);
  - section trong `docs/UI_CONTRACT.md`;
  - dòng trong `docs/COLLABORATION.md`;
  - `docs/REQUIREMENTS_TRACEABILITY.md` khi phase thay đổi.

---

## 4. Đã xong và đã commit (mới nhất ở trên)

- `d898592`: khung workspace, màu nhấn, Post a brief bằng thẻ/chip, ảnh campaign (0025), biên nhận đơn (ORD-01), so sánh báo giá sort/filter/CSV (REQ-11), log an toàn + quét secret (SEC-11), E2E checkout cũ sau khi pause (DSC-05).
- `ee89ffd`: tiền về muộn được ghi sổ và refund được; availability lúc chọn hồ sơ, đồng hồ CREATE, độ chính xác tiền.
- `11c9e65`: hành trình trình duyệt đóng 10 dòng; sửa notice giả mạo, tràn chữ, sửa dịch vụ.
- `14ee834`: PAY-11/OPS-01 — crash sau chuyển tiền không trả hai lần.
- `ddc8cb6`: ma trận bảo mật và race DB (14 dòng).
- `b5447ef`: video hero landing đã nén.
- `449f002`: OPS-02 — diễn tập restore local.
- `f184c1e`: BNK-01..03 — chuyển khoản ngân hàng (mock provider).
- `74010c4`: PAY-16 — chi phí provider đến muộn có trần.
- `6680105`: PAY-15 — refund sau release.
- `21999b0`: ORD-14 — tranh chấp thanh toán thẻ.
- `9df8d51`: ORD-12 — gia hạn deadline bằng amendment.
- `d42769c`: P6-DIGITAL hoàn tất (E2E, docs).
- `808eafd`: nhận diện lỗi provider qua các bundle; funding mất thì mở case.
- `c5ca712`: tách tài khoản buyer/creator.
- Trước đó: đăng nhập dạng dialog, Explore master-detail, ảnh profile, bỏ order limit/ACCESS scheduling, Radix Select, logo SVG, W9-ARC, W8-PUB… (`git log`).

---

## 5. Việc còn lại có thể làm ở local

### 5.1 Dòng PARTIAL (19)

| ID | Còn thiếu |
|---|---|
| FND-01, FND-02 | Clean checkout, frozen install, chạy CI thật, tương thích app cũ. |
| SEC-11 | Quét bundle production (`next build` với thư mục riêng, không đè `.next` của dev server). Chưa có log từ môi trường deploy. |
| ORD-07 | Delivery bằng link không truy cập được. |
| ORD-11, ORD-16 | Mô phỏng lỗi gửi thông báo/email vĩnh viễn và bounce. |
| ORD-13 | Ma trận đủ điều kiện no-start/trễ và UI refund. |
| PAY-01 | Ma trận quote/checkout/receipt/UI/ledger cho BOOK/REQUEST/AUCTION. |
| PAY-02 | Buyer nhìn thấy công khai chi phí. |
| PAY-03 | Fixture ngân sách khả dụng/reserve. |
| PAY-04 | Checkout production và UI hướng dẫn hành động. |
| PAY-12 | Thiếu số dư provider, khả năng payout ngân hàng. |
| PAY-20 | Scheduler deploy hằng ngày, diễn tập outage. |
| AUC-01 | Kiểm payout readiness của seller khi lên lịch (auction đang tạm hoãn). |
| CRY-01 | Deploy Arc testnet (bị chặn faucet). |
| OPS-03 | App cũ trên schema mới, diễn tập rollback. |
| OPS-05 | Diễn tập runbook → retry, form dispute/case có dữ liệu trên trình duyệt. |
| OPS-06 | Báo cáo tuần, dedupe đơn thật, báo cáo doanh thu. |
| OPS-08 | Release check tĩnh chưa cưỡng chế đủ entity/provider/budget/authority. |

### 5.2 Tính năng sản phẩm chưa làm

> Đã xong 2026-09-16: UI campaign pool và UI liên kết ví (`docs/evidence/claude-POOL-WALLET-UI.md`).

1. **Performance campaigns** (master §9.6): trả theo kết quả đo bằng click/on-chain, adapter metrics mock, flag mặc định tắt.
2. **Explore theo mục tiêu:** goal → playbook → creator → sample, ngân sách micro (§11.7).
5. **Request/hire cho ACCESS và DIGITAL.**
6. **Ảnh campaign:** kiểm duyệt ảnh và tạo thumbnail (hiện thẻ tải ảnh gốc, tối đa 10 MB).

### 5.3 Hạ tầng

- ESLint (chờ typescript-eslint hỗ trợ TypeScript 7).
- Rate limiter chung.
- MFA cho admin.
- Scheduler thật.
- `reconcile:dry-run`.
- Adapter Supabase/storage thật (khi user cho phép).

---

## 6. Bị chặn bởi bên ngoài / cần user

| Việc | Cần gì |
|---|---|
| Deploy `SpacaEscrow` lên **Arc testnet** (CRY-01) | User nạp USDC testnet cho `0x7758186cD9FE0156fd5F631e5c944445D9c1e97F` tại https://faucet.circle.com, rồi chạy `docs/ARC_TESTNET.md`. |
| **SEC-03** (chặn Data API vào schema private) | Supabase/staging thật. |
| **PAY-19** (payout ngân hàng) và các PAY PARTIAL | Provider thanh toán/payout thật, tài khoản của user. |
| Mức phí nền tảng | User quyết định. |
| Pháp lý (escrow, licence DIGITAL, Privacy, địa chỉ gửi thư) | Luật sư/user. |
| Mainnet | Audit bảo mật độc lập, multisig owner/guardian, signer KMS, xem lại Arc mainnet (ADR 002). |
| Rotate key đã lộ trong chat | User rotate Resend API key và Supabase service_role key. |
| Waitlist | Redeploy Vercel để lên logo SVG (cần user cho phép). Verify domain Resend. Điền `WAITLIST_MAILING_ADDRESS`, sửa dòng `[REVIEW WITH LEGAL…]` ở `/privacy`. |

---

## 7. Waitlist (tách khỏi sản phẩm chính)

- **Code:** `waitlist/` (Next riêng, cổng 3200 local).
- **Production:** Vercel project `spaca-waitlist`, https://spaca-waitlist.vercel.app.
- **Dữ liệu:** Supabase schema `waitlist.signups` (`waitlist/supabase-setup.sql`).
- **Email chào mừng:** Resend, template `waitlist/lib/email/welcome.ts`.
- **Env trên Vercel** (user tự nhập, không in ra): `WAITLIST_DATABASE_URL`, `WAITLIST_IP_SALT`, `RESEND_API_KEY`, `WAITLIST_EMAIL_FROM`, `WAITLIST_EMAIL_REPLY_TO`.
- `waitlist/.env.local` có secret, git-ignored, **không đọc/in**.

---

## 8. Yêu cầu riêng, KHÔNG gộp vào việc build

User từng yêu cầu "đóng vai Head of Design, tạo prompt xây UI tham khảo Fiverr". Việc này bị gián đoạn (mới mở fiverr.com, chưa phân tích, chưa viết prompt). Nếu làm thì làm ở phiên riêng.
