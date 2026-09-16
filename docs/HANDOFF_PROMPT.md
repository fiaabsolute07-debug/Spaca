# Prompt bàn giao cho agent tiếp theo — spaca (2026-09-16, commit mới nhất lúc viết: `52a510f`)

> Dán nguyên file này làm tin nhắn đầu tiên cho agent mới. Tài liệu gốc chi tiết hơn nằm ở `docs/NEXT_SESSION.md` (luật làm việc, môi trường, kiến trúc) — **đọc file đó trước khi sửa code**.

---

## Vai trò và nhiệm vụ

Bạn tiếp quản việc xây **spaca**, marketplace nơi dự án web3 (chính) và AI/SaaS (phụ) thuê creator crypto-native (chủ yếu trên X). Bạn làm cả UI lẫn backend, tự commit. Nhiệm vụ: tiếp tục build theo plan, giữ nguyên các quyết định của user, và luôn chứng minh bằng test thật trước khi báo xong.

Chỉ thị hiện hành của user (vẫn còn hiệu lực):

> "tiếp tục build, bạn cứ lưu file trước chưa cần supabase, build nền chạy trên arc testnet trước và cho phép bạn truy cập mạng lẫn foundry / 4a / 5 có / 6: 1 / đấu giá thì tạm làm sau, và tiếp tục build để hoàn thành plan / chạy full plan, không cần hỏi gì thêm, sau khi build xong tự audit luôn"

Nghĩa: commit đều; chưa dùng Supabase (PostgreSQL local); crypto nhắm Arc testnet; escrow model A non-custodial; publish dịch vụ cần 1 sample đã duyệt; đấu giá tạm hoãn; làm hết plan không cần hỏi; xong thì tự audit.

## Luật bắt buộc (vi phạm là lỗi nghiêm trọng)

- Không tiền thật, không mainnet, không deploy công khai (kể cả redeploy waitlist Vercel), không gửi email/tin nhắn ra ngoài nếu user chưa cho phép **lần đó**.
- Không in secret. Không đọc/`cat` `.env*`, `contracts/.env.local`, `waitlist/.env.local`. Không gõ mật khẩu/API key. Sinh key thì ghi thẳng file mode 600, không echo.
- Đăng nhập local chỉ qua `POST /api/dev/session {"persona": "..."}` (persona: `buyer_a`, `buyer_b`, `creator_c`, `creator_d`, `dual_e`, `suspended`, `moderator`, `finance`, `admin`).
- Không gọi `codex exec`.
- Phí nền tảng **chưa chốt**: code giữ `platform_fee_bps: 0`, không tự đặt số, không viết "0% fee" trong copy.
- Nhãn luôn tách bạch mock / sandbox / LOCAL devnet / TESTNET / live. Không claim PASS nếu chưa có test thật chạy qua.
- Không sửa tay dữ kiện thanh toán (vd. set RELEASED, refunded) trong DB.
- Git: chỉ `git add <đường dẫn cụ thể>` (không `-A`); không `reset`/`rebase`/`stash`; chạy `git diff --cached --stat` trước khi commit; không commit `next-env.d.ts`; commit message kết thúc bằng dòng `Co-Authored-By:` theo quy ước của repo.

## Quyết định UI/sản phẩm của user — không làm ngược lại

- Điều hướng workspace nằm trong menu **Account** góc phải header (không sidebar, không khối tên/avatar, không nút avatar riêng). Trang con có link "‹ Back to …"; không mở tab mới.
- Header: **Explore** và **Campaigns** là menu thả xuống kiểu Zealy (ô màu nổi bật bên trái, mục có tiêu đề + 1 dòng mô tả bên phải); **Auctions** là link thường. Không làm thanh tab Explore/Campaigns/Auctions phía trên danh sách (user đã bắt xóa) — khác với 7 tab mục tiêu trong Campaigns, là thứ user muốn.
- Nút **Fund** nằm ngay trước nút Account, gom mọi luồng tiền; trang `/funds`.
- Campaign chia thành **7 tab, mỗi tab một trang riêng** (`/campaigns/<slug>`): Launch, Shiller, Airdrop, AMA & Spaces, Testnet, Education, Memes & art (`src/modules/requests/goals.ts`, nội dung `goal-pages.ts`). Tab không được trông trống: chỉ dùng nội dung thật, không bịa campaign mẫu.
- Form dùng thẻ/chip trực quan thay dropdown đơn lẻ. Màu chỉ ở phần quan trọng. Campaign có ảnh dự án.
- Mỗi tài khoản là buyer **hoặc** creator. Không giới hạn số đơn (chỉ Pause). Không đặt lịch ACCESS (giờ hẹn thỏa thuận trong tin nhắn).
- Khi yêu cầu UI mơ hồ về vị trí, xác nhận với user trước (nhiều vòng đã đoán sai).

## Môi trường local (macOS)

```bash
cd outputs/creator-marketplace
export PATH=/Users/dohoangphi/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/dohoangphi/.local/node/bin:$PATH
./node_modules/.bin/tsx scripts/postgres.ts start      # PostgreSQL embedded 127.0.0.1:55432 (chạy nền)
./node_modules/.bin/tsx scripts/migrate.ts             # DB dev creator_marketplace
./node_modules/.bin/tsx scripts/test-db.ts             # DB test creator_marketplace_test (migrate + seed)
```

- Máy khác: `corepack pnpm install --frozen-lockfile`, Node 24, Chrome hệ thống cho Playwright, Foundry cho `contracts/`.
- Migration hiện tới **0030**. Cả DB dev và test đã áp dụng.
- Dev server: `.claude/launch.json` → `marketplace-dev` (Next dev webpack, cổng **3100**). Mock payment provider nằm trong bộ nhớ process: restart dev server là mất lịch sử provider.
- Job local: `POST /api/dev/jobs` (same-origin). Flag bật trên DB dev: `DIGITAL_PRODUCTS_ENABLED`, `CRYPTO_CHECKOUT_ENABLED`, `PERFORMANCE_CAMPAIGNS_ENABLED`.
- Nếu PostgreSQL hoặc dev server tắt (`ECONNREFUSED` / `ERR_CONNECTION_REFUSED`): khởi động lại như trên.

Lệnh kiểm tra chuẩn:

```bash
./node_modules/.bin/tsc --noEmit -p tsconfig.json --incremental false
RUN_DB_INTEGRATION=1 ./node_modules/.bin/vitest run
TZ=UTC ./node_modules/.bin/playwright test            # cần dev server 3100 đang chạy
./node_modules/.bin/tsx scripts/secret-scan.ts
./node_modules/.bin/tsx scripts/release-check.ts
cd contracts && forge test
```

## Trạng thái kiểm tra cuối (2026-09-16, sau khi áp nhận diện, cây `52a510f`)

- `tsc`: sạch.
- Vitest: **336 passed, 3 skipped** (41 file; 3 skipped là bộ anvil cần `RUN_ANVIL=1`).
- Quét secret: không phát hiện.
- Playwright đầy đủ: **48 passed, 1 failed**. Lỗi duy nhất là `publish.spec.ts` ở `freeLinkedAccountSlot`: creator_d trong DB dev đã giữ đủ 10 tài khoản X liên kết từ các lần chạy trước, mỗi cái gắn với một service đã đăng nên helper không xoá được cái nào để lấy chỗ. Đây là dữ liệu test tích tụ, không phải lỗi code — lỗi này đã có từ trước khi áp nhận diện. Muốn hết thì phải xoá các tài khoản `e2e…` cũ và các service giữ chúng trong DB dev.
- Tương phản: `scripts/brand-contrast.ts` đo **2587 đoạn chữ trên 9 trang, tất cả đạt WCAG AA**, cả khi landing để chế độ sáng.
- Ảnh giao diện: `scripts/brand-shots.ts` chụp 11 trang ở 1280px và 375px, **không trang nào cuộn ngang**.
- forge/anvil/release-check/benchmark/restore rehearsal: đạt ở audit 2026-09-15 (`docs/evidence/claude-AUDIT-2026-09-15.md`), chưa chạy lại.
- `docs/ACCEPTANCE.md` (116 PASS / 19 PARTIAL / 0 NOT_RUN / 2 BLOCKED / 5 REMOVED) **chưa đếm lại** cho các tính năng 2026-09-16; `docs/BUILD_STATUS.md` phần kết quả cũng là số 2026-09-15.

## Đã hoàn thành

### Nền tảng (trước 2026-09-16, chi tiết `docs/NEXT_SESSION.md` §4)
- P0–P6 chạy local: auth fixture, supply có phiên bản, Book Now / Request-hire / Auction (tạm hoãn), vòng đời đơn (funding, delivery, revision, auto-accept, cancel, amendment deadline, dispute thẻ, refund sau release, chi phí provider muộn, biên nhận), campaign nhiều creator với báo giá riêng + giữ ngân sách, crypto checkout + pool thưởng + `SpacaEscrow` (LOCAL devnet/anvil), discovery Explore, PUBLISH/DIGITAL, chuyển khoản ngân hàng (mock), console vận hành, diễn tập restore, quét secret bundle production.
- UX 2026-09-15: menu Account, back link, video hero nén (HEVC + H.264), Post a brief bằng thẻ/chip, ảnh campaign.

### Phiên 2026-09-16 (mới nhất ở dưới)
| Commit | Nội dung | Bằng chứng |
|---|---|---|
| `bf15171` | UI pool thưởng campaign + liên kết ví (ký `personal_sign`) trên profile | `docs/evidence/claude-POOL-WALLET-UI.md` |
| `6e8abc5` | **Performance campaigns** §9.6: phí cố định + thưởng theo view có 2 trần (bonus cap, views cap = median × hệ số). Giữ tối đa khi hire, hoàn phần không dùng. Metrics **giả lập** `mock-metrics-v1`. Flag `PERFORMANCE_CAMPAIGNS_ENABLED` | `docs/evidence/claude-PERFORMANCE.md` |
| `3f9d944` | Vận hành duyệt/từ chối thưởng bị giữ (`admin_approve_performance_bonus` / `admin_reject_performance_bonus`, finance/admin, có lý do + audit) ở `/admin/orders/<id>`; job settle gửi hoàn phần giữ | như trên |
| `71f6e93` | Campaign **ACCESS** (thời lượng buổi 15–480 phút) và **DIGITAL** (license + quyền sử dụng), đóng băng vào `orders.terms` khi hire; migration 0027 | `docs/evidence/claude-ACCESS-DIGITAL.md` |
| `99cc7b6` | Ảnh campaign: trình duyệt tạo bản nhỏ ≤640px, thẻ dùng bản nhỏ; cách ly ảnh gốc thì cách ly cả bản nhỏ; migration 0028 | `docs/evidence/claude-CAMPAIGN-IMAGES.md` |
| `2e8a0a9` | **Mục tiêu campaign** (Launch/Airdrop/Shiller/Testnet/AMA & Spaces/Education/Memes & art) + lọc `/requests?goal=` + **menu header kiểu Zealy**; migration 0029 | `docs/evidence/claude-GOALS-NAV.md` |
| `1f7ad3e` | **Sửa lỗi tiền:** webhook hoàn "phần giữ chưa dùng" của performance bị coi là UNEXPECTED_REFUND nên không ghi sổ; nay ghi `REFUND_SETTLED`, đơn thành `PARTIALLY_REFUNDED`. Test kiểm số dư principal = 0 | `docs/evidence/claude-FUNDS.md` |
| `8c13b3b` | **Nút Fund** cạnh Account (số liệu tải khi mở menu qua `POST /api/funds/summary`) + trang **`/funds`** (cần trả, đang giữ, đã hoàn, đã giải ngân, pool, payout on-chain, lịch sử, ví) — số liệu từ sổ cái; migration 0030 (index ledger) | `docs/evidence/claude-FUNDS.md` |
| `0a4e71e` | Test E2E thử lại khi dev server hot-reload hủy điều hướng | commit message |
| (commit sau `5045f3c`) | **7 tab campaign**: mỗi mục tiêu một trang `/campaigns/<slug>` với ý tưởng riêng; chống trang trống bằng nội dung thật (ý tưởng, cách hoạt động, bàn giao, creator thật cùng loại, campaign đã đóng, lời mời đăng brief đầu tiên). Nội dung sửa ở `src/modules/requests/goal-pages.ts` | `docs/evidence/claude-CAMPAIGN-TABS.md` |

| `2476cab` | Prompt áp nhận diện + bản sao trang nhận diện đã duyệt (`docs/brand/spaca-brand-kit.html`) | commit message |
| `5a2e418` | **Nhận diện giai đoạn 1:** token nền tối dịu + vàng chanh, bỏ 4 màu loại việc, bo 4px, không đổ bóng; nạp Archivo / Geist / Geist Mono | `docs/evidence/claude-BRAND-ROLLOUT.md` |
| `35f3803` | **Giai đoạn 2:** khung trang 1200px có đường kẻ hai bên, section kẻ ngang có dấu `+`, nhãn/menu/nút mono viết hoa, badge Open vàng chanh | như trên |
| `a5b59f0` | **Giai đoạn 3:** campaign board thay lưới thẻ (`/requests`, 7 tab, My campaigns), 7 hình vẽ nét, `hired_count` trong read model | như trên |
| `1c0d30b` | **Giai đoạn 4:** dải tiền `#16161A` cho `/funds`, biên nhận và view bonus; số tiền mono, số dẫn đầu vàng chanh; nhãn testnet viền nét đứt | như trên |
| `52a510f` | **Giai đoạn 5:** landing về cùng nhận diện (giữ công tắc, mặc định tối); chữ gợi ý nâng lên 55% để đạt WCAG AA, phần trang trí giữ 42% dưới tên `--hint` | như trên |

Tài liệu đã cập nhật cho các mục trên: `docs/UI_CONTRACT.md` (các section 2026-09-16, gồm mục nhận diện campaign board), `docs/NEXT_SESSION.md` §5.2.

## Còn dang dở / đã biết

1. **Chạy lại toàn bộ Playwright** sau `0a4e71e` để xác nhận 46/46.
2. **Dữ liệu dev bị lỗi từ trước bản sửa `1f7ad3e`:** vài đơn performance trong DB dev vẫn có case `UNEXPECTED_REFUND`/`REFUND_FAILED` mở và `/funds` hiện phần giữ (40–80 USD) là "đang giữ". Không sửa tay; nếu cần, xử lý qua console vận hành/retry operation, hoặc bỏ qua vì là dữ liệu test.
3. **Tài liệu tổng chưa cập nhật số mới:** `docs/ACCEPTANCE.md` (thêm/đếm lại dòng cho performance, goals, funds, ACCESS/DIGITAL campaign), `docs/BUILD_STATUS.md` (kết quả mới), `docs/REQUIREMENTS_TRACEABILITY.md`, `docs/COLLABORATION.md`.
4. **Performance campaigns còn giới hạn:** metrics giả lập (chưa nối API nền tảng thật), chưa có cờ "median tăng quá nhanh", tín hiệu gian lận mới có 2 loại.
5. **Funds:** chưa có nạp/rút số dư kiểu Arc (deposit, withdraw về ví/ngân hàng — spec §11.7); menu Fund chỉ gom luồng tiền đã có. Danh sách tối đa 50 dòng mỗi mục.
6. **Campaign goals:** campaign cũ không có mục tiêu (chỉ hiện ở "All campaigns"); chưa có màn sửa campaign (update_request chỉ qua API).
8. **7 tab campaign mới dùng chung một khung:** chưa có trường/thẻ/bộ lọc riêng cho từng mục (ngày launch, giá mỗi bài Shiller, giờ AMA…) — đây là bước tiếp theo user đã thảo luận. Nội dung ý tưởng từng tab là bản nháp để user chỉnh.
7. **Ảnh campaign:** chưa có kiểm duyệt tự động/antivirus.

## Bộ nhận diện (đã duyệt 2026-09-16, **đã áp vào code** cùng ngày)

Nền tối dịu `#121214`, chữ `#E8E8EA`, màu nhận diện **vàng chanh `#D6F25E`** dùng có quy tắc, font Archivo (hẹp) /
Geist / Geist Mono, bố cục "campaign board". Trang nhận diện: `docs/brand/spaca-brand-kit.html`. Prompt gốc:
`docs/BRAND_ROLLOUT_PROMPT.md`. Chi tiết token, quy tắc và thành phần đã ghi vào `docs/UI_CONTRACT.md`
(mục "2026-09-16 additions: the campaign board identity"); bản ghi quá trình ở `docs/evidence/claude-BRAND-ROLLOUT.md`.

Làm theo 6 commit, mỗi commit một giai đoạn: token + font → header/menu/nút/khung trang → campaign board + 7 tab +
7 hình vẽ nét → dải tiền → landing và các trang còn lại → tài liệu.

**Không làm ngược lại:** nền tối là giao diện duy nhất của app (landing còn công tắc sáng/tối, mặc định tối);
vàng chanh chỉ tô đặc cho một nút chính mỗi màn hình, badge Open và thanh tiến độ nhỏ, làm chữ cho số tiền và dấu
ngoặc nhãn, làm nền mờ 13% cho tab/bộ lọc đang chọn — không bao giờ mảng lớn; bốn màu loại việc đã bỏ hẳn, loại việc
và mục tiêu nhận ra bằng hình vẽ nét + chữ; bo 4px (trừ chip lọc là viên thuốc); không đổ bóng.

**Công cụ kiểm tra mới:**

```bash
./node_modules/.bin/tsx scripts/brand-shots.ts [thư-mục]   # ảnh 11 trang ở 1280px và 375px, báo lỗi nếu cuộn ngang
./node_modules/.bin/tsx scripts/brand-contrast.ts          # đo tương phản mọi đoạn chữ, chuẩn WCAG AA
```

**Lưu ý khi chạy Playwright:** đừng tạo/sửa file trong repo lúc bộ test đang chạy — dev server nạp lại nóng và làm
vài spec hỏng ngẫu nhiên (đã gặp: 4 spec lỗi rồi đạt lại khi chạy riêng).

## Việc tiếp theo đề xuất (theo thứ tự)

1. Cập nhật `docs/ACCEPTANCE.md` + `docs/BUILD_STATUS.md` cho các tính năng 2026-09-16 và cho bộ nhận diện (chỉ PASS khi có test).
2. Dọn dữ liệu e2e tích tụ trong DB dev (10 tài khoản X của creator_d và các service giữ chúng) để `publish.spec.ts` chạy lại được.
3. **Explore theo mục tiêu** (goal → playbook → creator → sample, ngân sách micro, §11.7) — nối với 7 mục tiêu campaign đã có.
4. Số dư Arc: nạp/rút (§11.7) nối vào nút Fund — chỉ LOCAL/TESTNET, không tiền thật.
5. Các dòng PARTIAL còn lại (`docs/NEXT_SESSION.md` §5.1) và hạ tầng §5.3 (rate limiter, MFA admin, scheduler thật, `reconcile:dry-run`).

## Bị chặn — cần user

- Deploy `SpacaEscrow` lên Arc testnet: user nạp USDC testnet cho deployer `0x7758186cD9FE0156fd5F631e5c944445D9c1e97F` (https://faucet.circle.com), rồi theo `docs/ARC_TESTNET.md`.
- Supabase/staging (SEC-03), provider thanh toán/payout thật (PAY-19), mức phí nền tảng, pháp lý, audit hợp đồng trước mainnet.
- User cần rotate Resend API key và Supabase service_role key từng dán trong chat.
