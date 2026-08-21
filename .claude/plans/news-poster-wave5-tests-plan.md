# Plan — Wave 5: Tests (node:test) + contract + mutation + SAST/authz

> Trạng thái: **CHỜ APPROVE.** Đóng các hard-gate G1 (tests), G2 (mutation), G3 (contract),
> G5 (SAST/secret-scan), G10 (authz) còn lại trong `docs/ASSURANCE-news-poster-gui.md`.
> Không thêm runtime dependency — chỉ dùng devDeps đã có (ts-node, typescript) + node:builtin.

## 1. Mục tiêu

| Gate | Nội dung | Cách đóng |
|---|---|---|
| G1 | unit + integration (node:test) xanh, 0 skip | `test/unit/*` + `test/integration/*` |
| G2 | mutation score ≥ ngưỡng; 0 live mutant critical | mutant runner nội bộ mini (không tool ngoài), nhắm các hàm critical: sanitize, isPrivateIp/validatePublicUrlStatic/validateLlmBaseUrlStatic, hasPostPermission, isProfanityRejection, normalizeFieldValue, hashKey, describeError |
| G3 | contract test (consumer-driven) PASS mọi biên | `test/contract/*` — chạy server GUI thật trên port tự chọn + temp `.env`, assert toàn bộ envelope + status code + edges |
| G5 | SAST + secret-scan | test scan `public/`, `docs/`, source: không secret dạng khớp pattern (Bearer / client_secret / -----BEGIN / google oauth) |
| G10 | authz | contract test token route: 401 sai / 429 rate-limit / 200 đúng + PII: không API nào trả secret |

## 2. Nguyên tắc

- **Zero new deps**: `node --test` + `--require ts-node/register` (probe đã PASS). Script npm mới thay vì đổi `npm test` (giữ CLI test-post cũ).
- **Fast + isolated**: test dùng 1 temp dir (`test/.tmp/<testname>`) cho `.env`/`posted.json`/`.session.json`/`loop.lock`; dọn sau mỗi file (after hook). Không bao giờ đọc/ghi `.env` thật của repo.
- **No real network**: mọi fetch bị stub `global.fetch` (unit). Integration/contract test dụng `http://127.0.0.1:<free-port>` với server GUI thật.
- **0 skip / 0 todo**: test thật hoặc không viết.

## 3. File & layout

```
test/
  helpers/  temp-env.ts   — tạo temp .env/dedup/session/lock, stub fetch, waitForServer
  unit/
    sanitize.test.ts
    dedup.test.ts
    safe-fetch.test.ts
    config-store.test.ts
    log.test.ts
    session.test.ts
    rss.test.ts
    bot-controller-helpers.test.ts   (truncate/sleep/abortableSleep/collectSecrets/describeForUser/isProfanityRejection)
    clients.test.ts                  (auth.client / community.client / content-service.client / upload.client / llm.client — fetch stub)
    google-oauth.test.ts             (getGoogleAuthUrl/waitForRedirectCode/exchange/refresh — local http + fetch stub)
  mutation/
    run-mutants.ts                   — mini runner: đọc source → sinh mutant (lật toán tử, bỏ guard, đổi return) → chạy unit test tương ứng → score
    mutants-config.ts
  contract/
    server-contract.test.ts          — boot server thật + temp env + token, assert toàn bộ routes/edges
    authz-secret.test.ts             — token gate + rate-limit + PII (không secret trong response)
    secret-scan.test.ts              — scan repo (G5)
```

## 4. Phases (code theo thứ tự)

### Phase 1 — Harness + helpers
- `package.json`: thêm scripts:
  - `test:unit`: `node --test --require ts-node/register "test/unit/**/*.test.ts"`
  - `test:contract`: `node --test --require ts-node/register "test/contract/**/*.test.ts"`
  - `test:wave5`: `npm run test:unit && npm run test:contract` (G1+G3)
  - `test:mutation`: `ts-node test/mutation/run-mutants.ts`
- `test/helpers/temp-env.ts`: hàm `makeTempEnv()` — dir tạm + file `.env` (đủ KNOWN_KEYS), `DEDUP_FILE`/`SESSION_FILE`/`LOOP_LOCK_FILE` trỏ vào dir tạm; trả `{dir, envPath, cfg}` + `cleanup()`.
- Helper `stubFetch()` — gán `global.fetch` bằng fn stub, trả về object `Response`-like `{ok,status,text(),headers}`; lưu lại original (`after` restore).
- **server.ts**: thêm export nhỏ `closeGuiServer(): Promise<void>` + giữ `runningServer` ở module scope — để contract test tắt server giữa các case (không đổi hành vi production, startGuiServer vẫn trả url).

### Phase 2 — Unit tests (G1): các file trong `test/unit/`
Nội dung khớp đúng contract đã verify từ code (không re-derive):
- **sanitize**: redact `Bearer <…>`, `x-api-key`, `client_secret=`; secret literal; không cắt string <4 ký tự. `stripUrlQuery` giữ path, bỏ query/hash, `<invalid-url>` cho URL hỏng.
- **dedup**: `hashKey` deterministic; `load` rỗng/JSON hỏng → `[]`; `markPosted` legacy upgrade trong place; script không copy key đã posted; failed entry vẫn ghi; cap 1000; `listHistory` sort desc, filter status, default limit 100 + hard cap 1000, limit 0 → [].
- **safe-fetch**: `isPrivateIp` v4 (10/127/169.254/172.16-31/192.168/100.64/224+), v6 (::1, fc/fd, fe8, ff, 2001:db8, ::ffff:7f00:1), zone id; `validatePublicUrlStatic` từ chối file://, thiếu host, localhost/.local/.internal/.home.arpa, IP private; `validateLlmBaseUrlStatic` chặn http→public host, cho phép http→localhost/10./192.168./172.16-31, https pass static.
- **config-store**: `parseEnvFile` quoting (JSON-style, single-quote, escape); `loadConfig` defaults + `process.env` override + empty-string trumps; `toPublic` mask `{set}`; `applyUpdates` reject unknown; tri-state `_SET` (absent/''/value); normalize int/bool sai → throw (file untouched); round-trip giữ comment/foreign lines; atomic write tạo temp cùng dir + rename; sync process.env.
- **log**: seq monotonic qua push; cap 1000 dòng + 1MB byte (bufferBytes); truncate 2000 chars (không cắt surrogate pair); `readLogs` since=firstSeq edge/reset khi since<firstSeq hoặc since>seq; filter 'all' = no filter; sanitize chạy khi `setLogSecrets`.
- **session**: load rỗng/JSON hỏng → `{}`; save → atomic + đọc lại đúng.
- **rss**: `parseRssItems` từ XML mẫu (title/link/description/CDATA/`<![CDATA[`/imageUrl); `buildContent` teaser <500 + cắt whitespace + Nguồn link; articleBody nối vào; `fetchArticleBody` trích `<p class="Normal">` + filter xanh hoá trang.
- **bot-controller-helpers**: truncate, sleep resolves, abortableSleep abort ngay, collectSecrets bỏ <4, describeForUser mapping (PROFANITY/UNAUTHORIZED/FORBIDDEN/SERVER_ERROR/fallback), isProfanityRejection (words / reason prefix).
- **clients** (stub fetch):
  - auth.client: loginWithGoogle 200→tokens + decodeJwtExp; 2fa→throw; register→throw; thiếu token→throw. refreshPlatformToken 200/!ok. ensurePlatformToken: <5min → refresh; còn dư → trả trực tiếp; thiếu refresh → throw. bootstrapViaGoogle: có googleRefresh → login-google.
  - community.client: listMyCommunities unwrap `{success,data}` vs raw array; getMyMemberPermission; hasPostPermission (OWNER / POST_CONTENT / MEMBER-ko quyền / null).
  - content-service.client: createPost 201→body; 400 profanity words→throw status=400 body=…; describeError: profanity (INAPPROPRIATE_CONTENT/40001/words), 401, 403, 500, UNKNOWN.
  - upload.client: 200→id; no id→throw; !ok→throw.
  - llm.client: 200 text→nội dung; 3xx → throw "redirect not allowed"; 401→throw; validateLlmBaseUrlStatic http→public host → throw.
- **google-oauth**: getGoogleAuthUrl có đủ params (client_id, redirect_uri, response_type=code, scope, access_type=offline, prompt=consent, state); waitForRedirectCode: local server + gọi GET /callback?code&state → resolve code/state, sai state→vẫn resolve (xử lý state ở poster), /callback không code → reject "OAuth trả lỗi"; exchange: stub fetch tới TOKEN_URL (form body); thiếu id_token → throw. refresh tuương tự.

### Phase 3 — Contract tests (G3 + G10 + G5): boot server GUI thật
- Setup: temp dir `.env` với `GUI_HOST=127.0.0.1`, `GUI_PORT=<free>`, `GUI_TOKEN=test-tok123`, `DEDUP_FILE/SESSION_FILE/LOOP_LOCK_FILE` trong temp dir; gọi `startGuiServer()`; `before`/`after` dọn server.
- Assert matrix:
  - Static: `/` 200 html + security headers (CSP có `script-src 'self'`, nosniff, no-store); `/nope` 404.
  - `/api/status` (token) 200 `{ok:true,data:{state:'STOPPED',guiTokenSet:true}}`.
  - `/api/logs` 200 `{lines,firstSeq,lastSeq,reset}`; since hợp lệ → increment; since cũ → reset=true.
  - `/api/history` seeded 200 shape `{status,count,entries[]}`.
  - `/api/config` GET: `{config{...masked}, writable, secretSet, guiTokenSet}`; POST biến temp `.env`: valid write → written[], unknown field → 400, int sai → 400, secret `_SET=''` → deleted + không trả value.
  - `/api/rss-preview`: thiếu url → 400; url private `http://127.0.0.1` → 502 (SSRF).
  - `/api/auth-status` 200 `{hasSession:false, lastOAuthError:null, guiTokenSet:true}`.
  - `/api/post`: thiếu COMMUNITY_ID → 400; body không json → 400.
  - `/api/setup/anything` → 404 `NOT_IMPLEMENTED`.
  - `/api/auth/verify`: không token → 400 MISSING_TOKEN; sai token → 401; sai 3 lần → 429 RATE_LIMITED + lockedUntil; đúng → 200 authenticated; (state BRUTE mutable — test dùng IP 'loopback', đếm fail có hồi phục bằng reset map qua từng case riêng → nên tách server instance mỗi describe hoặc key IP riêng).
  - OPTIONS → 405 CORS not enabled; `Sec-Fetch-Site: cross-site` trên /api/start → 403; Host header lạ (loopback bind) → 403 INVALID_HOST.
  - **PII**: regex trên whole body mình nhận được từ mọi endpoint: không chứa `test-tok123`, client_secret, `/^Bearer\s+[A-Za-z0-9._~+\/-]+/`, private key.
  - API root `/api/` → 404 API_ROOT.

### Phase 4 — Mutation (G2) mini-runner
- `run-mutants.ts`: cho từng target (sanitize, safe-fetch, community.hasPostPermission, bot-controller.isProfanityRejection, content-service.describeError, config-store.normalizeFieldValue), sinh mutant thủ công (định nghĩa trong `mutants-config.ts`: vị trí + bản thay thế), chạy test file tương ứng, đếm killed/lived. Score ≥ 60% toàn bộ, **0 live mutant critical** (target security được đánh cờ `critical` bắt buộc kill).
- Giới hạn: không dùng stryker (không dep mới) — chọn 8-12 mutant mỗi hàm critical, đủ chứng minh test bắt lỗi thật.

### Phase 5 — Scripts + verification
- Chạy `npm run test:wave5` đủ xanh 0 skip. Chạy `npx tsc --noEmit` vẫn exit 0 (source không đổi, test TS ở `strict:false` OK). Cập nhật status trong ASSURANCE (§trạng thái tổng, G1-G3, G5, G10).

## 5. Acceptance

- [ ] `npm run test:wave5` → pass, **0 skip, 0 todo**.
- [ ] Mọi request contract test nhận response có security headers; không secret nào lộ ra ngoài (PII assertion chạy trên toàn bộ response).
- [ ] `npm run test:mutation` → score ≥ 60%, 0 live mutant critical.
- [ ] `npx tsc --noEmit` exit 0 (không phá build).
- [ ] Không thêm dependency; `.env` thật và các file dữ liệu thật không bị đọc/ghi bởi test.
- [ ] ASSURANCE cập nhật trạng thái G1/G2/G3/G5/G10.

## 6. Risks

- Kiểm tra brute-force (429) cần reset state giữa cases → tách instance server hoặc isolate theo key IP.
- `node --test` thứ tự files độc lập (mỗi file child process riêng) → temp dirs theo tên file, không xung đột.
- startGuiServer cần close được → thêm `closeGuiServer()` (export nhỏ, không đổi API cũ).
- Không chạm `.env` thật: helper luôn tạo temp .env và set biến môi trường override.