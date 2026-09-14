# Bàn giao cho phiên chat mới (cập nhật 2026-09-15)

Đọc file này trước. Sau đó đọc `docs/MASTER_PROMPT.md` (roadmap §16, acceptance §18), `docs/COLLABORATION.md` (board), `docs/UI_CONTRACT.md`, `docs/ACCEPTANCE.md` và `docs/evidence/claude-*.md`.

## 1. Quyền hạn và luật làm việc (giữ nguyên)

- User đã cho Claude toàn quyền xây sản phẩm từ A đến Z theo `docs/MASTER_PROMPT.md`.
- **Không gọi Codex (`codex exec`).** Từ chiều 2026-09-14 Codex đã dừng; **Claude làm cả UI (thiết kế + code) lẫn backend**. UI đang tạm hoãn: user muốn thiết kế qua Figma (connector chưa kết nối) và tham khảo bố cục Fiverr + màu/nút/Liquid Glass của Apple; dự kiến có landing `/` riêng rồi mới tới product `/explore`.
- **Phí nền tảng (cập nhật 2026-09-14):** user đã bỏ cam kết "0% phí sàn" khỏi scope. Mức phí và bên chịu phí chưa quyết. Code hiện vẫn cưỡng chế phí = 0; không tự đặt con số, không dùng "0% phí" trong copy marketing. Khi user chốt mô hình phí thì lập task riêng.
- **Capacity (phương án B):** **số đơn đang làm cùng lúc** mỗi creator (mặc định 3, pause, units_per_order). Engine đã làm lại ngày 2026-09-15 (W7-CAP, migration 0012, `docs/evidence/claude-W7-CAP.md`), **chưa commit**. Còn mở: publish cần 3 hay 1 sample; auction giữ chỗ từ lúc lên lịch (hiện tại) hay chỉ khi bán.
- **Định vị (2026-09-14, sửa lần 2):** **web3 là chính** (dự án web3 thuê creator crypto-native trên X), AI/SaaS/DevTools là phụ. USP và từ cấm dùng ở master §1.2.1. Còn mở: đôn crypto thật (Arc testnet/contract/custody) lên trước P6? kiểm duyệt dự án trước khi mở campaign? W7 tạm dừng.
- Những việc không làm khi chưa được phép:
  - Tiền thật, deploy công khai, gửi email/tin ra ngoài.
  - Cài package hoặc truy cập mạng (kể cả kiểm tra lại docs Arc).
  - In secret, dùng Mirai key, gõ mật khẩu hoặc API key (đăng nhập bằng `POST /api/dev/session {persona}`).
- Ghi nhãn mock / sandbox / testnet / live tách biệt. Không claim PASS nếu chưa có test thật chạy qua.
- Git:
  - Claude là người commit duy nhất; chỉ `git add <paths>` của task, không `-A`, không reset/rebase/stash.
  - **Chạy `git diff --cached --stat` trước mỗi commit.** Commit 48e0704 từng dính nhầm một file rename.
  - Trailer: `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## 2. Môi trường

- Node: `export PATH=/Users/dohoangphi/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH`
- **PostgreSQL embedded (127.0.0.1:55432)**: kiểm tra `nc -z 127.0.0.1 55432`. Dev và test DB đã ở migration 0012; bản sao trước 0012 là `creator_marketplace_bak_0011` / `creator_marketplace_test_bak_0011` (xóa khi W7-CAP đã commit). Nếu cổng đóng:
  1. `./node_modules/.bin/tsx scripts/postgres.ts start`
  2. Migrate DB dev: `./node_modules/.bin/tsx scripts/migrate.ts`
  3. Migrate DB test: `DATABASE_MIGRATION_URL=postgres://postgres:local_dev_only@127.0.0.1:55432/creator_marketplace_test ./node_modules/.bin/tsx scripts/migrate.ts`
- Kiểm tra:
  - Unit + DB tests: `RUN_DB_INTEGRATION=1 ./node_modules/.bin/vitest run` (vitest trỏ vào `creator_marketplace_test`).
  - Type: `./node_modules/.bin/tsc --noEmit -p tsconfig.json --incremental false`
  - Release: `./node_modules/.bin/tsx scripts/release-check.ts`
  - E2E: chạy Next dev ở 3100 (`.claude/launch.json` → "marketplace-dev"), rồi `TZ=UTC ./node_modules/.bin/playwright test` (Chrome hệ thống).
- Mock provider và devnet giả lập nằm trên `globalThis` trong process Next, nên phải giữ nguyên process khi test pay → jobs.
- Chạy jobs local: `POST /api/dev/jobs`.

## 3. Đã xong (đã commit)

| Commit | Nội dung | Evidence |
|---|---|---|
| … 3564912 | P0, P1A (supply/capacity), P1B (order lifecycle, mock payments), C1/C2/C4 | claude-W1-*.md, claude-C4.md |
| 90678f8 | W2-B roles/audit/admin commands/kill switches | claude-W2-B.md |
| 4173ae0 | W2-S storage (upload intent, quarantine, signed download) | claude-W2-S.md |
| 3b0c0aa | W3-R P2 requests v2 (hire offers, budget reservations, multi-hire) | claude-W3-R.md |
| 3bddff9 | C6 admin console UI (Codex) | claude-review-C6.md |
| 48e0704 | C3 acceptance ledger, runbooks (Codex) | claude-review-C3.md |
| 90004fd | W4-A P3 auctions v2 | claude-W4-A.md |
| 94792af | W5-C1 P4 crypto checkout trên devnet giả lập | claude-W5-C1.md |
| 0a95be6 | C5 Playwright E2E 14/14 + sửa danh sách sample | claude-review-C5.md |
| 26d6680 | W5-C2 P4 campaign pools (bảo toàn theo asset, allocation, release ký EIP-712, refund phần chưa dùng, entitlements) | claude-W5-C2.md |
| 7244b8a | W6-D P5 discovery (search/filter/cursor, creators, ending soon, trending-v1 COLD_START, views, sitemap/robots/noindex, benchmark DSC-06, ẩn is_test ở production) | claude-W6-D.md |
| (chưa commit) | W7-CAP capacity = giới hạn đơn đang làm (migration 0012) + UI creator order limit | claude-W7-CAP.md |

- Kết quả kiểm chứng gần nhất: **229/229 tests (24 files), tsc 0, E2E 14/14, benchmark + release-check PASS**, trên cây W7-CAP chưa commit.
- Ledger `docs/ACCEPTANCE.md`: **63 PASS / 57 PARTIAL / 20 NOT_RUN / 2 BLOCKED** (142 ID).

## 4. Việc tiếp theo

1. **Commit** (hỏi user trước). Cây làm việc đang chứa nhiều phần chưa commit, nên tách commit theo nhóm:
   - landing + product UI redesign + logo spaca;
   - waitlist app (`waitlist/`, đã deploy);
   - MARKETING_BRIEF + MASTER §9.6/§11.7;
   - W7-CAP (migration 0012, capacity module, commands, read models, UI order limit, tests, docs).
   Có file dính cả UI lẫn W7-CAP (vd. `src/app/requests/[id]/page.tsx`, `src/components/ui.tsx`, `src/app/services/[id]/page.tsx`, `src/app/creator/services/page.tsx`, `src/app/dashboard/page.tsx`, `tests/e2e/helpers.ts`); nếu không tách hunk được thì gộp và ghi rõ trong message.
2. Chờ user chốt rồi mới làm:
   - W7/P6 (mục 5);
   - Explore theo mục tiêu (goal → playbook → danh sách → xem mẫu);
   - mô hình thanh toán Arc non-custodial + chống dự án không trả (§11.7);
   - campaign Performance đo bằng click/on-chain thay vì view X (§9.6).

**Waitlist (tách khỏi sản phẩm):**
- Vị trí: `waitlist/`, Vercel project `spaca-waitlist` (https://spaca-waitlist.vercel.app), dữ liệu trên Supabase `waitlist.signups`, email chào mừng qua Resend với `onboarding@resend.dev` (chỉ gửi được tới email chủ tài khoản Resend).
- Env Vercel do user tự nhập.
- Còn thiếu: verify domain Resend, `WAITLIST_MAILING_ADDRESS`, dòng `[REVIEW WITH LEGAL…]` trên trang Privacy.
- User đã dán Resend key và Supabase service_role key vào chat, nên đã khuyên rotate.

## 5. Roadmap còn lại

### P6: Cross-platform, PUBLISH/ACCESS, DIGITAL (master §16.9; XPL-01..06 đều NOT_RUN)

| ID | Việc cần làm |
|---|---|
| XPL-01 | Social URL creator tự nhập: nhãn "self-reported", không có badge verified giả. |
| XPL-02 | Dịch vụ PUBLISH: snapshot channel/thời điểm/disclosure; delivery phải có post URL + thời điểm làm bằng chứng; approve dựa trên bằng chứng. |
| XPL-03 | ACCESS booking theo khung giờ: timezone/DST/buffer, không trùng lịch, policy attend/cancel/no-show. Flag `ACCESS_BOOKING_ENABLED`. |
| XPL-04/05/06 | DIGITAL products (flag `DIGITAL_PRODUCTS_ENABLED`): non-exclusive thì mỗi buyer có entitlement riêng và asset private; exclusive stock=1 thì chống bán trùng khi mua đồng thời; quyền download theo entitlement/version/refund (tái dùng storage W2-S). |

Mỗi phần cần migration, commands, read models, UI_CONTRACT, DB tests và evidence.

### P4: phần còn thiếu (phần lớn bị chặn bởi yếu tố bên ngoài)

| Hạng mục | Trạng thái | Việc cần làm |
|---|---|---|
| Arc testnet | BLOCKED | Cần quyền truy cập mạng để kiểm tra lại docs Arc, chain id, RPC, decimals, finality. |
| Solidity settlement contract + Foundry fuzz/invariant + audit | NOT_RUN | Cần user cho phép cài Foundry. |
| Custody | Chưa có | Viết ADR (KMS/multisig); hiện chỉ có signer local. |
| Payout outbox worker | NOT IMPLEMENTED | Tách payout/refund ra khỏi DB transaction trước khi dùng testnet. |
| Crypto refund/payout cho đơn rail CRYPTO | Chưa có | Hiện chỉ mở case. |
| Release-check | Chưa có | Thêm dòng mainnet crypto BLOCKED; checklist go-live mainnet (P4-10). |
| CRY-13 | NOT_RUN | Mô phỏng admin pause / lộ quyền role. |

### Các gap còn mở từ những đợt review trước

| Nhóm | Gap |
|---|---|
| P2 | Sort/filter cho màn so sánh báo giá (REQ-11 PARTIAL), xuất CSV, analytics hires vs applications (P2-07), quyết định backfill budget cho request cũ, test race REQ-07. |
| P3 | Kiểm tra seller payout readiness (AUC-01), metrics ≥3 bidders/uplift (P3-07), test reconnect/sleep (AUC-13), email outbid riêng. |
| Orders/Payments | ORD-12 gia hạn deadline; ORD-14 chargeback sau COMPLETED; PAY-15/16 NOT_RUN; BNK-01..03 NOT_RUN; hoàn một phần cho đơn trả bằng pool. |
| Capacity/Supply | CAP-10 và CAP-11 race tests; SUP-05/06 NOT_RUN. |
| Moderation | MOD-01/02 NOT_RUN (report/moderation flow). |
| Hạ tầng | Adapter Supabase Auth/Storage thật; scheduler Inngest; `reconcile:dry-run`; eslint config; chạy frozen install + CI; MFA cho admin; rate limiter chung; quét antivirus cho file; OPS-02 restore rehearsal. |
| Blocked | P1C staging/live và sandbox/live payments (SEC-03, PAY-19) BLOCKED vì thiếu tài khoản/quyền của user. |

### Tài liệu cuối (sau mỗi task)

- Cập nhật `docs/ACCEPTANCE.md` (đếm lại theo family), `REQUIREMENTS_TRACEABILITY.md`, `BUILD_STATUS.md`, `HANDOFF.md`, runbooks.
- Trước khi đóng dự án: chạy lại toàn bộ suite, E2E, release-check.

## 6. UI (Claude làm, đang tạm hoãn)

- Backend đã có nhưng **chưa có UI**:
  - Campaign pool (W5-C2)
  - Liên kết ví qua browser (W5-C1 mới có API và devnet simulator)
  - Discovery nâng cao (W6-D)
  - Sort/filter so sánh báo giá
- Tất cả dựa trên `docs/UI_CONTRACT.md`.

## 7. Yêu cầu riêng, KHÔNG gộp vào dự án trên

User từng yêu cầu: "đóng vai Head of Design (UI/UX), tạo một prompt để xây UI cho sản phẩm, tham khảo giao diện Fiverr".
- Việc này bị gián đoạn. Mới mở trang fiverr.com, chưa phân tích và chưa viết prompt.
- User dặn làm ở một phiên riêng, không trộn với context build backend.
