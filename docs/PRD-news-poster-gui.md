# PRD: Web GUI cho news-poster (Auto-news bot)

**Status**: Approved (khách duyệt v1) — câu hỏi mở đã đóng ở §10
**Author**: PM (Alex)  **Last Updated**: 2026-08-20  **Version**: 0.2
**Stakeholders**: Khách hàng (người dùng duy nhất), Dev
**Liên quan**: `poster.ts`, `rss.ts`, `dedup.ts`, `session.ts`, `google-oauth.ts`, `auth.client.ts`, `community.client.ts`, `llm.client.ts`, `ecosystem.config.cjs`

---

## 1. Problem Statement

Khách hàng tự host bot news-poster trên Windows, hiện **phải thao tác hoàn toàn bằng terminal**: chạy `npm start`/PM2 để bật, gửi Ctrl+C để tắt, đọc log bằng mắt, sửa `.env` bằng tay, theo dõi lịch sử bài đăng không có gì ngoài file `posted.json` dạng hash.

**Yêu cầu nguyên văn:** "Cái này tôi đang muốn làm 1 trang giao diện, trực quan. Chứ hiện tại khởi động tool các thứ đang phải dùng terminal và không trực quan gì cả hãy làm đi."

**Cost của việc không làm:** mỗi lần sửa feed/phải check bot còn chạy/bot có đang đăng bài không đều phải mở terminal, đọc log thô, edit file — khó thao tác, dễ sai, không biết bài nào đã đăng.

**Evidence:**
- Không có bất kỳ API/channel điều khiển nào trong code (chỉ CLI args + console output).
- `posted.json` chỉ lưu `{key: sha256(link), ts}` — không có title/link/postId/status nên không thể "xem lịch sử bài đã đăng" nếu không sửa data model.
- User là **1 cá nhân tự host 1 máy** — không cần multi-user, RBAC, hay infra phức tạp.

---

## 2. Goals & Success Metrics

| Goal | Metric | Baseline | Target |
|------|--------|----------|--------|
| Thao tác start/stop không cần terminal | Số thao tác quản trị cần terminal | 100% | 0% (với GUI đang chạy) |
| Xem trạng thái + log trực quan | Thời gian phát hiện bot lỗi/sleep | phút–giờ (phải tự mở terminal đọc) | ≤ 3 giây (log auto-refresh trên GUI) |
| Xem lịch sử bài đã đăng | Nhìn thấy title/link/thời gian/postId/trạng thái từng bài | không có | 100% bài mới đăng ghi đủ 5 field |
| Cấu hình RSS qua GUI | Thay đổi feed + interval + limit không sửa file | không có | thao tác ≤ 1 phút, áp dụng chu kỳ kế tiếp |

**North star cho phiên bản này:** *"Khách hàng mở browser, thấy bot đang chạy hay không, và không bao giờ phải mở terminal nữa."*

---

## 3. Non-Goals (phạm vi ngoài v1)

- KHÔNG multi-user / login / RBAC / phân quyền. (1 người, localhost.)
- KHÔNG build pipeline frontend (bundle/webpack), KHÔNG Angular.
- KHÔNG database — giữ JSON file hiện tại (`posted.json`, `.session.json`, `.env`).
- KHÔNG mang bot lên server/cloud; GUI chạy local đúng nơi bot chạy.
- KHÔNG chỉnh sửa content-service/gateway/service khác — tool độc lập như hiện tại.
- KHÔNG hỗ trợ multi-feed (bot hiện chỉ 1 `RSS_FEED_URL`); nút "post one-shot với feed bất kỳ" đã có sẵn.
- KHÔNG hiển thị số liệu phân tích (NPS, KPI dài hạn) — chỉ trạng thái real-time + lịch sử.
- KHÔNG làm GUI đẹp hoàn hảo trên mobile (ưu tiên desktop browser).

---

## 4. Kịch bản người dùng (User flows)

### FLOW 1 — Khởi động & dừng bot
1. User chạy `npm run web` (hoặc PM2) → bot tự mở GUI `http://127.0.0.1:8899`.
2. Dashboard hiện trạng thái: **Đang chạy / Đã dừng / Lỗi**, kèm config hiệu lực (feed, interval, community, dry-run).
3. Nút **⚙ Start / ⏹ Stop** — bấm Start bắt đầu vòng lặp (pre-flight quyền + fetch RSS), bấm Stop chờ kết thúc chu kỳ hiện tại rồi dừng (giữ đúng hành vi SIGTERM hiện có).
4. Trạng thái phản hồi trong ≤ 3 giây. GUI **cấm bấm đúp** (nút vô hiệu khi đang chuyển trạng thái).

### FLOW 2 — Xem log real-time
1. Tab **Nhật ký (Log)**: stream các dòng console (suffix như `[news-poster]`, `[OK]`, `[FAIL]`, `[SKIP]`, `[LLM]`) tự refresh.
2. Có thanh cuộn về cuối + bộ lọc (mọi / fail / skip).

### FLOW 3 — Xem trạng thái & auth
1. Dashboard hiển thị: lần chạy cuối cùng, kết quả bài cuối (OK/FAIL + lý do như profanity/unauthorized), thời hạn access token / trạng thái session (còn dùng được không).
2. Nếu session hết hạn → nút **"Đăng nhập lại (Google)"** dẫn FLOW 6.

### FLOW 4 — Cấu hình nguồn RSS (và các config chính)
1. Tab **Cấu hình**: form hiển thị `RSS_FEED_URL`, `RSS_LIMIT_PER_CYCLE`, `POST_INTERVAL_MS`, `COMMUNITY_ID`, `LAYOUT_TYPE`, `DRY_RUN`, cấu hình LLM (base URL, model, key).
2. User sửa → **Lưu** → ghi vào `.env` (không ghi đè secret). Bot áp dụng feed mới vào chu kỳ kế tiếp (không cần restart; ghi rõ trên UI).
3. Nút **"Kiểm tra feed"** gọi `fetchRssItems` hiện có → hiện N bài đầu tiên + bài preview.
4. Tab này cũng hiện danh sách community + quyền `POST_CONTENT` (dùng `listMyCommunities` + `getMyMemberPermission` đã có).
5. Secret (Google client secret, LLM API key) chỉ hiển thị dạng `••••••`, cho phép đặt lại — **không trả về qua API**.

### FLOW 5 — Xem lịch sử bài đã đăng
1. Tab **Lịch sử**: bảng các bài đã đăng — title, link nguồn, thời gian đăng, postId, trạng thái (OK / SKIP / FAIL + lý do).
2. Click link → mở bài gốc RSS. Có nút **"Đăng thử 1 bài"** (one-shot) và toggle **dry-run** (preview nội dung trước khi đăng).

### FLOW 6 — Setup OAuth lần đầu (GUI hoá)
1. Dashboard báo "Chưa có session" → nút **"Kết nối Google"** → GUI mở URL consent (URL đã có sẵn từ `getGoogleAuthUrl`).
2. Sau authorize, redirect `/callback` do GUI (server nhúng) nhận → exchange → `loginWithGoogle` → lưu `.session.json`.
3. Nếu gặp bước 2FA / register → GUI hiển thị thông báo lỗi thân thiện thay vì 1 dòng trong terminal.

---

## 5. Scope — In / Out

### Trong phạm vi (v1)
| STT | Chức năng | Nguồn trong code |
|----|-----------|-------------------|
| 1 | Server HTTP nhúng + serve 1 trang GUI tĩnh | [CẦN THÊM] |
| 2 | Start/Stop vòng lặp bot từ GUI | [CẦN THÊM] refactor `modeRun` |
| 3 | Trạng thái chạy + số liệu chu kỳ gần nhất | [CẦN THÊM] |
| 4 | Log panel real-time (capture in-process, vẫn giữ stdout cho PM2) | [CẦN THÊM] |
| 5 | Lịch sử bài đăng đầy đủ thông tin | [CẦN THÊM] mở rộng `dedup.ts` |
| 6 | Xem/sửa cấu hình chính + kiểm tra feed + chọn community | đọc config [ĐÃ CÓ]; form lưu `.env` [CẦN THÊM] |
| 7 | Post one-shot (test / rss) + dry-run preview | logic [ĐÃ CÓ]; API trigger [CẦN THÊM] |
| 8 | Kết nối Google OAuth từ GUI | URL/flow [ĐÃ CÓ]; nhúng callback + UI [CẦN THÊM] |

### Ngoài phạm vi
Multi-feed dashboard, cron UI, notify khi lỗi (email/telegram), mobile app, theo dõi post chết, dashboard phân tích, log file rotation, tiếng Anh/đa ngôn ngữ.

---

## 6. Functional Requirements (đánh dấu nguồn)

> Qui ước: **[ĐÃ CÓ]** = logic tồn tại trong code, GUI chỉ cần expose/call; **[CẦN THÊM]** = phải xây mới hoặc refactor code hiện tại.

### FR-1. Server GUI + trang quản trị  [CẦN THÊM]
- HTTP server nhúng chạy cùng process bot, mặc định bind `127.0.0.1:8899` (env `GUI_PORT`, mặc định đổi được).
- Serve 1 trang `index.html` + JS thuần (không build). Trang có 4 tab: Dashboard, Nhật ký, Lịch sử, Cấu hình.
- Zero dependency mới cho backend (dùng `node:http`); tuân thủ ethos "zero runtime deps" của project.

### FR-2. Start / Stop bot  [CẦN THÊM]
- Refactor vòng lặp trong `modeRun()` thành singleton controller (`BotController`) với `start()`, `stop()`, `getStatus()`; giữ nguyên logic hiện có (bootstrap token, pre-flight quyền, fetch RSS, dedup, LLM rewrite, retry profanity ≤2, upload ảnh, sleep).
- `stop()` giữ hành vi "chờ hết chu kỳ hiện tại" như SIGTERM cũ.
- Vẫn giữ hỗ trợ SIGINT/SIGTERM cho PM2/terminal (không phá vỡ cấu hình PM2 hiện có).
- Trạng thái: `RUNNING | STOPPED | STARTING | STOPPING | ERROR` + `lastCycleAt`, `lastPostResult {ok, title, postId|reason}`, `cycleCount`, `postedToday`.

### FR-3. Xem log  [CẦN THÊM]
- Logger nhẹ: ghi đồng thời ra `console` (giữ stdout PM2) và ring-buffer in-memory (tối đa ~1000 dòng).
- `GET /api/logs?since=<seq>` trả các dòng mới từ seq; GUI poll 2 giây (polka đơn giản hơn SSE; SSE là enhancement nếu muốn sau).

### FR-4. Lịch sử bài đăng  [ĐÃ CÓ cơ chế dedup / CẦN THÊM data model]
- Mở rộng entry `dedup.ts` thành `{ key, title, link, postId?, status: 'posted'|'skipped'|'failed', reason?, ts }`.
- Backward compatible: `hashKey(link)` không đổi (không phá dedup cũ); entry cũ thiếu field hiển thị `—`.
- `GET /api/history?limit=100&status=` trả list sắp xếp theo `ts` giảm dần; giữ giới hạn 1000 entry như hiện tại.
- Vẫn ghi `posted.json` cho cả SKIP và FAIL để phòng spam post lại (hành vi hiện có).

### FR-5. Xem/sửa cấu hình  [ĐÃ CÓ nguồn config / CẦN THÊM ghi + reload]
- `GET /api/config` trả config hiện tại, **mask mọi secret** (`GOOGLE_CLIENT_SECRET_WEB`, `LLM_API_KEY`) — chỉ trả `set: true/false`.
- `POST /api/config` ghi file `.env` (atomic: viết temp rồi rename), chỉ ghi các field cho phép (không ghi secret trực tiếp; secret đặt lại qua field `…_SET` riêng).
- Config mới được áp dụng từ chu kỳ kế tiếp (controller đọc lại config mỗi cycle — thay đổi nhỏ trong vòng lặp).
- Nút "Kiểm tra feed" → `GET /api/rss-preview?url=` tái dùng `fetchRssItems` + `buildContent` (đã có) → hiện preview.
- Tab community: `GET /api/communities` tái dùng `listMyCommunities` + `getMyMemberPermission` (đã có).

### FR-6. Post one-shot từ GUI  [ĐÃ CÓ logic / CẦN THÊM API]
- `POST /api/post` với `{mode: 'test'|'rss', content?, rssUrl?, limit?, dryRun?}` — tái dùng toàn bộ logic `modeOneShot` hiện có.
- Kết quả trả về `{ok, postId?, reason?}` và tự ghi vào lịch sử (FR-4). Giới hạn: không cho chạy khi bot đang RUNNING (tránh đè chu kỳ tự động).

### FR-7. Kết nối Google  [ĐÃ CÓ OAuth engine / CẦN THÊM GUI-integration]
- `POST /api/setup/start` → trả URL consent (tái dùng `getGoogleAuthUrl`); `GET /callback` (server nhúng) tiếp nhận code (kế thừa pattern `waitForRedirectCode`), exchange → `loginWithGoogle` → lưu session (tất cả đã có).
- `GET /api/auth-status` → trả `{hasSession, accessExpiresAt, hasGoogleRefresh, communityPermission}` (đã có dữ liệu qua `session.ts` + `community.client.ts`).

### FR-8. An toàn tối thiểu  [CẦN THÊM]
- Bind theo `GUI_HOST` (mặc định `127.0.0.1`; **được phép đặt `0.0.0.0`** để truy cập từ xa/thiết bị khác — theo quyết định khách §10.4).
- `GUI_TOKEN`: **bắt buộc phải đặt khi `GUI_HOST=0.0.0.0`**; nếu đặt, GUI đòi `Authorization: Bearer <token>` cho mọi request. Khi bind local và không đặt token → không auth (1 user local). App **từ chối khởi động server** (exit≠0, thông báo rõ) khi `0.0.0.0` thiếu token. GUI chỉ hiển thị trạng thái token "đã đặt / chưa đặt" — khác bản cũ (mặc định tắt, chỉ local).
- API không bao giờ trả secret (xem FR-5). Không thêm bất kỳ endpoint nào thay đổi dữ liệu mà không có confirm trên UI.

---

## 7. Non-Functional Requirements

| Yêu cầu | Chi tiết |
|---------|----------|
| **Đơn giản ưu tiên** | Không framework nặng, không build step, không DB. Seret lý thuyết: người dùng = 1 cá nhân tự host; nếu mất 1 tuần chỉ để làm infra thì là over-engineer. |
| **Ít dependency** | Ưu tiên **0 dependency npm mới** (native `node:http`, `fs`, vanilla JS). Chỉ thêm tối đa 1 dependency nhỏ (ví dụ `express`) nếu dev đánh giá routing tay tốn thời gian hơn. |
| **Chạy local, offline** | Không cần CDN; JS/CSS đi kèm file tĩnh do GUI serve. |
| **Không phá vỡ hiện trạng** | PM2 config + CLI (`npm start`, `--mode=test|rss`, `--dry-run`) phải hoạt động y hệt. GUI là lớp bổ sung. |
| **Hiệu năng** | Poll `/api/logs` 2s + `/api/status` 2s không ảnh hưởng vòng lặp; ring buffer bounded (≤1000 dòng). |
| **Độ tin cậy dữ liệu** | Ghi `.env`/`posted.json` atomic, không lỗi nửa chừng. Ngôn ngữ UI: tiếng Việt. |

---

## 8. Stack đề xuất (kèm trade-off)

**Đề xuất: Kiến trúc "server nhúng + 1 trang tĩnh"** — bot và GUI cùng 1 process.

| Lớp | Lựa chọn | Trade-off |
|-----|----------|-----------|
| Backend API | Node `node:http` (routing tay ~10 endpoint), hoặc `express` nếu muốn | `node:http` = 0 dep, đúng ethos project; hơi thủ công. `express` = quen thuộc, nhanh, +1 dep nhỏ |
| Served static | `index.html` + `app.js` + `style.css` (vanilla JS, DOM thuần, fetch API) | Không code-split, không framework; đủ cho 4 tab. Từ chối React/Angular = cần build pipeline + dependency — over-engineer |
| Real-time thay thế | Polling 2s (đề xuất) | Đơn giản nhất, đúng nhu cầu; SSE/WebSocket là enhancement sau nếu cần |
| Process control | BotController in-process (refactor loop) | Đơn giản nhất; nhược điểm: process chết thì GUI chết theo (chấp nhận — user khởi động lại qua PM2, PM2 autorestart đã có). Phương án B (GUI quản lý child-process) phức tạp hơn nhiều, KHÔNG chọn. |
| Data | JSON file hiện tại (`posted.json`, `.env`, `.session.json`) + extension nhẹ | Không DB; đủ cho 1000 entry/bot |
| Hypothesis cần test | Người dùng 1 cổng 8899 + tunnel (nếu cần xem từ xa) là đủ, không cần auth phức tạp | Nếu máy dùng chung/có người khác truy cập → bật `GUI_TOKEN` |

**Vì sao không chọn:** Angular/React/Vue (cần build toolchain — over-engineer), kiến trúc GUI-quản-lý-child-process (nhiều moving part, phải quản lý orphan/zombie process), DB (dữ liệu đã JSON và nhỏ), Docker (khách tự host Windows local).

---

## 9. Acceptance Criteria (đo được)

1. `npm run web` mở GUI tại `http://127.0.0.1:8899`; không cài thêm gì ngoài `npm install` hiện có.
2. Trong GUI khởi động được bot → API status về `RUNNING` trong ≤ 3 giây; Stop → `STOPPED` trong ≤ 5 giây; không bấm đúp được.
3. Log hiển thị dòng mới trong ≤ 3 giây kể từ khi có sự kiện; tối thiểu 1000 dòng gần nhất.
4. Mỗi lần đăng bài thành công, lịch sử có đủ: title, link, thời gian, postId, status; bài cũ (trước nâng cấp) vẫn show (TS = bài cũ, còn lại `—`) và không làm hỏng dedup.
5. Sửa `RSS_FEED_URL` qua GUI → file `.env` cập nhật, chu kỳ kế tiếp fetch feed mới; không cần restart.
6. "Kiểm tra feed" hiển thị ≥1 item preview từ feed đã nhập.
7. Setup Google qua GUI hoàn tất → `GET /api/auth-status` trả `hasSession=true`; login-google 2FA/register fail → hiển thị thông báo rõ ràng.
8. API không trả về `GOOGLE_CLIENT_SECRET_WEB`/`LLM_API_KEY` dưới bất kỳ dạng nào.
9. `npm start`, PM2 (`ecosystem.config.cjs`), `--dry-run` vẫn chạy đúng như trước (regression test).
10. Zéro dependency npm mới (hoặc tối đa 1, đã phê duyệt).

---

## 10. Quyết định đã đóng / Rủi ro / Giả định

### Quyết định đã đóng (khách duyệt — áp dụng cho v1)

1. **Chỉ quản 1 feed RSS** (không multi-feed) — đúng scope v1. GUI có post one-shot với feed bất kỳ (logic đã có, expose qua API).
2. **Config áp dụng từ chu kỳ kế tiếp** (không tự restart bot). UI phải ghi rõ "áp dụng từ chu kỳ sau".
3. **GUI nhúng cùng 1 process bot.** Thêm lệnh `npm run web` (server GUI always-on, vòng lặp bot đợi nút Start trên GUI); `npm start` / PM2 / SIGINT / SIGTERM giữ y nguyên. Bot crash → PM2 autorestart kèm GUI (đã cấu hình).
4. **Xem từ xa ĐƯỢC MỞ:** thêm `GUI_HOST` (mặc định `127.0.0.1`, được phép `0.0.0.0`) + `GUI_TOKEN` (**bắt buộc phải đặt khi `GUI_HOST=0.0.0.0`**; xác thực `Authorization: Bearer`). → cập nhật FR-8 (bản cũ mặc định tắt).
5. **Lịch sử giữ giới hạn 1000 entry** (không đổi) — ~10 ngày hoạt động; nâng là v2.

**Ghi chú (decision log, v0.1 → v0.2):**
- §10 "Câu hỏi mở" → **"Quyết định đã đóng"** theo 5 mục trên; không còn câu hỏi mở blocking nào ở v1.
- FR-8 được chỉnh lại theo quyết định 4: binding theo `GUI_HOST`; `GUI_TOKEN` bắt buộc khi bind remote; app từ chối khởi động server khi `0.0.0.0` thiếu token.
- Điểm cần Design council (Phase 2) chốt duy nhất: tuyến nhận redirect OAuth — FR-7 nói server nhúng nhận `/callback`, nhưng giả định §10 cũ giữ `GOOGLE_OAUTH_REDIRECT_URI=…:8787/callback` (dùng `waitForRedirectCode` sẵn có). Cả 2 tuyến đều tái dùng `getGoogleAuthUrl`/`exchangeCodeForTokens`/`loginWithGoogle`; không phát sinh hạ tầng mới.

### Rủi ro
| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Lộ secret qua GUI | Thấp | Cao | FR-5 mask secret, chỉ bind 127.0.0.1, `GUI_TOKEN` tùy chọn |
| Refactor `modeRun` vô tình đổi hành vi retry profanity / refresh token | Trung bình | Cao | Giữ nguyên code path, tách controller mảnh, có mode `run` cũ làm regression test |
| Thay đổi schema `posted.json` | Cao (đã lường) | Thấp | Backward-compatible, `hashKey` không đổi |
| GUI chết cùng bot process | Chắc chắn | Thấp | PM2 autorestart (đã cấu hình) khởi động lại cả bot lẫn GUI |

### Giả định
- Khách chạy GUI trên cùng máy với bot (Windows, Node ≥ 18).
- Chấp nhận polling (không bắt buộc websocket).
- Không có yêu cầu về log bền vững (restart bot = log cũ mất; nếu cần, v2 ghi log file, nằm ngoài scope).
- `GOOGLE_OAUTH_REDIRECT_URI` hiện tại là `http://localhost:8787/callback` được giữ nguyên cho setup (server nhúng không phải port OAuth riêng).

---

## 11. Launch Plan (nhỏ, 1 người)

| Phase | Nội dung | Gate |
|-------|----------|------|
| Dev | Refactor controller + server + GUI v1 (4 tab) | `npm run web` chạy, đủ AC 1–8 |
| Regression | `npm start`, PM2, `--dry-run`, `--mode=rss` chạy đúng | AC 9 |
| UAT | Đưa khách thao tác: start/stop, đăng thử, sửa feed, xem lịch sử | Khách dùng được không cần terminal cho các việc hàng ngày |

**Ước lượng**: M (1 dev, ~2–3 tuần). T-shirt S nếu cắt FLOW 6 (kết nối Google vẫn để terminal cho v1).

---

## 12. Appendix
- Nguồn code tham chiếu: `C:/MAYogu_VIASG/news-poster/poster.ts` (loop + modes), `dedup.ts` (schema hiện tại), `google-oauth.ts` (redirect server mẫu — pattern hợp để tái dùng cho GUI server), `ecosystem.config.cjs` (PM2), `.env.example` (list config).