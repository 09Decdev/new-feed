# Threat Model — Web GUI news-poster

**Trạng thái**: Draft v2 (security contract cho v1; vá theo phản biện chéo & quyết định hội đồng 2026-08-20) · **Ngày**: 2026-08-20 · **Tác giả**: Security Architect
**Đầu vào**: `docs/PRD-news-poster-gui.md` (FR-5/FR-7/FR-8, §10), `docs/PLAN-news-poster-gui.md` (T3/T5–T11/T16/T19/T22–T24), code `poster.ts`, `google-oauth.ts`, `auth.client.ts`, `llm.client.ts`, `community.client.ts`, `rss.ts`, `session.ts`, `.env.example`
**Vai trò trong ASSURANCE**: thỏa HARD-GATE **G10 (một phần)** — GUI chứa token + secret ⇒ cần threat-model "1-host" (PLAN T21) + nhóm test "chỉ chủ nhân có token mới đọc/ghi" (T19) + mask/Bearer/no-secret (T3/T8/T10).

---

## 1. Mục tiêu & phạm vi

Bảo vệ: (a) **bí mật đăng nhập/hạ tầng** (`GOOGLE_CLIENT_SECRET_WEB`, `LLM_API_KEY`, `GUI_TOKEN`, `.session.json` platform/Google refresh tokens); (b) **khả năng hành động phá hoại** (post one-shot, start/stop bot, sửa config); (c) **tính nhất quán dữ liệu** (`posted.json`, single-instance loop).

KHÔNG thiết kế chi tiết backend/UI — đây là **security contract + enforcement map**. Không nằm trong scope: bảo vệ máy chủ OS (OS user có quyền shell = trusted), multi-user/RBAC, TLS cho remote (xem Rủi ro còn lại).

---

## 2. Tài sản cần bảo vệ (assets)

| # | Asset | Nơi lưu | Ảnh hưởng nếu lộ/giả mạo |
|---|-------|---------|--------------------------|
| A1 | `GOOGLE_CLIENT_SECRET_WEB` | `.env`, memory | Attacker đăng ký redirect_uri tùy ý (nếu cùng client_id), mạo danh OAuth app của chủ, đánh cắp authorization code / đổi client của flow |
| A2 | `LLM_API_KEY` | `.env`, memory | Attacker tiêu key LLM (chi phí), hoặc dùng làm bàn đạp nếu key có scope rộng |
| A3 | `.session.json` (platform access/refresh + google refresh token) | `.session.json`, memory | Attacker có refresh token = **post nội dung tùy ý** vào community (spam/phá hoại) + duy trì truy cập lâu dài |
| A4 | `GUI_TOKEN` | `.env`, (client: sessionStorage + memory JS) | Attacker có token = điều khiển toàn bộ GUI: start/stop, post, sửa config, đọc log/history |
| A5 | Ability to post / điều khiển bot | qua API có Bearer | Post nội dung phá hoại, spam trùng, dừng bot (DoS tự thân) |
| A6 | `posted.json` (history + dedup) | file JSON | Giả mạo → đăng bài lặp (mất dedup) hoặc gây nhầm lẫn lịch sử |
| A7 | Lock loop (single-instance) | `loop.lock` | 2 process cùng post → bài trùng + ghi đè file |

---

## 3. Mô hình tin cậy (trust model)

### 3.1 Baseline "1-host" (G10) — GUI bind `127.0.0.1:8899`

| Tầng | Ai | Mức tin cậy | Diễn giải |
|------|----|-------------|-----------|
| a | User có quyền chạy lệnh trên máy (shell/terminal, có thể đọc file `.env`, `.session.json`, kill process) | **Trusted** | Có thể bỏ qua toàn bộ GUI (đọc file trực tiếp). Không thể phòng thủ ở tầng app được — nằm ngoài scope. |
| b | Trình duyệt/thiết bị truy cập `127.0.0.1:8899` **khi `GUI_TOKEN` đặt** | **Semi-trusted** | Chỉ trusted if có token đúng. Không token = bị chặn (401). |
| c | Trình duyệt/thiết bị truy cập local **khi KHÔNG token** (được phép theo PRD FR-8) | **Gần-trusted, có caveat** | Mọi trang web user đang mở trong browser **cùng máy** là kẻ tấn công tiềm năng tầng c — gồm **DNS rebinding** (resolve host giả → loopback) và **cross-origin trực tiếp** (browser gửi thẳng `http://127.0.0.1:8899/…` với `Host: 127.0.0.1:8899` hợp lệ). Vì thế cần **Host-header check** (chống rebinding) **+ cross-site policy `Sec-Fetch-Site`/`Origin`** cho `rss-preview` + POST state-changing khi no-token (xem C7). |
| d | Nội dung RSS / response LLM / feed URL | **Không trusted (input hostile)** | Attacker kiểm soát feed có thể cung cấp title/link/description độc hại (XSS, SSRF) và thao túng nội dung bài đăng. |

**Hệ quả thiết kế**: mọi request từ *mạng* (mọi interface) luôn coi là untrusted; mọi biến `GUI_*` tới từ `0.0.0.0` phải có Bearer; static anonymous chỉ là client UI **no-secret** (C1/C1b). Input từ feed/LLM **không bao giờ được innerHTML** và **không bao giờ fetch tới địa chỉ internal** (C8, C9). Trong no-token mode, `GET /api/rss-preview` là cổng probe/oracle của tầng c → phải qua cross-site check (C7).

### 3.2 Remote extension — `GUI_HOST=0.0.0.0`

- Tầng a (OS user) KHÔNG đổi. Tầng b/c mở rộng: **mọi IP trong LAN/internet = untrusted**, gated hoàn toàn bằng `GUI_TOKEN`.
- `GUI_TOKEN` bắt buộc khi `0.0.0.0` (FR-8, T5.AC: từ chối khởi động nếu thiếu).
- Giữ nguyên: exempt list tối thiểu (§6.2); `/callback` vẫn chạy (T10/T24). OAuth setup từ máy KHÁC = ngoài v1 (R10 — redirect về `localhost` của chính browser máy khách).

---

## 4. Attack surface inventory

**HTTP endpoints (server nhúng, GUI_PORT)**:
- `GET /` , static (`index.html`, `app.js`, `style.css`, `token.js`) — **ANONYMOUS** (client no-secret; chỉ `/api/*` bị gate — C1)
- `POST /api/auth/verify` — xác thực token (anonymous trunk route)
- `GET /callback` — nhận authorization code Google (exempt Bearer, bắt buộc)
- `GET /api/status` · `GET /api/logs?since=` · `GET /api/history` · `GET /api/config` · `GET /api/auth-status` · `GET /api/communities`
- `POST /api/config` · `POST /api/post` · `POST /api/start` · `POST /api/stop` · `POST /api/setup/start`
- `GET /api/rss-preview?url=` (T8) — **SSRF vector chính**

**Outbound fetch (server-side)**: `fetchRssItems(url)` (rss.ts:14), `fetchArticleBody(link)` (rss.ts:39), `downloadImage(imageUrl)` (poster.ts:140), `rewriteArticle` → `LLM_BASE_URL` (llm.client.ts:56), gateway calls (`auth.client.ts`, `community.client.ts`, `content-service.client`). Các gateway call dùng URL cấu hình `.env` (không do user nhập trực tiếp) — không nằm trong SSRF guard, nhưng việc cho sửa `LLM_BASE_URL` qua config mở ra kênh exfil (xem T4, C6).

---

## 5. Phân tích per-asset (vector × khả năng × ảnh hưởng)

Severity = CVSS-style tổng hợp (L=Mức độ). **L** = likelihood, **I** = impact.

| Vector | Mô tả tấn công | L | I | Severity |
|---|---|---|---|---|
| **T1. SSRF — rss-preview** | `GET /api/rss-preview?url=http://127.0.0.1:3005/…` (hoặc metadata cloud) → proxy đọc tài nguyên internal. Không cần auth khi local-no-token; với `0.0.0.0` cần token. **Mitigated (P0)**: `safeFetchUrl` block private/loopback/metadata (C9) + no-token cross-site check chặn request từ trang khác (C7) → phần còn lại là probe liveness / lạm dụng GUI như proxy fetch public | T | M | **Trung bình** |
| **T2. SSRF — item link / image** | Feed độc hại chèn `it.link=http://127.0.0.1:8080/admin` hoặc `it.imageUrl` → `fetchArticleBody`/`downloadImage` tấn công internal ngay trong vòng lặp thường (không cần GUI) | T | H | **Cao** |
| **T3. XSS — log/history/preview** | Feed chèn `<img onerror=…>` hoặc `<script>` vào title/description → hiển thị trong tab Log, Lịch sử, modal preview. Stored XSS sống trong `posted.json` (tái hiện mỗi lần load) | M | H | **Cao** |
| **T4. Exfil LLM key / session qua config** | Attacker có Bearer/token sửa `LLM_BASE_URL` → trỏ về máy attacker → bot gửi input kèm `x-api-key` (llm.client.ts:65) tới máy attacker | Thấp | H | **Trung bình-Cao** |
| **T5. Token brute-force / sniff** | `0.0.0.0` không TLS → token quá network dạng plaintext có thể sniff (tầng LAN). Token yếu + không rate-limit → brute-force | M | H | **Cao** |
| **T6. Lộ secret qua API/error/log** | Error message của config-store/`rss-preview` echo URL chứa query token; GET config trả giá trị secret thay vì `{set}`; log debug in Authorization header | T | H | **Trung bình-Cao** |
| **T7. OAuth CSRF / code interception** | Kẻ cùng máy (hoặc trang web chạy trên browser) đánh cắp authorization `code` trên `/callback` → replay. Mức ảnh hưởng thấp vì code **không thể exchange thiếu `client_secret`** (A1) — exchange server-side | T | M | **Trung bình** |
| **T8. CSRF cổ điển + DNS rebinding** | Mọi endpoint state-changing bị gọi từ trang web khác (không header) hoặc qua rebinding `127.0.0.1:8899` → stop bot, đọc log/history, config | T | M | **Trung bình** (mitigation bắt buộc: Bearer no-cookie + Host check + cross-site no-token Sec-Fetch-Site/Origin — C7) |
| **T9. Malicious RSS/LLM content** | Feed/LLM bị kiểm soát → bot đăng nội dung sai/vi phạm chính sách nền tảng qua tài khoản chủ (bản thân flow bot có profanity retry, nhưng LLM prompt-injection thay hướng nội dung) | T | M | **Trung bình** (accept — không phải vấn đề local access) |
| **T10. Local attacker đọc file** | Ai chạy được lệnh dưới cùng OS user có thể đọc thẳng `.env`/`.session.json` | C (nếu máy dùng chung) | H | **Cao — tầng (a), ngoài scope**, chỉ giảm thiểu OS-level (mục C14) |

---

## 6. Biện pháp bắt buộc (must-have) + enforcement map

> Bảng 2 kèm **task sở hữu** (theo PLAN) và **AC** verify. Khuyến nghị bổ sung AC mới được đánh dấu **[+] AC`** để GATE-C/F chốt.

### 6.1 C1 — Bearer token (timing-safe, không log, exempt tối thiểu; gate = `/api/*`)

**Chính sách** (theo quyết định hội đồng 2026-08-20 — static ANONYMOUS):
1. **Gate scope = mọi `/api/*`** yêu cầu `Authorization: Bearer <token>` khi `GUI_TOKEN` đặt, hoặc **luôn** khi `GUI_HOST=0.0.0.0` (FR-8/T10). Static (`index.html`, `app.js`, `style.css`, `token.js`) **không bị gate** — chúng là client UI **no-secret** (xem C1b): không chứa bất kỳ secret/dữ liệu nào, nên gate static chẳng ngăn được gì mà chỉ gây deadlock (§10 #5).
2. `GET /` **luôn trả `index.html`**; `app.js` onload gọi `GET /api/status` → **401 → render form nhập token trong-page**. Logic form qua **`token.js` external (không inline script)**. Token do user nhập được validate bằng `POST /api/auth/verify` (exempt) rồi gắn Bearer cho mọi `/api/*`.
3. So sánh **timing-safe**: băm cả 2 phía bằng `sha256` rồi `crypto.timingSafeEqual` (không so chuỗi thô, chống timing oracle đo prefix):
   ```ts
   const h = (s: string) => createHash('sha256').update(s).digest();
   return timingSafeEqual(h(provided), h(expected));
   ```
4. Token KHÔNG xuất hiện: trong response body, trong log/monitoring, trong URL, trong browser history. **Lưu trữ client**: chỉ `sessionStorage` (tab-scoped, đóng tab là mất) + memory JS — **không localStorage, không disk** (T11.AC; server chỉ expose `guiTokenSet: boolean` — T10/T7).
5. Endpoint verify anonymous **chỉ để** báo 200/401 cho form nhập token (không trả dữ liệu khác).

**Enforcement**: `server.ts` (T10) · `app.js`/`token.js` (T11) · fetch helper (T11) · **verify**: T10.AC.1/3/4 (đổi ngữ nghĩa: static tải được KHÔNG token, nhưng mọi `/api/*` vẫn 401); T19 group Bearer + no-secret regex mọi response (kể cả `/callback`); **[+] AC: static `index.html`/`app.js`/`token.js` tải 200 khi KHÔNG token; `GET /api/status` trả 401; nhập đúng token vào form trong-page → `/api/*` 200; token vắng mặt mọi response (regex no-secret); comparator timing-safe được unit-test (fail nếu nhánh if để lộ chuỗi)**.

### 6.2 C1b — Exempt list tối thiểu + mô hình "no-secret static" (contract cho T24/T10)

**Static KHÔNG thuộc phạm vi gate** (anonymous, client UI no-secret) nên không cần nằm trong "exempt list". Chỉ **2 route API** được phép không Bearer:

| Route | Lý do |
|---|---|
| `POST /api/auth/verify` | Xác thực token cho form nhập trong-page (trả 200/401 thuần, không dữ liệu khác). |
| `GET /callback` | **Bắt buộc exempt** — xem chứng minh dưới. |

**Tại sao chấp nhận static anonymous (đổi từ "gate cả static"):** ở thời điểm tải trang, **không có 1 byte secret/dữ liệu nào nằm trong 5 file static** — mọi bí mật (A1–A4) chỉ đi qua `/api/*` (mask + Bearer). Gate static không thêm lợi ích bảo mật nào, chỉ gây deadlock (bắt buộc kiểu gì cũng phải có trang/thủ công nạp token). Mô hình còn lại = **no-secret static + sealed API**: kẻ tầng c thấy được "mã nguồn UI" nhưng không đọc được dữ liệu/secret và không gọi được state-changing (Bearer + cross-site policy C7).

**Chứng minh vì sao `/callback` bắt buộc exempt (R13):** OAuth authorization-code flow là **navigational redirect cấp top-level**: Google trả HTTP 302 về `redirect_uri`. Trình duyệt khi thực hiện navigation này KHÔNG thể gắn `Authorization: Bearer` (header này chỉ do JS `fetch` gắn). Nếu gate `/callback` ⇒ mọi request từ Google không header ⇒ 401 ⇒ code không bao giờ qua được ⇒ **setup Google từ GUI vỡ hoàn toàn**. Không có cách nào đính header vào navigation top-level, nên exempt là tất yếu, không phải lựa chọn.

**Giảm rủi ro của exemption (bắt buộc)**: (1) `/callback` xử lý duy nhất GET `?code` + `?state`; (2) **state param**: so khớp chính xác (`timingSafeEqual`) với state do `POST /api/setup/start` sinh (in-memory), **dùng 1 lần + TTL ≤ 10 phút**, hết hạn/mismatch → 400 + không exchange; (3) exchange **server-side** bằng `client_secret` — credential nằm `.env`, code lọt ra ngoài cũng vô giá trị; (4) response = HTML tĩnh tối giản "thành công/thất bại", **không echo code/state**, không chứa secret; (5) ngoài việc lưu session, `/callback` không có tác dụng phụ khác.

**Enforcement**: T24 (chốt danh sách) · T10 (áp middleware, giữ danh sách hằng số, không thể thêm route tuỳ biến) · T16 (state check) · **verify**: T10.AC.5, T16.AC, **[+] AC: thử `/callback?code=x&state=<sai-tệ>` → 400 KHÔNG gọi exchange; thử gọi `/callback` không có state → 400**.

### 6.3 C5 — Mask secret mọi nơi

1. `GET /api/config` (T8) + snapshot trong `GET /api/status` (T7): secret => `{set: boolean}` — KHÔNG BAO GIỜ trả giá trị. `config-store.toPublic()` (T3.AC.2) là nguồn duy nhất → mọi route phải dùng nó.
2. **Config write**: chỉ cho ghi field allowlist `{RSS_FEED_URL, RSS_LIMIT_PER_CYCLE, POST_INTERVAL_MS, COMMUNITY_ID, LAYOUT_TYPE, DRY_RUN, LLM_BASE_URL, LLM_MODEL, LLM_API_KEY, GOOGLE_CLIENT_SECRET_WEB}`, secret chỉ qua `*_SET` (rỗng = xóa dòng). Reject unknown field + `GATEWAY_URL`, `GOOGLE_CLIENT_ID_WEB`, `GUI_*` không được ghi qua GUI (hoặc validate cứng).
3. **Error message / log**: không in giá trị secret; error của `rss-preview`/config **không echo URL gốc** (có thể chứa query token của feed trả phí) — chỉ in host mask hoặc generic.
4. **`/callback` + trang nhập token**: không chứa secret (C1b).
5. Không bật CORS (`Access-Control-Allow-Origin`) ở bất kỳ response nào.

**Enforcement**: T3 (toPublic + allowlist), T8/T7 (vận dụng), T6 (sanitize logger), T19 **no-secret regex test trên MỌI response + ring buffer**; T21 secret-scan repo. **verify**: T3.AC.2, T8.AC.2, AC-8 PRD, T19.

### 6.4 C8 — Chống XSS (log/history/preview): chính sách cụ thể

1. **RENDER POLICY (bắt buộc, frontend — T11/T13/T14/T15)**: mọi giá trị xuất phát từ feed/LLM/config/user input (title, description, reason, log line, link, preview text) được đổ vào DOM **bằng `textContent` / `createElement` + `setAttribute`**, **TUYỆT ĐỐI CẤM `innerHTML`/`insertAdjacentHTML`/`outerHTML`/`document.write`** trên các field đó. `posted.json` là stored data → không bao giờ trust persisted data (XSS stored tua lại mỗi lần load).
2. Link (item link, nguồn): chỉ set `a.href` sau khi `new URL(value)` hợp lệ với `protocol===http/https`; không set `target` raw; luôn `rel="noopener noreferrer"`.
3. Preview (FLOW 4 "kiểm tra feed", dry-run modal): render text trong `<pre>`/`<div>` không HTML (`textContent`).
4. **Security headers (server, T5)**: `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'` (không inline script ở bất kỳ trang nào — form token chạy qua `token.js` external, xem C1; `frame-ancestors 'none'` chống clickjacking). `X-Content-Type-Options: nosniff`; `Referrer-Policy: no-referrer`; mọi API trả `Content-Type: application/json; charset=utf-8` (không `text/html`).
5. Log panel (T13): dòng buffer render bằng `textContent`; **không parse HTML trong log**.

**Enforcement**: T11/T13/T14/T15 (render), T5 (headers), **verify**: **[+] AC: injection fixture `title=‘<img src=x onerror=alert(1)>‘` nếu nằm trong GET /api/status|history|logs|rss-preview → GUI render không thực thi (assert bằng CSP + DOM text); response headers chứa CSP bắt buộc**; T19 (HTTP-level assert headers), T21 review frontend static (grep `innerHTML`).

### 6.5 C9 — Chống SSRF (`rss-preview` + item link/image/LLM fetch)

**Chính sách (default-deny)** — áp dụng cho một helper dùng chung `safeFetchUrl(url, opts)`:
1. Scheme cho phép: **chỉ `http`/`https`** (reject `file:`, `data:`, `ftp:`, `gopher:`…).
2. Host cấm tuyệt đối: `localhost`, `127.0.0.0/8`, `::1`, `0.0.0.0`, `10/8`, `172.16/12`, `192.168/16`, `169.254.169.254` (metadata cloud), `fe80::/10`, `fc00::/7`, và tên metadata (`169.254.169.254` literal). **Trước khi so sánh: normalize hostname** — `new URL(url).hostname` trả `[::1]` (còn ngoặc) với IPv6 literal → **strip bracket `[…]` + lowercase** rồi mới khớp chuỗi/rải (finding #2 → không miss `[::1]`, `[fe80::…]`).
3. **Resolve DNS trước khi fetch** (`dns.lookup` lấy mọi address) → **reject nếu BẤT KỲ address nào thuộc dải private/link-local/loopback/metadata**. Không dựa chỉ trên hostname string (chống DNS trick dùng host như `foo.127.0.0.1.nip.io`).
4. **Redirect**: giới hạn ≤3 hop, mỗi hop re-validate lại rule (2)+(3).
5. Timeout request (≤5s) + giới hạn response size (≤2 MB) — chống DoS ngốn bộ nhớ qua preview.
6. Khi vòng lặp cần feed internal (chính chủ cài feed nội bộ): env-explicit **opt-out** `GUI_ALLOW_PRIVATE_FETCH=true` kèm log cảnh báo — mặc định deny.
7. Wire vào (**toàn bộ P0** theo hội đồng 2026-08-20 — nâng từ P1): `GET /api/rss-preview` (T8) + `POST /api/post mode=rss` (rssUrl user nhập); **vòng lặp**: `fetchRssItems`/`fetchArticleBody`/`downloadImage` (T1/T2) + **validate `LLM_BASE_URL` lúc ghi config** (https + non-private — đóng kênh exfil key, T4). Lý do nâng P0: feed độc hại bắn thẳng vào gateway local hạ tầng **xảy ra không cần chạm GUI** — chỉ bảo vệ preview là thiếu.

**Không dùng allowlist domain** (phá use case "feed bất kỳ" một-shot/đổi feed linh hoạt của v1). Block private-IP là đủ cho mục tiêu (bảo vệ gateway local:3005 + nội bộ).

**Enforcement**: T8 (rss-preview) + helper chung `safe-fetch.ts` (T1/T2/T4 wire vòng lặp + LLM_BASE_URL), **verify**: **[+] AC (T19)**: `rss-preview?url=http://127.0.0.1:3005/…` → 400 + không outbound call; `url=http://169.254.169.254/latest/meta-data/` → 400; redirect 302 → internal host bị 400; **IPv6 `url=http://[::1]/` → 400 (bracket normalize)**; **`LLM_BASE_URL=http://…` ghi config → 400**; item `link=http://127.0.0.1:3005/…` trong feed fixture → 400 + không outbound; `GUI_ALLOW_PRIVATE_FETCH` mặc định không bật**; T21 regression `--dry-run` với feed giả thường vẫn OK.

### 6.6 C7 — Chống CSRF + DNS rebinding (Bearer no-cookie)

**Phân tích vì sao Bearer trong `Authorization` header (không cookie) làm giảm CSRF**:
- CSRF cổ điển lợi dụng browser tự gắn **ambient credential** (cookie). GUI dùng header do JS đọc từ memory → attacker site **không đọc được token**, **không tự gắn được header**.
- Fetch cross-origin gắn `Authorization` phải qua **CORS preflight**; server **không** trả `Access-Control-Allow-Headers` → preflight fail → header không được gửi → mọi endpoint state-changing đều 401. (Server không bật CORS là bắt buộc — C5.5.)
- ⇒ **Không cần token chống CSRF bổ sung** (không cần double-submit cookie / CSRF-token). Thiết kế đơn giản hơn và đúng thực tế single-user.

**Phòng hậu cửa 1 — Host-header validation khi bind loopback**: khi `GUI_HOST` là `127.0.0.1`/`localhost` (cả khi có token lẫn không), middleware **reject request có `Host` không thuộc** `{127.0.0.1:<port>, localhost:<port>, [::1]:<port>}` → chặn DNS-rebinding (trang độc hại resolve host tên → loopback). Khi `0.0.0.0` bỏ qua (Host là IP/hostname thật của máy — bearer đã gate, không phụ thuộc host).

**Phòng hậu cửa 2 (finding #1 — BẮT BUỘC) — Cross-site policy cho no-token local mode**: khi **KHÔNG token** (`GUI_TOKEN` rỗng + bind loopback), trang web khác gọi thẳng `http://127.0.0.1:8899/…` vẫn gửi `Host: 127.0.0.1:8899` (khớp phòng hậu cửa 1) → **Host check KHÔNG đủ**. Bổ sung chính sách cho **`GET /api/rss-preview` + mọi POST state-changing** (`start`, `stop`, `post`, `config`, `setup/start`):
1. Reject nếu header `Sec-Fetch-Site: cross-site` (browser gửi tự động — chặn fetch/form từ trang khác).
2. Reject nếu header `Origin` hiện diện và KHÔNG thuộc danh sách origin loopback `{http://127.0.0.1:<port>, http://localhost:<port>, http://[::1]:<port>}`.
3. Không có 2 header trên (curl/CLI/process local = tầng a trusted) → cho qua.
- **Khi có token**: đã an toàn — cross-origin gắn `Authorization` buộc qua **CORS preflight**; server không trả `Access-Control-Allow-Headers` → preflight fail → header không được gửi → 401. Không cần Origin check thêm ở token mode (C1 + C5.5).

**Enforcement**: T10 (bearer + cross-site policy) + T5/T10 (Host check), **verify**: T10 group + **[+] AC (T19)**: request loopback kèm `Host: evil.example` → 400/403; request kèm `Sec-Fetch-Site: cross-site` hoặc `Origin: https://evil.example` tới `GET /api/rss-preview` / `POST /api/start` khi no-token → 400/403; request same-origin (không header / Origin loopback) → 200 khi đủ token (hoặc no-token đúng route).

### 6.7 C10 — OAuth CSRF / localhost redirect

1. **state param** (bắt buộc): sinh `randomBytes(16)` mới mỗi `POST /api/setup/start` (đã có `newState()` google-oauth.ts:17), gắn vào consent URL, kiểm tra lại ở `/callback` bằng `timingSafeEqual`, single-use + TTL ≤10 phút (đã nêu C1b).
2. **redirect_uri validate cứng**: server chỉ chấp nhận đúng giá trị `GOOGLE_OAUTH_REDIRECT_URI` đã khai báo; registry `redirect_uri` do **T24** lập + khách đăng ký trên Google Console (danh sách: `http://localhost:<GUI_PORT>/callback` + host thật nếu remote). Không nhận redirect URI khác.
3. **PKCE (P1, defense-in-depth)**: Google hỗ trợ PKCE cho OAuth web. Vì flow đã có `client_secret` (confidential client) + state + exchange server-side, code bị steal không exchange được; PKCE thêm lớp chống **code-injection** khi code bị chặn đường trước khi tới `/callback` (ví dụ cùng máy có proxy). Chi phí thấp — làm cùng T16 nếu không chậm tiến độ, ngược lại để P1.
4. **Không hiển thị `code`/**`: response `/callback` không echo code/state (C1b.4).

**Enforcement**: T16 (state/PKCE), T24 (registry), **verify**: T16.AC + **[+] AC: `/callback` với state đã dùng → 400; state hết TTL → 400; mismatch → 400 (không gọi `exchangeCodeForTokens`)**; GATE-E verify 1 consent flow thật.

### 6.8 C11 — Rate limiting fail-auth (mọi route bị gate) + anti-spam + `lockedUntil`

- **Cơ chế (quyết định hội đồng)**: đếm **fail-auth chung trong Bearer middleware cho MỌI route bị gate** (bất kỳ 401 nào = 1 fail), key theo source IP, in-memory → **per-IP backoff** (exponential 30s → 1m → 2m). Riêng `POST /api/auth/verify` + `POST /api/setup/start` có ngưỡng chặt hơn (~5 fail / 30 giây/IP; setup ~3–10 lần/phút) — chống spam verify/consent.
- **Lợi ích thực (finding #3 — giữ vì anti-spam, KHÔNG hứa chống brute-force)**: `GUI_TOKEN` ≥128 bit (≥32 ký tự base64url, check startup khi remote) là phòng thủ chính; rate-limit chỉ (a) chặn spam setup/verify/consent URL từ 1 IP, (b) làm chậm nguồn từng-IP khi remote. Không tuyên bố đây là lớp chống brute-force.
- **`lockedUntil` (finding #4 — UX countdown)**: mọi response **429** trả kèm `{lockedUntil: number}` (+ backoff/jitter hợp lý, không lộ chi tiết nội bộ) để UI render **countdown** ngay cạnh form nhập token / nút "Kết nối Google" (T11/T15/T17) — thay message tĩnh.

**Enforcement**: T10 (middleware đếm fail-auth mọi route) · T16 (setup) · T11 (UI countdown) · **verify**: **[+] AC (T19): 6 request sai-token liên tiếp → request thứ 6 trả 429 **kèm `lockedUntil`** và không mở khóa trong khoảng backoff; fail-auth từ route khác (vd `GET /api/status` sai Bearer) cũng cộng vào cùng bộ đếm per-IP; GUI assert hiển thị countdown khi nhận 429**.

### 6.9 C12 — Log/error không chứa token/secret (bao phủ MỌI error tới GUI)

- Auth middleware không log header Authorization.
- Logger ring-buffer (T6) chạy hàm **sanitize dùng chung**: redact dải khớp (`/Bearer\s+\S+/i`, `x-api-key`, giá trị biến secret đang set) trước khi ghi vào buffer — buffer đổ ra GUI nên được bảo vệ như response.
- **Cùng sanitizer đó bọc mọi error message đi ra GUI** (finding #6): error envelope `message` (design §4.2) generic — không `JSON.stringify(body)` gốc lộ header/content; **`lastOAuthError` trong `GET /api/auth-status`** chỉ nhận message tiếng Việt đã allowlist (2FA / register / generic) chuyển qua mapper (T16), **không bao giờ chứa raw body/header/token**.
- Error của `rss-preview`/config **không echo URL gốc** (C5.3 — có thể chứa query token feed trả phí); chỉ in host đã mask hoặc generic.

**Enforcement**: T6 (sanitize dùng chung) · T8/T16 (error mapping + lastOAuthError) · **verify**: T19 no-secret regex trên `/api/logs` + `/api/auth-status.lastOAuthError` (trigger OAuth fail bằng fixture) + error envelope mọi 4xx/5xx; manually trigger `POST /api/rss-preview` lỗi → kiểm tra log/response không echo raw.

### 6.10 C13/C14 — Integrity & OS-level

- **C13 Single-instance lock** (T23): giữ đúng AC — chống 2 process cùng loop (double post, 2 writer `posted.json`). Không phải security chống OS-attacker, là integrity của asset A6/A7.
- **C14 File permissions (P1/P2)**: `.env`, `.session.json`, `posted.json` là gitignored (bắt buộc giữ); ghi chú vận hành: nếu máy dùng chung OS user khác → thu hẹp ACL (Windows: chỉ owner đọc) hoặc lên kế hoạch encrypt `.session.json` (P2). Nằm ngoài v1 if máy cá nhân.

---

## 7. Thứ tự ưu tiên

### P0 — Bắt buộc trước ship (GATE-C/F không thông nếu thiếu)
| Mã | Biện pháp | Task | Verify |
|----|-----------|------|--------|
| C1/C1b | Bearer timing-safe, 401; **gate = `/api/*`** (static anonymous no-secret client, form token trong-page qua token.js external; token sessionStorage+memory); exempt = {`POST /api/auth/verify`, `GET /callback`} | T10, T24, T11 | T10.AC.1/3/4, T19, [AC+] static-vs-API |
| C4 | `/callback`: state single-use+TTL, exchange server-side, HTML tĩnh không secret | T16 | T16.AC, [AC+] |
| C5 | Mask secret mọi response (API GET, status snapshot, error, rss-preview echo, lastOAuthError), config write allowlist, no CORS | T3, T8, T7 | T3.AC.2, T8.AC.2, T19, [AC+] |
| C8 | Render `textContent` (no innerHTML) + CSP + security headers | T11/T13/T14/T15, T5 | [AC+] XSS fixture, T19 headers |
| C9 | SSRF guard `safeFetchUrl` (scheme http(s) + block private/loopback/metadata + IPv6 bracket normalize + DNS re-check + redirect ≤3 re-check + timeout/size + opt-out flag) áp cho **rss-preview + POST /api/post + vòng lặp (fetchRssItems/fetchArticleBody/downloadImage) + LLM_BASE_URL validate (https, non-private)** — **P0** | T8, T1, T2, T4 | [AC+] T19 private/metadata/redirect/IPv6/LLM-BASE-URL tests |
| C2 | Từ chối khởi động khi `0.0.0.0` thiếu token | T5 | T5.AC.3 |
| C7 | Bearer header (không cookie) + Host-header check khi loopback (chống rebinding) + **cross-site no-token policy (Sec-Fetch-Site/Origin) cho rss-preview + POST state-changing** | T10, T5 | T19, [AC+] cross-site/origin tests |
| C12 | Sanitize log + MỌI error tới GUI (envelope message, lastOAuthError), không echo raw URL/body | T6, T8, T16 | T19 no-secret `/api/logs` + `/api/auth-status` |

### P1 — Nên trong v1 / ngay sau ship
| Mã | Biện pháp | Task | Verify |
|----|-----------|------|--------|
| C11 | Rate limiting fail-auth **mọi route bị gate** (Bearer middleware đếm 401, per-IP backoff) + ngưỡng chặt verify/setup (anti-spam) + 429 trả `lockedUntil` + entropy ≥128 bit `GUI_TOKEN` khi remote | T10, T16, T11 | [AC+] T19 (429 + lockedUntil + countdown UI) |
| C10 | PKCE + redirect_uri registry ràng cứng đúng Google Console | T16, T24 | GATE-E consent thật |
| C13 | Single-instance lock (đã có T23, giữ như P0 integrity) | T23 | T23.AC |
| C16 | Cảnh báo vận hành: `0.0.0.0` plain HTTP = token sniffable → chỉ chạy trên LAN trusted / phía sau HTTPS reverse proxy; UI nêu giới hạn R10 | T5/T11 | — |

### P2 — Sau v1
| Mã | Biện pháp | Task đề xuất |
|----|-----------|-------------|
| C17 | GUI_TOKEN hashed at rest + token rotation qua GUI | v2 |
| C18 | Audit log state-changing API (ai đổi config/start/stop/post, khi nào) + tamper-evident `posted.json` | v2 |
| C19 | Encrypt `.session.json` at rest / script thiết lập OS ACL | v2 |
| C20 | Mở rộng `Origin` allowlist thành danh sách origin cố định ở state-changing khi muốn cứng hơn (no-token mode đã có cross-site check ở C7) | v2 |

---

## 8. Rủi ro còn lại (accepted) & giả định

1. **OS user trusted (tầng a)**: ai chạy được shell dưới cùng user có thể đọc `.env`/`.session.json` trực tiếp — không phòng được ở tầng app; giảm thiểu OS-level (C14, P2).
2. **Sniff token khi remote**: `0.0.0.0` plain HTTP — chấp nhận với giả định "LAN trusted"; khuyến cáo HTTPS reverse proxy nếu mở rộng ra Internet (P1 C16).
3. **Malicious LLM/feed nội dung** (T9): bot có thể bị điều hướng đăng nội dung xấu — là bản chất bot; quản trị rủi ro nội dung thuộc content-service (profanity), không phải GUI.
4. **DNS TOCTOU trong SSRF guard**: giữa lúc kiểm tra IP và lúc `fetch` connect có kẽ hở nhỏ với attacker kiểm soát DNS — hợp lệ cho tool single-user; nếu cần chặt hơn dùng dispatcher chặn ở tầng socket (P2).
5. **`code` OAuth bị steal**: ảnh hưởng hạn chế vì exchange cần `client_secret` (chỉ trong `.env`); PKCE (P1) đóng nốt kẽ này.

---

## 9. G10 — Bản đồ thỏa mãn (rút gọn kèm evidence)

| Yêu cầu G10 (nhóm riêng, PLAN §8) | Thỏa bằng |
|---|---|
| Mask mọi secret | P0 C5 → T3/T8 + no-secret regex T19 |
| Bearer enforcement khi bật / remote | P0 C1 → T10 + T19 (gate = `/api/*`; static anonymous no-secret) |
| Token không log/không trả | P0 C1/C12 → T10/T6 + regex T19 + secret-scan T21 |
| Threat-model 1-host | **Doc này** — mục 3, 5, 6 |
| Test "chỉ chủ nhân có token mới đọc/ghi" | T19 (Bearer group) + T10.AC.1/4 — assert 401 khi thiếu token cho MỌI endpoint read/write |
| Cross-site no-token chặn lạm dụng local GUI (rss-preview probe + state-changing) | P0 C7 → T10 + T19 (Sec-Fetch-Site/Origin AC) |
| SSRF vòng lặp + `LLM_BASE_URL` validate (nâng lên P0) | P0 C9 → T1/T2/T4/T8 + T19 AC |

---

## 10. Decision log (hội đồng, 2026-08-20)

Tổng hợp vòng phản biện chéo (Backend + UX + quyết định chung). Thay đổi đã nạp vào C1–C12, §3, §5, §7, §9.

| # | Finding (nguồn) | Quyết định | Lý do / cách vá |
|---|---|---|---|
| 1 | [Backend] **major** — §3.1/§6.6 C7: Host-header check không chặn cross-origin khi no-token local; `GET /api/rss-preview` từ evil-site = blind SSRF/probe | **CHẤP NHẬN** | Browser trang khác vẫn gửi `Host: 127.0.0.1:8899` nên Host check không phải tầng cuối. Sửa C7: no-token mode reject `Sec-Fetch-Site: cross-site` + `Origin` ngoài danh sách origin loopback cho rss-preview + mọi POST state-changing; token-mode đã an toàn nhờ Authz header → CORS preflight fail (C1/C5). Đồng thời nhập quyết định P0: loop-SSRF + `LLM_BASE_URL` validate vào C9. |
| 2 | [Backend] **minor** — §6.5 C9: IPv6 literal `[::1]` (còn ngoặc) → khớp chuỗi/rải miss | **CHẤP NHẬN** | C9.2 thêm bước normalize hostname (strip bracket + lowercase) trước khi so sánh + trước `dns.lookup`; AC mới: `rss-preview?url=http://[::1]/` → 400. |
| 3 | [Backend] **minor** — §6.8 C11: lockout "ngăn brute-force" là theater với token 128-bit | **CHẤP NHẬN** | Giữ control vì chống spam setup/start/verify; viết lại lợi ích thực (anti-spam + làm chậm), phòng thủ chính = entropy ≥128 bit. Áp cơ chế hội đồng: dồn fail-auth chung trong Bearer middleware mọi route bị gate (per-IP backoff). |
| 4 | [UX] **minor** — 429 `lockedUntil` cần countdown | **CHẤP NHẬN** | C11: verify/setup + mọi 429 trả `lockedUntil` (+ backoff hợp lý); UI render countdown (T11/T15/T17); AC mới T19. |
| 5 | [UX] **blocker** — static gated Bearer deadlock (top-level navigation / script src không gắn được Authorization) | **CHẤP NHẬN** theo quyết định chung | Đổi C1/C1b/C7: static anonymous, chỉ gate `/api/*`; `GET /` → index.html; onload `/api/status` → 401 → form token trong-page (token.js external); token sessionStorage + memory. Mô hình còn lại: **no-secret static** — bí mật chỉ ở API (mask + Bearer); chấp nhận lộ mã UI vì không có dữ liệu. BÁC phương án "gate cả static (T10.AC.2 cũ)": gây deadlock, không tăng bảo mật (static vốn không chứa secret). |
| 6 | [DESIGN] **minor** — lastOAuthError sanitize | **CHẤP NHẬN** | C12 mở rộng: cùng sanitizer với log bọc mọi error tới GUI — error envelope `message` + `lastOAuthError` trong `/api/auth-status` (chỉ message tiếng Việt đã allowlist). |

**Kết quả: 6/6 CHẤP NHẬN (0 BÁC).** Quyết định chung khác đã nạp: static anonymous + sessionStorage/memory (C1/C1b), fail-auth rate-limit mọi route bị gate (C11), loop-SSRF + `LLM_BASE_URL` → P0 (C9), cross-site no-token cho state-changing + rss-preview (C7). CẤM sửa: DESIGN / UI-SPEC / PLAN (doc khác sẽ được Backend/UI vá theo).