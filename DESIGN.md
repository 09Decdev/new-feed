# Plan — Tool auto-news-poster (MVP)

> Trạng thái: **CHỜ REVIEW/APPROVE** — chưa viết code. Theo quy tắc CLAUDE.md (global rule), không code cho đến khi plan này được user approve.

## 1. Mục tiêu & phạm vi (v1)

Viết 1 tool **độc lập** (không sửa nội bộ content-service) gọi HTTP API `POST /content-service/post` để tạo bài viết. Mục tiêu trước mắt mà user yêu cầu: **"tạo bài viết thử"** với token + communityId do user cấp. Mở rộng nhẹ cho mục tiêu auto-news (lấy tin từ RSS báo Việt).

Phạm vi v1:
- Tạo 1 bài test với content thủ công (mode `test`).
- (Tùy chọn) Lấy bài mới nhất từ 1 RSS feed báo VN và đăng (mode `rss`).
- **Bỏ qua ảnh** ở v1: gắn ảnh cần upload lên upload-service trước để lấy `fileId` (xem §7).

## 2. Vị trí & runtime

- Thư mục: `tools/news-poster/` (standalone, không nằm trong `src/` → không ảnh hưởng build NestJS).
- Runtime: `ts-node` (đã có trong devDeps, giống `npm run worker`).
- Load config: `dotenv-cli` (đã có) qua `.env` cục bộ của tool.
- HTTP: dùng **native `fetch`** (Node >=18) — **không thêm dependency mới**.
- Parse RSS: parse XML thủ công (RSS 2.0 đơn giản) — không thêm thư viện. (Nếu sau này cần robust hơn mới thêm `rss-parser`.)

## 3. Cấu trúc file

```
tools/news-poster/
├── PLAN.md            ← file plan này
├── .env.example       ← mẫu biến môi trường (user điền token/communityId)
├── poster.ts          ← entry: CLI, dispatch theo mode
├── content-service.client.ts  ← wrapper gọi API tạo post
├── rss.ts             ← fetch + parse RSS, build nội dung bài
└── README.md          ← cách chạy (ngắn)
```

Thêm 2 script vào `package.json` (scripts) — KHÔNG thêm dependency:
- `"news:test": "dotenv -e tools/news-poster/.env -- ts-node tools/news-poster/poster.ts --mode=test"`
- `"news:rss": "dotenv -e tools/news-poster/.env -- ts-node tools/news-poster/poster.ts --mode=rss"`

## 4. Cấu hình (`.env` của tool)

```
CONTENT_SERVICE_URL=http://localhost:3001
AUTH_TOKEN=<user cấp — JWT, middleware chỉ decode không verify>
COMMUNITY_ID=<user cấp>
LAYOUT_TYPE=CLASSIC            # CLASSIC | COLUMNS | FRAME (mặc định CLASSIC)
RSS_FEED_URL=https://vnexpress.net/rss/tin-moi-nhat.rss
DRY_RUN=false                  # true = chỉ fetch+build, không gọi create
```

CLI args (override env): `--mode=test|rss`, `--content "<text>"`, `--rss <url>`, `--limit <n>`, `--dry-run`.

## 5. Gọi API chi tiết

- **Endpoint:** `POST {CONTENT_SERVICE_URL}/content-service/post`
- **Headers:**
  - `Authorization: Bearer {AUTH_TOKEN}` — middleware `JwtMiddleware` decode lấy `sub` → set `x-user-id` (cho decorator `@User('id')`). Token cũng được forward tới community-service trong `validateExternalResources` → phải hợp lệ cho cả community-service.
  - `Content-Type: application/json`
- **Body** (CreatePostDto — chỉ field cần thiết):
  ```json
  {
    "communityId": "<COMMUNITY_ID>",
    "content": "<nội dung bài>",
    "layoutType": "CLASSIC"
  }
  ```
  `fileIds` để trống (v1 không ảnh). `publishedAt`/`background`/`expiredInDays` không gửi (dùng default).
- **Response thành công:** 201 + object post (qua TransformResponseInterceptor → `{ success, data, ... }`).
- **Xử lý lỗi phổ biến:**
  - 400 `INAPPROPRIATE_CONTENT` → content dính profanity (xem §6 cảnh báo).
  - 400 `BUSINESS_LOGIC_ERROR` (phone) → tài khoản chưa verify SĐT.
  - 401/403 → token không hợp lệ / không có quyền post trong community.
  - Lỗi validateExternalResources → token không hợp lệ cho community-service hoặc chưa là member.

## 6. ⚠️ Cảnh báo quan trọng: profanity filter chặn tin tức

`ProfanityHelper` ([profanity.helper.ts](../../src/core/helper/profanity.helper.ts)) có word-list cứng chứa nhiều từ **xuất hiện tự nhiên trong tin tức**:
- "chết", "đánh", "giết", "đâm", "chém", "bạo loạn", "khủng bố", "ma túy", "cần sa", "vay vốn", "lãi suất", "bắt cóc", "tự tử", "phản động"...

→ Bài tin về tai nạn, án mạng, chính trị, kinh tế, ma túy **sẽ bị reject** (400 `INAPPROPRIATE_CONTENT`).

Cách xử lý cho v1:
- Mode `rss` mặc định chọn feed **an toàn** (công nghệ/thể thao/giải trí) để tránh từ khóa nhạy cảm.
- Tool log rõ khi bị reject profanity + tên bài, để user biết đã skip bài nào.
- Giải pháp lâu dài (ngoại phạm vi v1): thêm config bypass cho "tài khoản bot" hoặc community tin tức — nhưng đó là thay đổi content-service, cần plan riêng.

## 7. Ảnh — lý do bỏ qua ở v1

`create()` gọi `helper.resolveMediaAttachments(fileIds)` → verify fileId thuộc về user qua upload-service. Tool không thể truyền URL ảnh trực tiếp; phải:
1. Download ảnh từ RSS.
2. Upload ảnh lên upload-service → nhận `fileId[]`.
3. Truyền `fileIds` vào body.

Chuỗi này phức tạp → để v2. v1 chỉ đăng tin vắn (title + tóm tắt + link nguồn) dạng text.

## 8. Flow chính (poster.ts)

1. Đọc config từ env + CLI args.
2. Theo mode:
   - `test`: content = `--content` hoặc 1 chuỗi test mặc định.
   - `rss`: gọi `rss.ts` fetch feed → parse → lấy N bài mới nhất → build content từng bài (`{title}\n\n{summary}\n\nNguồn: {link}`).
3. `DRY_RUN=true`: in content ra, thoát.
4. Gọi `content-service.client.ts` → `POST /content-service/post` cho từng bài.
5. Log kết quả (post id hoặc lỗi). Với mode rss: skip + log bài bị profanity reject, tiếp tục bài khác.

## 9. Giới hạn v1 / mở rộng tương lai

- v1: text-only, manual hoặc 1 RSS feed, không dedup, không ảnh, không cron.
- v2: upload ảnh lấy fileId; dedup bằng local JSON/hash; đa feed; chạy theo cron (`node-cron` hoặc system cron).

## 10. Điều kiện tiên quyết (user cần đảm bảo cho tài khoản bot)

- Token (JWT) có claim `sub`, hợp lệ cho content-service **và** community-service.
- Tài khoản bot: đã **verify SĐT** + là **member có quyền đăng bài** trong `COMMUNITY_ID`.

---

**Yêu cầu approve:** Khi bạn OK plan này, mình sẽ tạo các file ở §3 + 2 script trong package.json. Bạn có muốn điều chỉnh phạm vi v1 (vd. bỏ hẳn mode rss, chỉ làm test post) không?
