# PLAN — Web GUI cho news-poster (v1)

**Trạng thái**: Kế hoạch thực thi (đã đóng scope/decision theo PRD v0.2)

## QUYẾT ĐỊNH CỦA KHÁCH (đã chốt tại GATE 1 & 2, 2026-08-20)
1. Scope đúng PRD v1 (server nhúng + 1 trang tĩnh, 4 tab, giữ CLI/PM2/--dry-run).
2. Quản **1 feed RSS** (không multi-feed); GUI có post one-shot.
3. Remote access **cho phép mở**: `GUI_HOST` (mặc định `127.0.0.1`, cho phép `0.0.0.0`) + `GUI_TOKEN` bắt buộc khi bind remote; trang nhập token anonymous để tránh deadlock.
4. Config áp dụng **từ chu kỳ kế tiếp** (không restart).
5. [GATE 2] Item RSS đăng FAIL → **ghi entry luôn, không retry lại link đó** (đổi hành vi so với code cũ poster.ts:401; ghi chú trong ASSURANCE).
6. [GATE 2] OAuth redirect → **embedded `/callback` trên GUI_PORT (8899)**; khách phải thêm `http://localhost:8899/callback` (+ host thật nếu remote) vào Authorized redirect URIs Google Console — danh sách cụ thể xuất trước Phase E.
**Nguồn duy nhất**: `docs/PRD-news-poster-gui.md` (khách đã DUYỆT) + `docs/ASSURANCE.md` (HARD-GATE chung)
**Ngày**: 2026-08-20
**Ước lượng**: ~24 dev-days nối tiếp (~3 tuần, 1 dev); gọn hơn nếu chạy song song theo Wave (xem §4)

---

## 1. Bối cảnh & ràng buộc cố định (bám sát thực tế code)

- **Không có test runner hiện tại.** `package.json` định nghĩa `npm test` = **one-shot post** (`dotenv -- ts-node poster.ts --mode=test`), KHÔNG phải test framework → mọi script test mới phải đặt tên khác (`test:unit`, `test:api`, `test:stream`) để không đè hành vi CLI hiện có.
- `markPosted` (dedup.ts:29) và `saveSession` (session.ts:22) đang dùng `writeFileSync` **không atomic** → mâu thuẫn NFR "ghi .env/posted.json atomic" → phải thêm write-atomic và refactor 2 điểm trên.
- `loadDotEnv()` (poster.ts:528) chỉ điền biến **chưa tồn tại** trong `process.env` → config sửa trên `.env` không tự hiệu lực bằng hàm cũ → Phase B bắt buộc có cơ chế reload env allowlist riêng.
- `waitForRedirectCode` (google-oauth.ts:35) tự mở server redirect port 8787; PRD FR-7 muốn server nhúng nhận `/callback` → tuyến nhận redirect do **T24 (Phase C) chốt**, 2 tuyến đều tái dùng code sẵn có.
- `auth.client.ts` đã ném lỗi phân biệt 2FA (`require2fa`) và register (`register=true`) → GUI chỉ cần bắt + hiển thị, không thêm logic.
- Loại role được phép gán (owner chỉ theo vai, không tên người thật): **Frontend Developer / Backend Architect / Test Automation Engineer / API Tester / Realtime Collaboration Engineer**.

---

## 2. Phân rã phase

| Phase | Nội dung | Task | Gate ra phase sau |
|---|---|---|---|
| **A** | Core refactor `modeRun` → `BotController` (start/stop/status + lịch sử data) | T1, T2 | GATE-A |
| **B** | Config store + ghi `.env` atomic + áp dụng từ chu kỳ kế tiếp | T3, T4 | GATE-B |
| **C** | HTTP server nhúng + toàn bộ API endpoints + remote access + start/stop API + single-instance guard + OAuth route decision | T5–T10, T22, T23, T24 | GATE-C |
| **D** | GUI frontend tĩnh 4 tab | T11–T15 | GATE-D |
| **E** | OAuth setup từ GUI | T16, T17 | GATE-E |
| **F** | Regression + bộ test (unit/API/stream) + ASSURANCE | T18–T21 | GATE-F |

Tổng: **24 task**. Phase A, B là nền tảng rủi ro cao nhất (refactor + data). Phase C phụ thuộc A/B (controller + config store). Phase D phụ thuộc C (API). Phase E phụ thuộc C/A (server + session). Phase F chạy cuối + xác minh G1–G8.
**[Vá bởi Workflow Architect]** Phase C được mở rộng 3 task: T22 (API start/stop — FR-2 chưa có ai sở hữu), T23 (single-instance guard chống 2 loop đăng bài song song), T24 (quyết định tuyến OAuth + registry redirect_uri — phải xong TRƯỚC T10/T16, P0 cho Phase E).

---

## 3. Task list

> Qui ước chấm điểm: **S** ≈ ≤0.5 ngày · **M** ≈ 1–1.5 ngày · **L** ≈ 2–3 ngày.
> AC = acceptance criteria đo được (PASS/FAIL).

### PHASE A — Core refactor

#### T1 — Refactor `modeRun` thành `BotController` (start/stop/status)
- **Owner**: Backend Architect · **Dep**: — · **T-shirt**: **L**
- **Mô tả**: Tách vòng lặp poster.ts:302-411 thành module `bot.controller.ts` (singleton) với `start()/stop()/getStatus()`. State machine: `STOPPED → STARTING → RUNNING → STOPPING → STOPPED | ERROR`. `start()` thực hiện đúng bootstrap token + pre-flight permission; khi fail trong đường GUI → về `ERROR` kèm message (không `process.exit`), khi fail đường CLI/PM2 → vẫn `process.exit(1)` (giữ nguyên hành vi). `stop()` giữ semantics "chờ hết chu kỳ hiện tại" như SIGTERM cũ. **Giữ nguyên VERBATIM**: 401 → refresh + retry 1 lần; profanity → re-rewrite tránh từ flagged, retry ≤2; scrape fail → teaser; ảnh fail → text-only; `saveSession` mỗi chu kỳ; check `stopping` giữa batch. `poster.ts` `modeRun` thành wrapper mỏng.
- **Files**: thêm `bot.controller.ts`; `poster.ts` (modeRun wrapper + signal handlers gọi `controller.stop()`).
- **AC đo được**:
  1. Chạy `npm start -- --dry-run` CÙNG fixture feed trước và sau refactor → diff danh sách dòng log = rỗng (trừ dòng process-level).
  2. Test node: state transitions RUNNING→STOPPING→STOPPED đúng; STARTING khi đang chạy bị chặn.
  3. Test: SIGTERM giữa chu kỳ → chu kỳ kết thúc đủ rồi mới dừng (đo bằng timestamp log).
  4. Test mock: retry profanity ≤2, refresh-on-401 đúng 1 lần, fallback teaser khi scrape fail.
  5. Đường GUI fail không crash process (về ERROR); đường CLI vẫn exit≠0.
  6. **[Vá bởi Workflow Architect]** Chốt hành vi Stop khi bot đang NGỦ giữa 2 chu kỳ (interval mặc định 15 phút — `poster.ts:406 sleep(cfg.intervalMs)` không bị ngắt bởi cờ `stopping`): hoặc (a) sleep ngắt được → Stop → STOPPED ≤5s (đạt AC-2 PRD), hoặc (b) Stop khi đang sleep → dừng NGAY, Stop khi đang giữa batch → chờ hết batch. **Phương án nào cũng được, nhưng không được để Stop kẹt tới hết interval** (phá AC-2). Test cả 2 nhánh với interval rút nhỏ (VD 5s) để test nhanh.
- **Rủi ro lớn nhất của cả dự án → bắt buộc review Code Reviewer (G6) riêng cho diff này.**

#### T2 — Mở rộng `posted.json` entry + ghi lịch sử từ vòng lặp
- **Owner**: Backend Architect · **Dep**: T1, T3 · **T-shirt**: **M**
- **Mô tả**: Mở rộng `PostedEntry` thành `{key, title, link, postId?, status: 'posted'|'skipped'|'failed', reason?, ts}`. `hashKey` **không đổi** (backward-compat dedup). Controller ghi entry cho TỪNG bài đã xử lý: posted (kèm postId), skipped (đã đăng trước), failed (reason). Giữ cap 1000 entry. Thêm helper `listHistory(file, {limit, status})` sắp xếp `ts` giảm dần. Vẫn ghi posted.json cho cả SKIP và FAIL (chống spam post lại — hành vi hiện có). **[Vá bởi Workflow Architect]** Dùng cơ chế **write atomic từ T3** cho `markPosted` ngay tại đây (ép cứng đúng NFR "ghi .env/posted.json atomic") — nếu để tới T18 mới refactor thì giữa chừng là 2 writer (loop + one-shot) chạy `writeFileSync` trực tiếp trên cùng 1 file (xem R15).
- **Files**: `dedup.ts`.
- **AC đo được**:
  1. Đọc fixture `posted.json` cũ chỉ có `{key, ts}` → không throw, dedup vẫn chặn trùng, entry cũ render `—` cho field thiếu.
  2. Kết quả postOne → entry ghi đủ title/link/ts + status + reason/postId đúng.
  3. `listHistory` sort giảm dần theo ts, filter status, limit ≤ 100, cap cứng 1000.
  4. `hashKey('abc')` giống hệt giá trị phiên bản cũ (khóa cũ vẫn match).
  5. **[Vá bởi Workflow Architect]** FAIL ghi entry → **cycle kế tiếp KHÔNG thử lại link đó** (isPosted chặn). Đây là **đổi hành vi** so với code hiện tại (`poster.ts:401` chỉ `markPosted` khi OK → link FAIL bị thử lại mỗi cycle). Cần PM chốt: (a) chấp nhận không retry → ghi quyết định vào ASSURANCE; hoặc (b) giữ retry → FAIL chỉ markPosted sau M lần thử theo policy. Test quyết định này (R14).

### PHASE B — Config store + atomic write + in-cycle reload

#### T3 — Config store: đọc/ghi/mask `.env` atomic (Windows-safe)
- **Owner**: Backend Architect · **Dep**: — · **T-shirt**: **M**
- **Mô tả**: Module `config-store.ts`: (a) đọc `.env` → snapshot typed đủ `Config` + `GUI_*`; (b) serialize **chỉ field allowlist**, **giữ nguyên dòng lạ/comment**; (c) secret (`GOOGLE_CLIENT_SECRET_WEB`, `LLM_API_KEY`) chỉ xuất `{set: true/false}` qua API; nạp lại bằng field `*_SET` riêng; (d) **atomic write**: temp file cùng thư mục → flush → `rename` đè file đích; Windows EPERM/EBUSY → retry ≤3 có backoff; fail thì để nguyên file gốc (không file rỗng/không file nửa chừng).
- **Files**: thêm `config-store.ts`; `.env.example` (+`GUI_HOST`, `GUI_PORT`, `GUI_TOKEN`); **[Vá bởi Workflow Architect]** helper write atomic được tiêu thụ sớm tại T2 (`markPosted`) và T18 (`saveSession`) — không để `writeFileSync` trực tiếp tồn đọng trên đường ghi dữ liệu.
- **AC đo được**:
  1. Unit: round-trip parse→write→parse giữ nguyên dòng không thuộc allowlist + comment.
  2. `toPublic()` không bao giờ chứa giá trị secret.
  3. Stress 50 lần ghi liên tiếp trên Windows → file luôn hợp lệ, không có artifact `.tmp` tồn dư.
  4. Ghi đè secret: đặt `GOOGLE_CLIENT_SECRET_WEB_SET=xyz` → file chứa giá trị mới; xóa (chuỗi rỗng) → dòng biến bị loại khỏi file.

#### T4 — Áp dụng config từ chu kỳ kế tiếp (in-cycle reload)
- **Owner**: Backend Architect · **Dep**: T1, T3 · **T-shirt**: **S**
- **Mô tả**: Controller đọc lại config từ config-store mỗi chu kỳ qua **helper reload env allowlist** (đồng bộ `process.env` từ `.env` cho danh sách key cho phép — KHÔNG dùng `loadDotEnv` cũ vì nó chỉ điền biến chưa có). Feed, interval, limit, community, layout, dry-run, LLM config hiệu lực **từ chu kỳ kế tiếp**, không restart. Giá trị đang hiệu lực hiển thị trên GUI.
- **Files**: `bot.controller.ts` (đầu vòng lặp), `config-store.ts`.
- **AC đo được**:
  1. Bot đang chạy + sửa `RSS_FEED_URL` qua config-store → chu kỳ kế tiếp log fetch feed MỚI, không fetch feed cũ.
  2. Sửa `POST_INTERVAL_MS` → sleep kế tiếp theo giá trị mới.
  3. Secret không bị reload qua allowlist (nằm ngoài danh sách sync).

### PHASE C — HTTP server + API endpoints

#### T5 — Server HTTP nhúng + route + static + script `web`
- **Owner**: Backend Architect · **Dep**: T1, T3 · **T-shirt**: **M**
- **Mô tả**: Server `node:http` bind `GUI_HOST:GUI_PORT` (mặc định `127.0.0.1:8899`). Router tay ~12 endpoint, helper đọc JSON body/trả JSON, serve static `public/` (`index.html`, `app.js`, `style.css`). Thêm mode `web` vào `poster.ts` + script `package.json` `"web"`: process mở, server luôn chạy, **bot ở STOPPED** chờ nút Start trên GUI. **Từ chối khởi động (exit≠0, thông báo rõ) khi `GUI_HOST=0.0.0.0` mà thiếu `GUI_TOKEN`** (trước khi `listen`). PM2/`ecosystem.config.cjs` KHÔNG đổi (keep `--mode=run` auto-start).
- **Files**: thêm `server.ts` (gui-server), `public/` (placeholder); `poster.ts` (mode web); `package.json` (`web` script); `.env.example`.
- **AC đo được**:
  1. `npm run web` → `http://127.0.0.1:8899/` trả index.html (HTTP 200).
  2. Route lạ → 404 JSON có cấu trúc.
  3. `GUI_HOST=0.0.0.0` không token → process thoát ≠0 với message rõ; có token → listen thành công.
  4. Port bận → báo lỗi thân thiện, không stacktrace thô.
  5. **[Vá bởi Workflow Architect]** Khi `mode=web` mở, tự mở browser tới `http://<GUI_HOST>:<GUI_PORT>` (tái dùng `openBrowser` poster.ts:126) — khớp FLOW-1 PRD "chạy npm run web → bot tự mở GUI"; nếu mở thất bại → log đường dẫn tay.

#### T6 — Logger ring-buffer + `GET /api/logs?since=<seq>`
- **Owner**: Backend Architect (review: Realtime Collaboration Engineer) · **Dep**: T5 · **T-shirt**: **S**
- **Mô tả**: `log.ts` capture `console.log/error/warn` → ring buffer tối đa 1000 dòng có `seq` tăng dần; **vẫn ghi stdout** (PM2 log nguyên vẹn). Endpoint trả dòng `seq > since` + `lastSeq`. GUI poll 2s.
- **AC đo được**:
  1. Mọi console line có mặt trong buffer VÀ stdout.
  2. Buffer không vượt 1000.
  3. `since=lastSeq` liên tiếp giữa 2 lần poll → không sót, không trùng, `lastSeq` tăng đơn điệu. Không `since` → trả 1000 dòng gần nhất.
  4. Poll 1000 dòng < 50ms.

#### T7 — `GET /api/status` + `GET /api/history`
- **Owner**: Backend Architect · **Dep**: T2, T5 · **T-shirt**: **S**
- **Mô tả**: status: state, `lastCycleAt`, `lastPostResult {ok,title,postId|reason}`, `cycleCount`, `postedToday`, config snapshot (qua `toPublic()`), auth status; history: dùng `listHistory` (T2).
- **AC đo được**:
  1. Status phản ánh đúng state controller trong ≤1s sau sự thay đổi.
  2. History trả entry mới + entry cũ (legacy, field `—`).
  3. Filter status + limit hoạt động; KHÔNG secret trong 2 response.

#### T8 — `GET/POST /api/config` + `GET /api/rss-preview` + `GET /api/communities`
- **Owner**: Backend Architect · **Dep**: T3, T4, T5 · **T-shirt**: **M**
- **Mô tả**: GET → snapshot masked; POST → chỉ field allowlist (secret qua `*_SET`), ghi atomic, trả "áp dụng từ chu kỳ kế tiếp". `rss-preview` tái dùng `fetchRssItems` + `buildContent` (rss.ts). `communities` tái dùng `listMyCommunities` + `getMyMemberPermission` + `getCommunityDetail` + `hasPostPermission` (community.client.ts).
- **AC đo được**:
  1. POST config → file `.env` đổi + chu kỳ kế tiếp re-load (kiểm chứng như T4).
  2. GET tuyệt đối không chứa `GOOGLE_CLIENT_SECRET_WEB` / `LLM_API_KEY` dạng giá trị (mọi response — kiến nghị kiểm bằng regex test).
  3. `rss-preview?url=<feed hợp lệ>` → ≥1 item + preview text (AC-6 PRD).
  4. Communities trả `{id, name?, role, canPost}`.

#### T9 — `POST /api/post` one-shot (test/rss) + guard 409
- **Owner**: Backend Architect · **Dep**: T1, T2, T5 · **T-shirt**: **M**
- **Mô tả**: Tái dùng toàn bộ logic `modeOneShot` (test/rss, `content`/`rssUrl`/`limit`/`dryRun`). **[Vá bởi Workflow Architect]** Guard 409 khi **STARTING / RUNNING / STOPPING** — KHÔNG chỉ RUNNING: khi STOPPING vòng lặp vẫn đang giữa chu kỳ và ghi `posted.json`; để one-shot chạy cùng lúc = 2 writer đè nhau trên cùng file (lost update/corruption, R15). Kết quả `{ok, postId?, reason?}` và tự ghi vào history (T2). `dryRun=true` → trả preview, không gọi gateway.
- **AC đo được**:
  1. dry-run trả content preview, KHÔNG phát sinh call post (đếm mock call = 0).
  2. Bot STARTING/RUNNING/STOPPING → HTTP 409 (không chỉ RUNNING).
  3. Post ok → history thêm entry status=posted kèm postId.
  4. Post fail → history status=failed kèm reason.

#### T10 — Remote access: enforce `GUI_HOST` / `GUI_TOKEN` (task RIÊNG theo quyết định khách)
- **Owner**: Backend Architect · **Dep**: T5, T3, T24 · **T-shirt**: **S**
- **Mô tả**: Middleware Bearer cho mọi `/api/*` và static: yêu cầu khi `GUI_TOKEN` đặt (local) hoặc mọi trường hợp bind remote `0.0.0.0` (bắt buộc). Thiếu/sai token → 401 JSON. Token KHÔNG log, KHÔNG trả trong response; GUI chỉ biết "đã/chưa đặt" (thêm field `guiTokenSet` trong status). Startup-check `0.0.0.0` thiếu token đã có ở T5, T10 bổ sung enforcement phía mọi request.
- **[Vá bởi Workflow Architect]** Danh sách tuyến **loại trừ Bearer** do T24 chốt — tối thiểu gồm `GET /callback`: top-level redirect từ Google KHÔNG gắn được `Authorization: Bearer`, nếu gate tuyến này thì OAuth setup từ GUI vỡ (R13). Trang `/callback` phải là HTML tĩnh chỉ báo OK/FAIL, tuyệt đối không chứa token/secret.
- **AC đo được**:
  1. `GUI_TOKEN=abc` → request không header = 401; `Authorization: Bearer abc` = 200; sai token = 401.
  2. Static file cũng bị gate khi có token (trang GUI không tải nếu không nhập token).
  3. Giá trị token vắng mặt trong MỌI response body + log (regex test).
  4. `0.0.0.0` + token: truy cập từ IP khác được gate đúng.
  5. **[Vá bởi Workflow Architect]** `GET /callback` khi có `GUI_TOKEN` vẫn nhận được (exemption theo danh sách T24) và response callback không chứa token/secret (regex test trong T19).
  6. **[Vá bởi Workflow Architect]** Khi `GUI_TOKEN` có giá trị: cần **1 trang nhập token tối thiểu được serve KHÔNG bị gate** (anonymous, chỉ gồm ô token, 0 secret/0 dữ liệu) — nếu gate cả static (AC2) thì máy khách không có chỗ nào nạp token để vào được trang (deadlock), phá use-case remote §10.4. Sau khi có token đúng → serve app đầy đủ; mọi request sau vẫn gate Bearer.
- **Lưu ý**: đây là task khác biệt hẳn FR-8 cũ (vốn mặc định tắt, chỉ local) — theo đúng quyết định khách §10.4.

#### T22 — API Start/Stop endpoints (`POST /api/start`, `POST /api/stop`) **[Vá bởi Workflow Architect — task MỚI]**
- **Owner**: Backend Architect · **Dep**: T1, T5 · **T-shirt**: **S**
- **Mô tả**: 2 endpoint điều khiển vòng lặp từ GUI (FR-2). Bản PLAN gốc thiếu hẳn owner cho chức năng này — T1 chỉ xây `BotController`, T12 (Dashboard) bấm Start/Stop nhưng không có endpoint nào được mô tả. `POST /api/start`: gọi `controller.start()` (bootstrap token + pre-flight permission theo T1); trả `{state:'STARTING'}`; fail đường GUI → về `ERROR` kèm message, KHÔNG `process.exit`. `POST /api/stop`: gọi `controller.stop()` (semantics "chờ hết chu kỳ" theo quyết định Stop-trong-sleep T1.AC.6); trả `{state:'STOPPING'}`. **Guard 409**: `start` khi đang `STARTING/RUNNING/STOPPING`; `stop` khi không RUNNING → 400/409. Code lỗi thống nhất với T9 (`{ok:false, code, retryable}`).
- **Files**: `server.ts` (2 route), `bot.controller.ts` (start/stop từ T1).
- **AC đo được**: (1) Start → `RUNNING` ≤3s; (2) Stop khi đang ngủ → `STOPPED` ≤5s (theo T1.AC.6); (3) start 2 lần → 409; (4) stop khi `STOPPED` → 400; (5) fail pre-flight → `ERROR` + message rõ, process vẫn sống.

#### T23 — Single-instance guard cho loop (chống 2 process đăng bài song song) **[Vá bởi Workflow Architect — task MỚI]**
- **Owner**: Backend Architect · **Dep**: T1, T5 · **T-shirt**: **S**
- **Mô tả**: Khách có thể chạy `npm run web` (GUI, bot STOPPED) trong khi PM2 (`ecosystem.config.cjs` args `--mode=run`) hoặc `npm start` ở terminal khác vẫn đang chạy loop → **2 process cùng gọi createPost → đăng bài trùng, cùng ghi `posted.json`**. Thêm guard "ai sở hữu loop": lockfile cùng thư mục (VD `loop.lock` ghi PID), giành khi `start()`, trả khi `stop()`/thoát, xử lý lock stale khi process chết đột ngột (so PID còn sống không). `mode=web` tại startup: nếu lock bị giữ → cảnh báo "đã có vòng lặp khác đang chạy" trên GUI + khóa nút Start (T22 trả 409 kèm message). Status expose `lockHeldBy` để GUI hiển thị. KHÔNG sửa PM2 config (giữ nguyên `--mode=run`).
- **Files**: `bot.controller.ts` (acquire/release lock), `server.ts` (status + warn startup), `poster.ts` (mode web).
- **AC đo được**: (1) PM2 `--mode=run` đang chạy + `npm run web` → GUI báo lock bận, Start bị khóa/409; (2) tắt PM2 → Start chạy được; (3) loop process bị kill -9 → lock stale được nhận lại (không khóa vĩnh viễn); (4) `npm run web` mở 2 lần → instance 2 báo port/lock bận rõ ràng.

#### T24 — Quyết định tuyến OAuth redirect + registry `redirect_uri` (contract cho T10/T16) **[Vá bởi Workflow Architect — task MỚI, P0]**
- **Owner**: Backend Architect + stakeholder (khách) · **Dep**: T5 · **T-shirt**: **S**
- **Mô tả**: Quyết định P0 phải xong TRƯỚC khi T10 (danh sách tuyến exempt Bearer) và T16 (tuyến nhận redirect) implement — tránh build kiến trúc trên giả định chưa verify. 3 việc:
  1. **Chốt tuyến**: embedded `/callback` trên `GUI_PORT` (FR-7) HAY tái dùng `waitForRedirectCode` port 8787 cũ. Ràng buộc từ code: `google-oauth.ts:79` `server.listen(port)` bind **mọi interface** → nếu `GUI_PORT` trùng OAuth port sẽ conflict bind; nếu giữ 8787, browser nhận HTML "close tab" cũ, GUI tự detect qua poll `auth-status`.
  2. **Google Cloud Console — bước ngoài-code bắt buộc verify**: `.env.example` đang yêu cầu đăng ký `http://localhost:8787/callback`. Nếu đổi sang embedded redirect, khách phải thêm `http://localhost:<GUI_PORT>/callback` (và host thật nếu remote) vào Authorized redirect URIs. Task produce **danh sách redirect_uri cần có + hướng dẫn khách**, verify bằng 1 luồng consent thật trong GATE-E.
  3. **Ràng buộc remote (quyết định khách §10.4)**: khi `GUI_HOST=0.0.0.0`, browser máy KHÁCH redirect về `localhost` = CHÍNH nó, không phải máy host → **OAuth setup từ máy khác bất khả thi trừ phi redirect_uri dùng hostname/domain reachable được đăng ký Console**. Chốt chính sách: setup OAuth phải thực hiện trên máy host (ghi rõ trên UI), remote-only setup nằm ngoài v1 (R10).
- **Files**: không code — decision + doc ghi vào `docs/ASSURANCE-news-poster-gui.md` (quyết định + danh sách redirect_uri + policy remote).
- **AC đo được**: (1) tài liệu quyết định tuyến kèm lý do + ràng buộc code (bind all-interface, redirect_uri Console); (2) khách xác nhận/bắt tay danh sách redirect_uri phải đăng ký; (3) danh sách tuyến exempt Bearer cho T10 hoàn chỉnh; (4) policy remote-consent được chốt + minh bạch trên GUI (không hứa tính năng không chạy được).

### PHASE D — GUI frontend tĩnh 4 tab

#### T11 — Shell trang tĩnh + 4 tab + fetch helper
- **Owner**: Frontend Developer · **Dep**: T5, T10 · **T-shirt**: **M**
- **Mô tả**: `index.html` + `style.css` + `app.js`: 4 tab (Dashboard, Nhật ký, Lịch sử, Cấu hình), header trạng thái, **UI tiếng Việt**, fetch helper gắn `Authorization: Bearer` (nhập token 1 lần, giữ trong memory), orchestrator poll 2s, offline (không CDN).
- **AC đo được**:
  1. Load từ `npm run web` không console error; 4 tab chuyển không reload.
  2. Token nhập vào → chỉ lưu memory; đúng/sai gọi API đúng/401.
  3. Không phụ thuộc mạng ngoài (kể cả font không dùng CDN).
  4. **[Vá bởi Workflow Architect]** Khi `GUI_TOKEN` đặt: lần load đầu (chưa có token) → thấy trang nhập token tối thiểu (anonymous, T10.AC.6); nhập sai → 401 + ở lại trang nhập; nhập đúng → vào 4-tab, token giữ trong memory tới khi reload.

#### T12 — Tab Dashboard (Start/Stop/status/last cycle/auth)
- **Owner**: Frontend Developer · **Dep**: T7, T11, T22 · **T-shirt**: **S**
- **AC đo được**: Start → RUNNING ≤3s; Stop → STOPPED ≤5s; nút vô hiệu khi đang chuyển trạng thái (không double-click — AC-2 PRD); hiển thị `lastPostResult` + badge auth-status.

#### T13 — Tab Nhật ký (auto-scroll + filter)
- **Owner**: Frontend Developer · **Dep**: T6, T11 · **T-shirt**: **S**
- **AC đo được**: dòng mới hiện ≤3s kể từ sự kiện (AC-3 PRD); filter mọi/fail/skip; backlog 1000 dòng cuộn mượt không giật.

#### T14 — Tab Lịch sử (bảng + link + one-shot + dry-run)
- **Owner**: Frontend Developer · **Dep**: T7, T9, T11 · **T-shirt**: **S**
- **AC đo được**: đủ title/link/ts/postId/status (entry cũ `—`); click link mở bài gốc tab mới; "Đăng thử 1 bài" + toggle dry-run → preview modal trước khi đăng; sau post bảng tự refresh (AC-4 PRD).

#### T15 — Tab Cấu hình (form + mask + save + feed test + community)
- **Owner**: Frontend Developer · **Dep**: T8, T11 · **T-shirt**: **M**
- **AC đo được**: `RSS_FEED_URL`, `RSS_LIMIT_PER_CYCLE`, `POST_INTERVAL_MS`, `COMMUNITY_ID`, `LAYOUT_TYPE`, `DRY_RUN`, LLM (base/model, key masked) hiện đúng từ `/api/config`; secret chỉ hiện `••••` + field đặt lại; Lưu → POST → ghi `.env` → UI thông báo "áp dụng từ chu kỳ kế tiếp"; "Kiểm tra feed" hiện ≥1 preview (AC-6); danh sách community kèm role/canPost (AC-? FR-5.4).

### PHASE E — OAuth setup từ GUI

#### T16 — OAuth API: `POST /api/setup/start`, `GET /callback`, `GET /api/auth-status`
- **Owner**: Backend Architect · **Dep**: T1, T3, T5, T10, T24 · **T-shirt**: **M**
- **Mô tả**: start → `newState` + `getGoogleAuthUrl` → trả url+state; nhận redirect theo tuyến **T24 chốt** (mặc định FR-7: server nhúng nhận `/callback`, tuyến đã được loại trừ Bearer theo T24/T10; phương án dự phòng: tái dùng `waitForRedirectCode` port 8787 cũ — cả 2 đều dùng code sẵn có) → `exchangeCodeForTokens` → `loginWithGoogle` → `saveSession`. Bắt lỗi `require2fa` / `register` (auth.client.ts) trả thành JSON người dùng đọc được. `auth-status` → `{hasSession, accessExpiresAt, hasGoogleRefresh, communityPermission}` qua session.ts + community.client.ts. **[Vá bởi Workflow Architect]** Consent URL phải dùng `redirect_uri` đúng danh sách Authorized redirect URIs trên Google Console (danh sách này do T24 xác lập); khi `GUI_HOST=0.0.0.0`, ghi rõ giới hạn R10 (browser máy khác redirect về `localhost` của chính nó — setup phải làm trên máy host).
- **AC đo được**: (1) start trả consent URL; (2) hoàn tất consent → `auth-status.hasSession=true`; (3) 2FA/register → HTTP 400/409 kèm message rõ (không RAW lỗi gốc); (4) không lộ secret. Tương đương AC-7 PRD (2FA/register fail → thông báo rõ ràng).

#### T17 — GUI flow OAuth (nút "Kết nối Google" + callback + lỗi thân thiện)
- **Owner**: Frontend Developer · **Dep**: T16, T12 · **T-shirt**: **S**
- **AC đo được**: bấm nút → mở consent; xong → badge update ≤3s; fail 2FA/register → render card lỗi tiếng Việt; "Đã kết nối" + thời hạn access token (AC-7 PRD).

### PHASE F — Regression + test

> **Chọn runner tối thiểu, 0 dep mới**: Node built-in `node:test` + `ts-node/register`. Scripts mới đặt `test:unit`, `test:api`, `test:stream`; **KHÔNG đụng `npm test`** (one-shot post hiện có). Node engines ≥18 (node:test có từ 18).

#### T18 — Unit tests
- **Owner**: Test Automation Engineer · **Dep**: T2, T3 (chủ lực), T1 · **T-shirt**: **M**
- **Nội dung**: `tests/unit/*.test.ts` — fixture `posted.json` cũ (backward-compat + migration); config-store parse/serialize/mask/atomic; state machine controller với `fetch` giả lập (profanity ≤2, 401-once, teaser fallback, stopping-giữa-batch); `history` sort/filter/cap. Script `test:unit` + `typecheck` (`tsc --noEmit` — hiện chưa có).
- **AC**: xanh, 0 skip; coverage (node `--experimental-test-coverage`) ≥80% trên module mới (config-store, dedup, bot.controller, route mask); không clobber `npm test`.

#### T19 — API / e2e tests (spawn `mode=web`, mock gateway/RSS/LLM)
- **Owner**: API Tester · **Dep**: T5–T10, T22, T24, T16, (có thể bắt đầu khi C+E stable) · **T-shirt**: **L**
- **Nội dung**: lifecycle status + start/stop (T22); logs seq; history; config round-trip + next-cycle reload; rss-preview; communities (stub); post one-shot (dry-run, ok, fail, 409 khi STARTING/RUNNING/STOPPING); OAuth mock flow (theo tuyến T24, kể cả `/callback` exempt Bearer); Bearer (`GUI_TOKEN`) + trang nhập token anonymous; block `0.0.0.0`; **no-secret regression test trên MỌI response**.
- **AC**: toàn bộ PASS; script `test:api` chạy được CI; no-secret test chứng minh red→green.

#### T20 — Streaming/log contract + robustness
- **Owner**: Realtime Collaboration Engineer · **Dep**: T6, T19 · **T-shirt**: **S**
- **Nội dung**: seq liên tục không gap/không trùng khi bắn nhiều log giữa 2 lần poll (burst); ring-buffer cap ổn định; client reconnect (since reset) hành vi rõ ràng; poll 2s + backlog 1000 dòng.
- **AC**: không gap/trùng seq qua N poll liên tiếp dưới burst; cap buffer ổn định; PASS dưới poll 2s.

#### T21 — Regression runlist (CLI/PM2/--dry-run/one-shot) + ASSURANCE sign-off
- **Owner**: Test Automation Engineer (gate chấm bởi Code Reviewer + Reality Checker độc lập) · **Dep**: T18, T19, T20 · **T-shirt**: **M**
- **Nội dung runlist**: `npm start` (loop, `--dry-run`), `npm run rss -- --dry-run`, `npm test` (one-shot — **chứng minh không đổi**), `npm run communities`, `npm run web`, PM2 `ecosystem.config.cjs` start/stop/restart + log check, SIGTERM behavior. Điền `docs/ASSURANCE-news-poster-gui.md`: G1–G8 evidence; G9 = N/A; G10 = một phần. Secret-scan repo (không commit `.env`/`.session.json`). **[Vá bởi Workflow Architect]** Bổ sung: (a) viết **threat-model "1-host" cho G10** ngay trong ASSURANCE (tài sản: `GOOGLE_CLIENT_SECRET_WEB`, `LLM_API_KEY`, `.session.json` platform token, `GUI_TOKEN`; giả định localhost; giới hạn của remote `0.0.0.0`) — hiện G10 yêu cầu nhưng không task nào sở hữu; (b) runlist đổi `POST_INTERVAL_MS` xuống nhỏ (VD 5s) để test "config đổi → cycle kế tiếp dùng giá trị mới" + Stop-trong-sleep nhanh (T1.AC.6); (c) test dual-instance: `npm run web` khi đang có loop khác (PM2/`npm start`) → cảnh báo/khóa Start (T23); (d) test one-shot lúc loop đang `STOPPING` → 409 + không lỗi entry `posted.json` (T9/T2/R15).
- **AC**: runlist PASS (exit code + output kỳ vọng); bảng G1–G8 tất cả PASS có bằng chứng; scan 0 secret (AC-9, AC-10 PRD + G5).

---

## 4. Thứ tự chạy & sequencing rationale

**Wave 0 (nhóm backbone, chạy SONG SONG được)**:
- **T1** (Phase A) ∥ **T3** (Phase B) — không chạm cùng file (`bot.controller.ts` mới vs `config-store.ts` mới). Lý do: 2 nền tảng rủi ro nhất triển khai sớm để Phase 2 Design council + Code Reviewer tập trung review sớm, giảm phát hiện trễ.

**Wave 1**:
- **T2** (cần T1 — ghi lịch sử nằm trong loop) ∥ **T4** (cần T1 + T3 — reload env vào controller).

**Wave 2 (Phase C) — T5 đầu tiên (blocking), rồi T6→T7→T8→T9 đi tuần tự** vì chạm chung `server.ts` (router một file) → tránh conflict song song. **T24 (quyết định OAuth route) chạy sớm song song** — nó là đầu vào contract cho T10 (danh sách tuyến exempt Bearer) và T16 (tuyến nhận redirect). **T10 chạy song song được** (middleware riêng, không đụng router của T6–T9) NHƯNG phụ thuộc kết quả T24. **T22** (start/stop API) và **T23** (single-instance lock) cũng đụng `server.ts` → xếp sau T9 tuần tự.
**[Vá bởi Workflow Architect]** Đây là cửa "review chéo sớm": ghép T3 (atomic/mask) + T10 (Bearer) + T24 (route/auth contract) thành 1 phiên review Code Reviewer + Security Engineer TRƯỚC khi Phase D build GUI — nếu phát hiện trễ (VD callback bị Bearer chặn), Phase D làm lại tốn nhất. Phù hợp GATE-C.

**Wave 3 (Phase D) — T11 làm trước (shell)**; T12–T15 từng tab độc lập (mỗi tab 1 file JS) → có thể chạy song song hoặc tuần tự theo thứ tự bất kỳ sau khi shell xong. **[Vá bởi Workflow Architect]** T12 (Dashboard, nút Start/Stop) cần **T22** (API start/stop); T15 (Config) cần field `*_SET`/mask của T8/T3.

**Wave 4 (Phase E)**: T16 (backend) → T17 (frontend); có thể chồng lên các tab D còn dở. **[Vá bởi Workflow Architect]** T16 chỉ bắt đầu khi **T24 đã chốt** (+ T10 hoàn tất) — đừng build trên giả định redirect_uri chưa verify với Google Console.

**Wave 5 (Phase F)**: **T18 có thể bắt đầu sớm** (ngay khi T1–T3 stable, chạy sóng song với C/D); T19 cần C+E stable + **T22** (start/stop API); T20 sau T6+T19; T21 cuối cùng (cần mọi thứ + T20 + là cửa ASSURANCE).

**Tóm tắt đường tới hạn**: T1 → T4 → T5 → T6…T9 → T11 → (T12–T15, T12 cần T22) → T16 → T17 → T19 → T20 → T21. Mọi thứ ngoài chuỗi đó có thể đẩy sớm lên.
**[Vá bởi Workflow Architect]** Ràng buộc vành đai: **T24 phải xong trước T10 và T16** — để trễ sẽ kẹt critical path Phase E; T22/T23 song song không trên đường tới hạn. Quyết định OAuth sớm cũng đưa "review chéo" (Code Reviewer + Security Engineer) lên trước GUI build.

---

## 5. Rủi ro thực thi + mitigation

| # | Rủi ro | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | **Refactor `modeRun` đổi hành vi** (profanity retry ≤2, refresh-on-401, fallback teaser, saveSession, stopping-giữa-batch) | Trung bình | **Cao** | Giữ nguyên body vòng lặp khi bọc controller ("thick wrapper", không viết lại); fixture log trước/sau `--dry-run` diff rỗng (AC T1.1); unit-test riêng từng nhánh; review Code Reviewer bắt buộc cho diff T1 |
| R2 | **Legacy `posted.json` `{key, ts}`** làm hỏng dedup / hiển thị sai sau mở rộng schema | Cao | Trung bình | `hashKey` bất biến; reader bỏ qua field thiếu (render `—`); không rewrite file cũ khi chỉ đọc; fixture test entry cũ (T18); rollback: giữ code path cũ qua env-flag (G8) |
| R3 | **Atomic write trên Windows**: `rename` đè file đang mở/đang đọc → EPERM/EBUSY, file rỗng | Trung bình | Cao | Temp cùng thư mục → flush → rename có retry/backoff ≤3; không bao giờ mở+truncate file đích; readers giữ dữ liệu cũ tới khi rename; stress 50 lần (AC T3) |
| R4 | **`process.env` cũ mắc kẹt**: `loadDotEnv()` chỉ điền biến chưa có → config sửa trên `.env` không hiệu lực | Chắc chắn (nếu quên) | Cao | Phase B có reload helper allowlist riêng (T4); test "đổi feed giữa chu kỳ" bắt buộc trong GATE-B |
| R5 | **Lộ secret/token qua API/GUI** (G10 một phần + G5) | Thấp | Cao | GET config luôn mask (T8); token Bearer chỉ memory (T11); token không log/không response (T10); no-secret regex test mọi response (T19); secret-scan (T21); GUI_chỉ hiển thị "đã/chưa đặt" |
| R6 | **Đè `npm test`** (đang là one-shot post) khi thêm test runner | Trung bình | Trung bình | Script mới `test:unit/api/stream`; regression runlist xác nhận `npm test` vẫn post được (T21) |
| R7 | **Tuyến OAuth redirect**: FR-7 muốn embedded `/callback` trên 8899, giả định cũ giữ 8787 | Thấp | Trung bình | **[Vá bởi Workflow Architect]** T24 chốt quyết định SỚM (đầu Phase C, P0) kèm verify Google Console; 2 tuyến dùng chung `getGoogleAuthUrl`/`exchangeCodeForTokens`/`loginWithGoogle`; test phủ setup từ GUI (T19) |
| R8 | **One-shot đè chu kỳ tự động** (post trùng/rate-limit) | Thấp | Trung bình | Guard 409 khi RUNNING (T9); one-shot độc lập token/session |
| R9 | Process chết ⇒ GUI chết theo | Chắc chắn | Thấp | Đã chấp nhận trong PRD (§8 trade-off): PM2 autorestart có sẵn |
| R10 | **[Vá bởi Workflow Architect]** **OAuth setup từ máy khách khi GUI_HOST=0.0.0.0 vô hồi**: redirect `localhost` trong redirect_uri resolve về browser máy KHÁCH, không phải máy host | Chắc chắn nếu để vậy | Trung bình | T24 chốt policy: setup OAuth phải làm trên máy host + ghi chú UI minh bạch; redirect_uri phải nằm trong Authorized redirect URIs (Google Console) — verify bằng 1 consent flow thật trong GATE-E |
| R11 | **[Vá bởi Workflow Architect]** **2 process cùng chạy loop đăng bài trùng** (PM2 `--mode=run` / `npm start` + `npm run web`) → double post + 2 writer `posted.json` | Trung bình (khách bật cả 2) | **Cao** | T23 single-instance lock + UI cảnh báo/khóa Start; test dual-instance trong T21(c) |
| R12 | **[Vá bởi Workflow Architect]** **Stop ≠ AC-2 (≤5s)**: interval mặc định 15 phút, `sleep()` không ngắt được bởi cờ stopping → Stop kẹt tới hết interval | Chắc chắn nếu không chốt | Trung bình | T1.AC.6 chốt 1 trong 2 phương án (ngắt sleep / Stop-ngay-khi-sleep); test với interval rút nhỏ |
| R13 | **[Vá bởi Workflow Architect]** **`/callback` bị Bearer middleware gate** đè OAuth setup (top-level redirect không gắn được Authorization header) | Cao nếu không trừ | Cao | T24 chốt danh sách tuyến exempt (gồm `/callback`); T10 áp; T16 AC + T19 regex test |
| R14 | **[Vá bởi Workflow Architect]** **FAIL ghi entry → không retry lại link hỏng** (đổi hành vi hiện tại: poster.ts chỉ markPosted khi OK) mà không ai chốt | Chắc chắn nếu T2 implement theo FR-4 | Trung bình | T2.AC.5 + PM chốt (giữ retry → FAIL không markPosted; không retry → ghi vào ASSURANCE) |
| R15 | **[Vá bởi Workflow Architect]** **One-shot + loop cùng ghi `posted.json`** (khi STOPPING hoặc nếu guard chỉ chặn RUNNING) → lost entry / file hỏng giữa chừng | Trung bình | Cao | T9 guard STARTING/RUNNING/STOPPING + `markPosted` dùng write atomic (T2 nhận từ T3) |
| R16 | **[Vá bởi Workflow Architect]** **Quyết định tuyến OAuth trễ** kéo lỡ T10/T16/T17, kẹt critical path Phase E | Trung bình | Trung bình | T24 là quyết định P0 xếp ngay đầu Phase C, có AC đo được; nếu khách không trả lời kịp → fallback giữ 8787 (`waitForRedirectCode`), GUI thông báo "mở tab thủ công" |

---

## 6. Kế hoạch test (tóm tắt chiến lược)

- **Hiện trạng**: không có test runner, không CI. Đề xuất tối thiểu: **`node:test` + `ts-node/register`** (0 dep mới, đúng ethos). KHÔNG ép thêm framework cho v1 này.
- **Unit (T18, Test Automation Engineer)**: logic thuần không mạng — dedup/migration/history, config-store (parse/mask/atomic), state machine (fetch giả). Coverage ≥80% module mới.
- **API/e2e (T19, API Tester)**: spawn `mode=web`, mock toàn bộ outbound (gateway/RSS/LLM bằng env trỏ stub); phủ hết endpoints + no-secret assertions + Bearer/0.0.0.0 + guard 409. Đây là rào chặn cho G5/G10.
- **Streaming contract (T20, Realtime Collaboration Engineer)**: seq tăng đơn điệu, không gap/trùng khi có burst, cap ring-buffer, hành vi reconnect.
- **Regression (T21, Test Automation Engineer)**: chạy trực tiếp các lệnh CLI thật (`npm start`, `--dry-run`, `--mode=test|rss`, `communities`, PM2, SIGTERM) — chứng minh GUI là lớp "thêm vào", không đổi hành vi cũ (AC-9).
- **Optional (đã đề xuất, không bắt buộc v1)**: Playwright screenshot 4 tab nếu khách muốn ảnh nhất; không nằm trong ASSURANCE.

---

## 7. GATE criteria nội bộ (điều kiện vào phase sau)

- **GATE-A** (A→B): T1 AC(1..6) + T2 AC(1..5) PASS; diff `npm start -- --dry-run` trước/sau rỗng; Code Reviewer đã duyệt diff refactor (G6 sớm).
- **GATE-B** (B→C): T3 AC(1..4) + T4 AC(1..3) PASS; stress atomic write chạy ổn trên Windows (bằng chứng file list không `.tmp` tồn dư).
- **GATE-C** (C→D): T5–T10 + T22–T24 AC PASS; API tester xác nhận no-secret + Bearer + block `0.0.0.0`; `npm run web` serve đúng; **T24 chốt xong tuyến OAuth + danh sách redirect_uri cần đăng ký (điều kiện mở Phase E)**; start/stop endpoint + single-instance guard hoạt động (T22/T23).
- **GATE-D** (D→E): T11–T15 AC PASS; AC-1, AC-2, AC-3 PRD đạt trên GUI thật.
- **GATE-E** (E→F): T16–T17 AC PASS; AC-7 PRD đạt (setup Google từ GUI, 2FA/register fail hiển thị rõ); policy remote-consent của T24 được áp dụng (setup chạy trên máy host) + verify consent flow thật KHI `GUI_PORT` dùng redirect_uri mới.
- **GATE-F** (ship): AC 1–10 PRD + HARD-GATE G1–G8 PASS (bảng ASSURANCE có bằng chứng), UAT khách dùng thử.

---

## 8. HARD-GATE ASSURANCE (G1–G8; G9/G10)

| Gate | Áp dụng | Cách thoả trong plan |
|---|---|---|
| G1 Tests | ✅ | T18+T19+T20 xanh, 0 skip, coverage ≥80% module mới. **Lưu ý calibration**: project hiện 0 test → ngưỡng coverage tính trên code GUI mới, xác nhận với Code Reviewer ở Phase 2 |
| G2 Mutation | ✅ (scope hẹp) | Đề xuất giới hạn vào `bot.controller` state machine + `config-store` atomic/mask (không trải toàn bộ legacy code); ngưỡng/scope xác nhận ở Design council |
| G3 Contract | ✅ | Không có hệ thống mới ở biên ngoài; contract giữ nguyên ở các client cũ. Contract test nội API do T19/T20; snapshot API trong docs |
| G4 Type/Lint/Build | ✅ | Thêm `typecheck` (`tsc --noEmit`), 0 warning mới |
| G5 SAST+secret-scan | ✅ | no-secret test mọi response (T19) + secret-scan repo (T21); không commit `.env`/`.session.json` |
| G6 Code Reviewer | ✅ | Review từng phase; bắt buộc ưu tiên: T1 (refactor), T10 (security), T3 (atomic/mask) |
| G7 Reality Checker | ✅ | Dùng bằng chứng runlist + screenshot + log để xác nhận "dùng được", không tự nhận |
| G8 Migration | ✅ | Backward-compat reader + rollback plan: env-flag trả về code path cũ nếu hỏng; approval schema change lưu trong PR |
| G9 Tiền | **N/A** | Không đụng payment |
| G10 Auth/PII | **Một phần — có khác biệt** | Không phải multi-user/authz; nhưng GUI **chứa token + secret** → vẫn phải thoả: mask mọi secret (FR-5), Bearer enforcement khi bật (FR-8), token không log/không trả, threat-model 1-host ghi trong ASSURANCE-<feature>.md, và T19 có nhóm test "chỉ chủ nhân có token mới đọc/ghi" |

---

## 9. Ước lượng t-shirt

| Size | Task | Days |
|---|---|---|
| L | T1, T19 | 2×2.5 = 5 |
| M | T2, T3, T5, T8, T9, T11, T15, T16, T18, T21 | 10×1.25 = 12.5 |
| S | T4, T6, T7, T10, T12, T13, T14, T17, T20, T22, T23, T24 | 12×0.5 = 6 |
| **Tổng** | **24 task** | **≈ 24 dev-days** nối tiếp |

Nối tiếp ~3 tuần (1 dev); theo Wave (§4) rút còn ~2.5–3 tuần. Khớp ước lượng PRD (M, 2–3 tuần).

---

## 10. Bảng tổng hợp nhanh

| ID | Task | Phase | Owner | Dep | Size |
|----|------|-------|-------|-----|------|
| T1 | Refactor `modeRun` → `BotController` | A | Backend Architect | — | L |
| T2 | Extend `posted.json` entry + history ghi từ loop | A | Backend Architect | T1,T3 | M |
| T3 | Config store đọc/ghi/mask `.env` atomic | B | Backend Architect | — | M |
| T4 | In-cycle reload config (chu kỳ kế tiếp) | B | Backend Architect | T1,T3 | S |
| T5 | HTTP server + route + static + script `web` | C | Backend Architect | T1,T3 | M |
| T6 | Logger ring-buffer + `GET /api/logs` | C | Backend Architect | T5 | S |
| T7 | `GET /api/status` + `GET /api/history` | C | Backend Architect | T2,T5 | S |
| T8 | Config/RSS-preview/Communities endpoints | C | Backend Architect | T3,T4,T5 | M |
| T9 | `POST /api/post` one-shot + guard 409 (STARTING/RUNNING/STOPPING) | C | Backend Architect | T1,T2,T5 | M |
| T10 | Remote access `GUI_HOST`/`GUI_TOKEN` enforce (+ `callback` exempt list) | C | Backend Architect | T5,T3,T24 | S |
| T11 | GUI shell + 4 tab + fetch helper | D | Frontend Developer | T5,T10 | M |
| T12 | Tab Dashboard | D | Frontend Developer | T7,T11,T22 | S |
| T13 | Tab Nhật ký | D | Frontend Developer | T6,T11 | S |
| T14 | Tab Lịch sử | D | Frontend Developer | T7,T9,T11 | S |
| T15 | Tab Cấu hình | D | Frontend Developer | T8,T11 | M |
| T16 | OAuth API (`setup/start`, `/callback`, `auth-status`) | E | Backend Architect | T1,T3,T5,T10,T24 | M |
| T17 | GUI OAuth flow | E | Frontend Developer | T16,T12 | S |
| T18 | Unit tests (node:test) | F | Test Automation Engineer | T1,T2,T3 | M |
| T19 | API/e2e tests | F | API Tester | T5–T10,T22,T24,T16 | L |
| T20 | Streaming/log contract test | F | Realtime Collaboration Engineer | T6,T19 | S |
| T21 | Regression runlist + ASSURANCE sign-off (+ threat-model G10) | F | Test Automation Engineer | T18,T19,T20 | M |
| T22 | API Start/Stop endpoints (`POST /api/start`, `POST /api/stop`) | C | Backend Architect | T1,T5 | S |
| T23 | Single-instance guard loop (chống 2 process đăng bài song song) | C | Backend Architect | T1,T5 | S |
| T24 | OAuth redirect route + registry `redirect_uri` decision | C | Backend Architect + khách | T5 | S |