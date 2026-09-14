# Marketing brief: sản phẩm hiện tại (cập nhật 2026-09-14)

Tài liệu ngắn cho agent/người làm marketing. Nguồn chuẩn chi tiết: `docs/MASTER_PROMPT.md` §1.2.1 (định vị, USP), §6 (capacity), §8.1 (phí).

## 1. Một câu

**Chợ để dự án web3 thuê creator trên X viết bài và đăng bài; creator chỉ được trả tiền khi bài được duyệt.**

Tên thương hiệu: **spaca**. Logo: ba thanh hình bình hành trắng xếp chồng trên ô vuông đen bo góc (vector trong `src/components/brand/spaca-logo.tsx`, favicon `src/app/icon.svg`).

## 2. Khách hàng

| | Ai |
|---|---|
| **Người mua chính** | Dự án web3 cần nội dung khi ra mắt/tăng trưởng: protocol, L1/L2, DeFi, ví, infra, game, dự án sắp mainnet/TGE |
| **Người mua phụ** | Startup AI / SaaS / DevTools cần nội dung launch |
| **Người bán** | Creator crypto-native trên X: researcher, thread writer, analyst, copywriter, KOL |

Ngoài phạm vi: bán tín hiệu giao dịch, khuyến nghị đầu tư, hứa lợi nhuận.

## 3. Bán gì, mua thế nào

**4 loại sản phẩm**
- CREATE: bài viết/nội dung (thread giải thích, research, launch copy). **Có ngay.**
- PUBLISH: creator đăng bài tài trợ trên X của họ, kèm link bằng chứng và ghi chú tài trợ. *Sắp có.*
- ACCESS: thời gian (Space, AMA, tư vấn theo lịch). *Sắp có.*
- DIGITAL: sản phẩm số bán nhiều lần (template, research kit). *Để sau.*

**3 cách mua**
- **Book:** mua gói có sẵn giá, thời gian giao, số lần sửa.
- **Campaign:** một brief, ngân sách chung, thuê nhiều creator; mỗi người một đơn riêng. *(Cách chính cho launch.)*
- **Auction:** đấu giá chỗ nhận việc của creator đông khách.

**Luồng một đơn:** trả tiền → creator làm (hạn chỉ tính khi đủ tiền + brief) → giao bài → người mua duyệt / yêu cầu sửa 1 lần / mở tranh chấp → tiền về creator. Không phản hồi trong thời gian xem xét đã thỏa thuận thì tự duyệt.

## 4. USP để marketing (kèm trạng thái thật)

| # | USP | Trạng thái |
|---|---|---|
| 1 | Chỉ creator crypto-native / tech trên X; chọn theo mẫu bài và lịch sử giao, không theo follower | Định vị; **chưa có creator thật** |
| 2 | Thuê cả đội từ một brief (campaign) | Đã có (chạy local) |
| 3 | Quỹ thưởng: nạp USDC/token một lần, trả từng creator khi bài được duyệt, phần thừa rút lại | **Chỉ chạy giả lập**, chưa lên Arc testnet |
| 4 | Điều khoản chốt lúc mua; hạn giao công bằng; giải ngân khi duyệt; có tranh chấp | Đã có (thanh toán giả lập) |
| 5 | Uy tín minh bạch: dưới 3 đánh giá hiện "New", không sao ảo | Đã có |
| 6 | Creator tự đặt số đơn làm cùng lúc, có nút tạm nghỉ ("never overbooked") | Đã chốt spec, **chưa code** |
| 7 | Bằng chứng bài đăng tài trợ (link, thời điểm, disclosure) | Chưa có |
| 8 | Đấu giá creator đông khách | Đã có |

**Tagline đang dùng:** "Run creator campaigns on X for your web3 launch — fund once, pay each creator on approval."
**Hero landing:** câu brief điền chỗ trống — "We're launching a [mainnet] and need [5] [researchers] on X within [two weeks]."

## 5. Được nói / không được nói

**Không được nói**
- "0% fee" — cam kết phí 0% đã bỏ; mức phí chưa chốt. Viết "[FEE POLICY]".
- "Real open slots / lịch trống thật" — đã bỏ khỏi thông điệp.
- "Escrow", "trustless", "guaranteed", "audited".
- Crypto/USDC/Arc "đã hoạt động" — hiện chỉ giả lập; luôn gắn nhãn "testnet / coming soon".
- Số liệu, logo khách hàng, testimonial, số creator — **chưa có giao dịch thật nào**.
- Bất kỳ lời hứa lợi nhuận hay nội dung kiểu "call kèo".

**Bắt buộc**
- Bài tài trợ phải ghi rõ là tài trợ.
- Người mua trả bằng thẻ được, không bắt tạo ví.
- Không so sánh đích danh đối thủ trên landing (dùng "generic freelance marketplace").

## 6. Hiện trạng sản phẩm

- Backend gần đủ (đặt đơn, campaign, đấu giá, quỹ thưởng, tìm kiếm, admin), **chỉ chạy trên máy local**.
- Thanh toán thẻ và crypto đều **giả lập**; chưa Stripe, chưa Arc thật, chưa smart contract.
- Chưa deploy, chưa có người dùng thật.
- Landing mới đã code ở `/` (có nút sáng/tối, hero brief bấm được); chợ ở `/explore`. Chưa có video nền.

## 7. Phong cách thương hiệu

- Tối giản kiểu Apple: nền trắng / xám `#F5F5F7` / đen; chữ `#1D1D1F`, `#6E6E73`.
- Nút chính màu đen (bản tối: trắng). Màu chỉ dùng có nghĩa ở điểm trọng tâm: xanh lá = đã duyệt/đã trả/đang nhận đơn, cam = testnet/đang chờ xử lý, đỏ = cấm/tranh chấp. Không gradient tràn lan.
- Nút bo tròn dạng viên thuốc; hiệu ứng kính (Liquid Glass) dùng rất ít (thanh menu, bảng chọn).
- Có bản sáng và bản tối. Tiếng Anh cho thị trường.
- Giọng văn: ngắn, cụ thể, không hype, không jargon tài chính.

## 8. Chưa chốt (hỏi chủ sản phẩm trước khi dùng)

1. Mô hình phí (mức phí, ai trả).
2. Có kiểm duyệt dự án trước khi mở campaign không.
3. Có đưa crypto thật (Arc testnet, contract) lên ưu tiên trước không.
4. Creator cần 3 hay 1 mẫu bài để đăng dịch vụ.
