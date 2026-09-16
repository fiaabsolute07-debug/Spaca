# Prompt cho agent: áp bộ nhận diện mới "Campaign board · tối dịu · vàng chanh" vào spaca

> Dán nguyên file này làm tin nhắn đầu tiên cho agent thực hiện. Trước khi sửa code, đọc thêm `docs/HANDOFF_PROMPT.md` (luật làm việc, môi trường, lệnh kiểm tra) và mở `docs/brand/spaca-brand-kit.html` bằng trình duyệt: đó là trang nhận diện user đã duyệt (bản 6), mọi giá trị dưới đây lấy từ đó.

---

## 1. Nhiệm vụ

Đổi toàn bộ giao diện sản phẩm spaca (Next.js app trong `outputs/creator-marketplace`) sang bộ nhận diện user đã chốt ngày 2026-09-16:
- **Nền tối dịu** (không đen tuyệt đối, chữ không trắng tinh), kiểu Zealy nhưng dịu hơn một bậc.
- **Vàng chanh `#D6F25E` là màu nhận diện**, dùng có quy tắc để không chói.
- **Bố cục "campaign board"**: tham khảo tinh thần arc.io (lưới kẻ mảnh, dấu `+` ở góc, nhãn mono trong ngoặc) và monad.xyz (khung trang có đường kẻ hai bên, nhãn/menu/nút mono viết hoa, minh hoạ nét mảnh), còn độ dễ quét lấy từ zealy.io (số tiền và suất trống luôn ở cùng một chỗ).

Không thay đổi logic nghiệp vụ, dữ liệu, route hay nội dung pháp lý. Đây là việc giao diện.

## 2. Quyết định của user — không làm ngược lại

- Nền tối là mặc định và là giao diện duy nhất lúc này (không làm bản sáng cho app).
- Màu nhấn là **vàng chanh**. User đã thử và **từ chối**: tím graphite (Bricolage, "Brief. Post. Paid."), bộ chép chất liệu Zealy (thẻ hologram, XP), tím nhạt `#8B93FF` ("khó nhận diện"), và vàng chanh tô mảng lớn trên nền đen `#0D0D0D` ("khó nhìn").
- **Không chép** tài sản của Zealy / Arc / Monad: không dùng font Syne, Space Grotesk, DM Sans, brittiSans; không dùng tranh minh hoạ, thẻ XP, logo hay câu chữ của họ.
- Giữ các quyết định UX cũ: menu Account góc phải; menu thả xuống Explore/Campaigns; nút Fund cạnh Account; 7 tab campaign mỗi tab một trang `/campaigns/<slug>`; back link; không mở tab mới; form dùng thẻ/chip thay dropdown; campaign có ảnh dự án (ảnh giữ ở trang chi tiết và ô nổi bật).
- Không có thanh tab Explore/Campaigns/Auctions phía trên danh sách (user đã bắt xoá). 7 tab trong Campaigns thì giữ.
- Copy: không viết "0% fee", "guaranteed", "trustless", "audited", "make a living"; không hứa lợi nhuận; bài tài trợ luôn ghi rõ là tài trợ; tiền giả lập/testnet luôn có nhãn.

## 3. Luật làm việc bắt buộc (tóm tắt, bản đầy đủ ở `docs/HANDOFF_PROMPT.md`)

- Không tiền thật, không mainnet, không deploy công khai, không gửi email/tin nhắn ra ngoài khi user chưa cho phép lần đó.
- Không in secret; không đọc `.env*`, `contracts/.env.local`, `waitlist/.env.local`.
- Đăng nhập local chỉ qua `POST /api/dev/session {"persona": "..."}`.
- Git: chỉ `git add <đường dẫn cụ thể>`; không `-A`, `reset`, `rebase`, `stash`; chạy `git diff --cached --stat` trước khi commit; không commit `next-env.d.ts`; commit message kết thúc bằng dòng `Co-Authored-By:` theo quy ước repo. Commit theo từng giai đoạn ở mục 7.
- Không claim xong nếu chưa chạy test thật và chưa xem ảnh chụp giao diện.

## 4. Token thiết kế (giá trị chính xác)

### 4.1 Màu

| Vai trò | Giá trị | Dùng cho |
|---|---|---|
| Nền trang `night` | `#121214` | `body`, nền mọi trang; lưới mờ `rgba(255,255,255,.02)` ô 32px |
| Ô `cell` | `#1A1A1D` | ô bảng, panel, form, menu thả xuống |
| Ô nổi `raised` | `#232327` | ô đang chọn, hover, tab đang xem |
| Dải tiền `money` | `#16161A` | vùng Funds, biên nhận, payout (tách bằng đường kẻ) |
| Chữ chính | `#E8E8EA` | tiêu đề, nội dung |
| Chữ phụ | `rgba(232,232,234,.78)` | đoạn văn phụ |
| Chữ mờ | `rgba(232,232,234,.60)` | nhãn, mô tả |
| Chữ gợi ý | `rgba(232,232,234,.42)` | placeholder, metadata |
| Đường kẻ | `rgba(255,255,255,.09)` | viền ô, kẻ bảng |
| Đường kẻ đậm | `rgba(255,255,255,.16)` | viền nút phụ, dấu `+`, ô trống của thanh tiến độ |
| **Vàng chanh** | `#D6F25E` | nút chính, thanh tiến độ, badge "Open" |
| Chữ vàng chanh | `#DDF47A` | con số tiền, từ nhấn, dấu ngoặc `{ }` |
| Vàng chanh mờ | `rgba(214,242,94,.13)` | chip trạng thái mở, tab/bộ lọc đang chọn |
| Chữ trên vàng chanh | `#121214` | mọi chữ đặt trên nền `#D6F25E` |
| Đã trả / đã duyệt | `#5CCB95`, nền `rgba(92,203,149,.14)` | trạng thái tiền xong |
| Đang giữ / testnet | `#E3B465`, nền `rgba(227,180,101,.14)` | chờ, giữ tiền, nhãn TESTNET (viền nét đứt) |
| Tranh chấp / lỗi | `#EE8080`, nền `rgba(238,128,128,.14)` | tranh chấp, thất bại, xoá |

**Quy tắc vàng chanh (bắt buộc):**
- Tô đặc **chỉ** cho: nút hành động chính (mỗi màn hình tối đa một nút chính nổi bật), badge "Open", thanh tiến độ nhỏ.
- Dạng chữ cho: số tiền (`15 USDC`), một từ nhấn trong tiêu đề lớn, dấu ngoặc của nhãn.
- Dạng nền mờ 13% cho: chip trạng thái mở, tab đang xem, bộ lọc đang chọn.
- **Không bao giờ**: mảng vàng chanh lớn sau đoạn chữ, sọc/hoạ tiết sáng phủ ô (hoạ tiết nếu có chỉ là nét 2px độ mờ ≤ .16), vàng chanh trên nền `#000`/`#0D0D0D`, chữ vàng chanh cỡ nhỏ hơn 12px.
- Bỏ hẳn 4 màu loại việc `--cat-create/publish/access/digital` và mọi màu riêng theo mục tiêu: loại việc và mục tiêu nhận ra bằng icon/hình vẽ nét + chữ.

### 4.2 Chữ (Google Fonts, nạp bằng `next/font/google`)

| Vai trò | Font | Quy cách |
|---|---|---|
| Tiêu đề, số lớn | **Archivo** (trục `wdth` 75–100, `wght` 500–800) | 700–800, `font-stretch: 75–85%`, viết hoa, line-height 0.88–1.05 |
| Nội dung, form | **Geist** 400/500/600 | 15–17px, line-height 1.55 |
| Nhãn, menu, nút, số trong bảng, hash, địa chỉ ví | **Geist Mono** 400/500 | 11–13px, viết hoa với `letter-spacing: .08–.1em` cho nhãn/nút; `font-variant-numeric: tabular-nums` cho số |

Nhãn kiểu `{ CAMPAIGN BOARD }`: chữ mono viết hoa màu chữ mờ, dấu ngoặc màu `#DDF47A`.

### 4.3 Hình khối

- Bo góc: **4px** cho nút, ô, chip vuông; chip lọc dạng viên thuốc `999px`. Bỏ bo 18px/12px và bỏ `--shadow` hiện tại (không đổ bóng; tách lớp bằng đường kẻ và nền `cell`/`raised`).
- Trang nằm trong khung có đường kẻ trái/phải (`max-width` ~1200px, `border-inline: 1px solid` đường kẻ).
- Section tách bằng đường kẻ ngang có dấu `+` ở hai đầu (màu đường kẻ đậm). Trên điện thoại phải `overflow-x: clip` để dấu `+` không gây cuộn ngang.
- Các ô cạnh nhau **dùng chung viền** (grid có border giữa ô) thay vì thẻ rời có khoảng hở.
- Thanh tiến độ / suất trống: dãy thanh nhỏ nghiêng `transform: skewX(-40deg)` (cùng góc với ba thanh của logo), ô đã dùng màu vàng chanh hoặc màu chữ, ô trống màu đường kẻ đậm.
- Logo giữ nguyên `src/components/brand/spaca-logo.tsx` (màu theo `currentColor`).

## 5. Thành phần và bố cục

### 5.1 Header (`src/app/layout.tsx`, `src/components/header-nav.tsx`, `fund-menu.tsx`, `account-menu.tsx`)
- Nền `night`, đường kẻ dưới. Menu Explore/Campaigns/Auctions: Geist Mono viết hoa 12px.
- Menu thả xuống giữ cấu trúc hiện tại (ô nổi bật trái + danh sách mục phải), đổi sang ô `cell`, viền mảnh, không bóng; ô nổi bật dùng nền `raised` + tiêu đề Archivo viết hoa + chữ vàng chanh cho mũi tên/nhãn (không tô vàng chanh cả ô).
- Nút: **Fund** và **Account** là nút phụ (nền `cell`, viền đậm, chữ mono viết hoa). **Post a brief** (khi có) là nút chính vàng chanh.
- Dải "Local sandbox" giữ nội dung, đổi thành dải `cell` chữ mono nhỏ, nhãn nhấn dạng nền vàng chanh mờ.

### 5.2 Trang tab campaign (`src/app/campaigns/[goal]/page.tsx`, `src/components/campaign/goal-tabs.tsx`)
- Hàng tab: ô liền nhau có viền, chữ mono viết hoa + số đếm; tab đang xem nền `raised` + gạch chân 2px vàng chanh, số đếm màu `#DDF47A`.
- Đầu tab: bên trái nhãn `{ SHILLER }`, tiêu đề Archivo viết hoa (lấy `headline` trong `src/modules/requests/goal-pages.ts`), đoạn giới thiệu, nút chính vàng chanh; bên phải lưới 2×2 ô số liệu **thật** từ dữ liệu (số campaign mở, tổng suất mở, giá thấp nhất mỗi bài nếu tính được từ dữ liệu có sẵn, hạn đóng gần nhất). Không hiển thị con số không có trong dữ liệu.
- Hàng chip lọc (viên thuốc, đang chọn = nền vàng chanh mờ + viền vàng chanh). Chỉ làm bộ lọc có dữ liệu thật hỗ trợ; bộ lọc chưa có backend thì không hiện.
- **Campaign board** thay cho lưới thẻ (mục 5.3).
- Các phần "How it works", "What creators deliver", "Creators who sell this kind of work", "Recently filled or closed" giữ nguyên nội dung, đổi sang ô kẻ viền chung.
- Hình vẽ nét cho 7 tab (thay icon lucide ở vị trí minh hoạ lớn; icon nhỏ trong tab/menu có thể giữ lucide): nét mảnh 1.5px màu chữ, đường dựng nét chấm màu chữ gợi ý, đúng một mảng tô vàng chanh mờ viền `#DDF47A`. Mẫu SVG nằm sẵn trong `docs/brand/spaca-brand-kit.html` (phần "Bảy tab, bảy hình vẽ nét"): Launch = quỹ đạo phóng, Shiller = sóng tín hiệu, Airdrop = dù và gói hàng, AMA & Spaces = sóng giọng nói, Testnet = bình thí nghiệm, Education = sách mở, Memes & art = sticker bóc góc. Tạo component `src/components/campaign/goal-art.tsx`.

### 5.3 Campaign board (component mới, ví dụ `src/components/campaign/campaign-board.tsx`)
- Dùng cho: trang tab, `/requests` (tất cả campaign), và có thể "My campaigns" của buyer.
- Mỗi campaign một dòng, cột cố định: **Campaign** (icon/ảnh nhỏ 40px + tên + "by …" + nhãn mạng nếu có) · **Pay** (số tiền màu `#DDF47A`, mono, dòng phụ "budget"/"per post" theo dữ liệu thật) · **Spots** (`đã thuê / cần thuê` + thanh nghiêng) · **Closes** (thời gian còn lại + ngày) · **Status** (chip).
- Hàng tiêu đề cột: nhãn mono viết hoa trên nền `night`.
- Dòng là một link tới `/requests/<id>` với tên truy cập chứa tên campaign (test hiện tìm `getByRole('link', { name: /title/ })`).
- Điện thoại (≤ 820px): ẩn hàng tiêu đề, mỗi dòng gập thành: tên campaign chiếm cả hàng, bên dưới 2 cột số liệu.
- Ảnh dự án: không đưa ảnh bìa lớn vào dòng; dùng ảnh nhỏ (bản thumb `thumb_ids`) trong ô 40px nếu có, còn lại dùng hình vẽ nét của mục tiêu. Ảnh đầy đủ giữ ở trang chi tiết campaign.
- Giữ class hoặc cập nhật test tương ứng: e2e hiện dùng `.campaign-card` và `.badge-goal` (`tests/e2e/header-menus.spec.ts`, `campaign-tabs.spec.ts`, `campaign-brief.spec.ts`). Nếu đổi cấu trúc, sửa test theo role/tên thay vì bỏ kiểm tra.

### 5.4 Tiền (`src/app/funds/page.tsx`, `src/components/fund-menu.tsx`, `src/components/order-workspace/receipt-panel.tsx`, `performance-panel.tsx`)
- Vùng tiền đặt trên dải nền `#16161A` tách bằng đường kẻ.
- Con số lớn: Archivo hẹp; số đầu tiên (To pay / Held for your work) màu `#DDF47A`, còn lại màu chữ chính.
- Hash, địa chỉ ví, mạng: Geist Mono. Nhãn TESTNET/LOCAL: viền nét đứt màu "đang giữ".
- Trạng thái: chip Paid/Held/Disputed theo màu ngữ nghĩa ở 4.1.

### 5.5 Các trang còn lại
- Explore, trang dịch vụ, profile creator, dashboard, order workspace, admin, form đăng brief/dịch vụ, dialog đăng nhập: áp token (nền, ô, chữ, viền, bo 4px, không bóng, nút mono viết hoa, nhãn mono). Không đổi bố cục của các trang này ngoài những gì token kéo theo, trừ khi có chữ bị tràn hoặc tương phản kém.
- Thẻ/chip lựa chọn trong form (`.choice-card`, `.choice-chip`): đang chọn = viền vàng chanh + nền vàng chanh mờ; bỏ màu `--cat-*`.
- Landing `/` (`src/app/page.tsx`, `src/components/landing/landing.module.css`, `theme-boot.ts`, `theme-toggle.tsx`): landing đang có công tắc sáng/tối riêng. Đưa landing về cùng nền tối dịu + vàng chanh + chữ Archivo/Geist; giữ video hero và `BriefComposer`. Hỏi user trước nếu định bỏ công tắc sáng/tối của landing (mặc định: giữ công tắc nhưng bản tối là mặc định).

## 6. Kiểm tra bắt buộc

- Tương phản WCAG AA: chữ thường ≥ 4.5:1, chữ lớn ≥ 3:1. Các cặp đã tính: `#E8E8EA` trên `#121214` ≈ 15:1; `#DDF47A` trên `#121214` ≈ 15:1; `#121214` trên `#D6F25E` ≈ 15:1. Kiểm lại các màu ngữ nghĩa trên nền mờ của chúng.
- Focus nhìn thấy được (outline 2px màu chữ chính hoặc vàng chanh), không mất focus ring khi bỏ bóng.
- Không cuộn ngang ở 375px; menu thả xuống, bảng campaign và dải tiền vừa màn hình điện thoại.
- `prefers-reduced-motion`: tắt chuyển động không cần thiết.
- Chạy (xem `docs/HANDOFF_PROMPT.md` mục môi trường):

```bash
./node_modules/.bin/tsc --noEmit -p tsconfig.json --incremental false
RUN_DB_INTEGRATION=1 ./node_modules/.bin/vitest run
TZ=UTC ./node_modules/.bin/playwright test
./node_modules/.bin/tsx scripts/secret-scan.ts
```

- Chụp ảnh bằng Playwright ở 1280px và 375px cho: `/`, `/explore`, `/campaigns/shiller`, `/campaigns/testnet` (tab trống), `/requests`, một trang `/requests/<id>`, `/funds` (buyer_a và creator_d), một `/orders/<id>`, `/buyer/requests/new`, `/admin`. So với `docs/brand/spaca-brand-kit.html` và sửa chỗ lệch trước khi báo xong.

## 7. Thứ tự làm và commit

1. **Token + font**: `src/app/globals.css` (đổi giá trị biến hiện có: `--bg`, `--soft`, `--soft-2`, `--ink`, `--muted`, `--faint`, `--line`, `--line-strong`, `--white`, `--good*`, `--waiting*`, `--bad*`, `--accent*`, `--focus`, `--radius*`, `--shadow`; xoá `--cat-*` và chỗ dùng), nạp Archivo/Geist/Geist Mono trong `src/app/layout.tsx`. Chạy toàn bộ test, chụp ảnh, commit.
2. **Header, menu, nút, chip, badge, khung trang, section kẻ `+`**. Test, ảnh, commit.
3. **Campaign board + trang tab + hình vẽ nét 7 mục tiêu**. Test (sửa e2e theo role), ảnh, commit.
4. **Funds, biên nhận, payout, performance panel**. Test, ảnh, commit.
5. **Landing và các trang còn lại** (mục 5.5). Toàn bộ test, ảnh, commit.
6. **Tài liệu**: thêm section vào `docs/UI_CONTRACT.md` (token, quy tắc vàng chanh, campaign board), viết `docs/evidence/<agent>-BRAND-ROLLOUT.md` (lệnh đã chạy, kết quả, ảnh đã kiểm, giới hạn), cập nhật `docs/HANDOFF_PROMPT.md`. Commit.

## 8. Tiêu chí hoàn thành

- [ ] Không còn nền trắng/xám sáng hay xanh `#0071E3` ở bất kỳ trang nào trong app.
- [ ] Vàng chanh chỉ xuất hiện theo quy tắc 4.1; không có mảng vàng chanh lớn.
- [ ] Archivo / Geist / Geist Mono được nạp và dùng đúng vai trò; không font nào của Zealy/Arc/Monad.
- [ ] 7 tab dùng campaign board và hình vẽ nét riêng; `/requests` dùng campaign board.
- [ ] Funds và biên nhận nằm trên dải tiền; hash/mạng dạng mono; nhãn testnet rõ.
- [ ] tsc sạch, Vitest và Playwright đầy đủ đều đạt (hoặc ghi rõ test nào lỗi, vì sao, kèm output), quét secret sạch.
- [ ] Ảnh 1280px và 375px của các trang ở mục 6 đã xem; không cuộn ngang.
- [ ] Tài liệu và evidence đã cập nhật; mọi commit theo luật git ở mục 3.

Nếu gặp chỗ mơ hồ về **vị trí** hoặc **bố cục** mà mục này không trả lời, hỏi user trước khi làm (user đã phải sửa nhiều vòng vì đoán sai vị trí). Chi tiết màu và chữ thì theo đúng token ở trên, không cần hỏi.
