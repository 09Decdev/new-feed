# Plan — news-poster: Bot đăng bài liên tục qua Gateway (production) — Google OAuth

> **Trạng thái: CHỜ APPROVE.** Theo GLOBAL RULE "No Code Without A Plan" (gateway-auth-service & content-service CLAUDE.md) + skill `/ck:plan`: KHÔNG viết code cho đến khi user approve plan này.
>
> **Cập nhật**: auth chuyển từ email/password sang **Google OAuth** (bot tự chạy OAuth → `login-google`) theo lựa chọn của user.

## 1. Mục tiêu

Mở rộng `news-poster/` (hiện là tool one-shot, static `AUTH_TOKEN`) thành **bot production** đăng bài liên tục, **đăng nhập bằng tài khoản Google của user**:
1. **Google OAuth bootstrap** (bot tự chạy authorization-code flow) → mint Google `id_token` → gọi `POST /auth/login-google` qua gateway → nhận platform `accessToken`/`refreshToken`.
2. **Refresh-token keepalive** (platform) để chạy dài hạn (>1h) không bị 401.
3. **Lấy/confirm community** + quyền `POST_CONTENT`/OWNER trước khi đăng.
4. **Đăng bài liên tục** từ RSS vào `COMMUNITY_ID` theo interval, có **dedup** + skip bài bị profanity reject.
5. Mọi credential/URL **env-driven** (user tự thay cho production, `.env` không commit).

Tool là **standalone TS** (native `fetch` + native `http` cho redirect server + native `crypto`) — KHÔNG thêm npm dependency, KHÔNG phải NestJS service. Các rule Hexagonal/DI/Prisma/Kafka/Redis của skill `cook` **N/A**; "dependencies" dưới đây là HTTP call qua gateway + Google OAuth endpoint.

## 2. Truth đã verify từ code (ground truth cho implementation)

### Google login (gateway-auth-service, port 3005, path `/auth/login-google`)
- `POST /auth/login-google` body `{ idToken, deviceInfo }`. DTO: [login.dto.ts:33-49](gateway-auth-service/src/infrastructure/driving-adapters/http-rest/dtos/login.dto.ts#L33).
- Service `loginWithGoogle` [auth-login.service.ts:156-265](gateway-auth-service/src/application/services/auth-login.service.ts#L156):
  - Với `deviceInfo.platform === 'web'` → dùng `process.env.GOOGLE_CLIENT_ID_WEB` làm Google audience; ngược lại fallback `process.env.GOOGLE_WEB_ID` (mobile). [auth-login.service.ts:162-163](gateway-auth-service/src/application/services/auth-login.service.ts#L162).
  - Gọi `verifyGoogleIdToken(idToken, googleClientId)`.
- `verifyGoogleIdToken` [verifyToken.ts:9-37](gateway-auth-service/src/infrastructure/oauth/verifyToken.ts#L9):
  - `effectiveClientId = clientId || process.env.GOOGLE_WEB_ID`.
  - `OAuth2Client.verifyIdToken({ idToken, audience: effectiveClientId })` → verify chữ ký + **audience BẮT BUỘC = `effectiveClientId`**.
  - Trả `{ email, name, picture, googleId(sub) }`.
- **Ràng buộc then chốt**: id_token bot mint phải có `aud` = `GOOGLE_CLIENT_ID_WEB` của platform. → Bot phải chạy Google OAuth với **đúng client ID** đó (cùng 1 Google OAuth Web client mà platform dùng).
- Nếu email đã có trên platform → `loginWithGoogleId` → trả platform `{ accessToken, refreshToken, firstLogin, authentic }` [auth-login.service.ts:182-249](gateway-auth-service/src/application/services/auth-login.service.ts#L182). Nếu chưa có → trả `{ register:true, registerToken, name, dateOfBirth }` → cần `register-social` 1 lần.

### Google OAuth (bên ngoài, Google endpoints)
- Authorization-code flow cho Web client (confidential — có secret):
  - Consent URL: `https://accounts.google.com/o/oauth2/v2/auth?...` với `client_id`, `redirect_uri`, `response_type=code`, `scope=openid email profile`, `access_type=offline`, `prompt=consent` (đảm bảo nhận refresh_token), `state` (random).
  - Token exchange: `POST https://oauth2.googleapis.com/token` body `{ code, client_id, client_secret, redirect_uri, grant_type=authorization_code }` → `{ access_token, id_token, refresh_token, expires_in }`.
  - Refresh (mint id_token mới): `POST https://oauth2.googleapis.com/token` body `{ grant_type:refresh_token, client_id, client_secret, refresh_token }` → `{ access_token, id_token (aud=client_id ✓), expires_in }`. id_token TTL ~1h.
- Web client không hỗ trợ device flow → phải có **redirect URI localhost** + local http server bắt code.

### Routing + token (gateway-auth-service)
- Route map [router.map.ts:7-47](gateway-auth-service/src/infrastructure/gateway/routing/router.map.ts#L7): `/content-service`, `/user-community` đều qua gateway. **content-service ở port 3004** (3001 là user-community-service). Default `CONTENT_SERVICE_URL=http://localhost:3001` trong news-poster hiện tại **sai/stale**.
- Gateway `@All('*')` decode JWT → inject `x-user-id`/`x-user-email` → forward qua NGINX: [gateway.service.ts:24-71](gateway-auth-service/src/application/services/gateway.service.ts#L24).
- **Quyết định**: tool gọi hết qua gateway port 3005 (`/auth/login-google`, `/auth/refresh-token`, `/content-service/*`, `/user-community/*`) với `Authorization: Bearer <platformAccessToken>`. 1 base URL.
- Platform access TTL = `ACCESS_TOKEN_EXPIRES || '1h'`; refresh = `7d`. Refresh `POST /auth/refresh-token { refreshToken }` (no auth header), trả cặp mới, RT cũ invalidate [auth-token.service.ts:36-111](gateway-auth-service/src/application/services/auth-token.service.ts#L36).

### Community & permission (user-community-service, proxy `/user-community/*`)
- List community của user: `GET /user-community/community-member/approved` → `string[]`. [communityMember.controller.ts:91-101](user-community-service/src/infrastructure/driving-adapters/http-rest/controllers/communityMember.controller.ts#L91).
- Quyền của mình: `GET /user-community/community-member/community/:id` → `{ role, communityPermission[] }`. [communityMember.controller.ts:215-234](user-community-service/src/infrastructure/driving-adapters/http-rest/controllers/communityMember.controller.ts#L215). Pass nếu `role==='OWNER'` hoặc có `POST_CONTENT`.
- `POST_CONTENT` enum: [permissions.constant.ts:13-22](user-community-service/src/application/constants/permissions.constant.ts#L13).

### Tạo bài (content-service, qua gateway `POST /content-service/post`)
- Controller [post.controller.ts:75-86](content-service/src/infrastructure/driving-adapters/http-rest/controllers/post.controller.ts#L75). Body `CreatePostDto`: [create-post.dto.ts](content-service/src/infrastructure/driving-adapters/http-rest/dtos/request/create-post.dto.ts) — `communityId`, `content` (≤100k), `layoutType` (CLASSIC/COLUMNS/FRAME), `fileIds?`, `publishedAt?`, `expiredInDays?`, `background?`.
- Gate (content-service `validateExternalResources`):
  - **Phone**: `!userData.phoneNumber` → `PhoneException`. [post.service.ts:149-155](content-service/src/core/services/post.service.ts#L149).
  - **Permission**: `role==='OWNER'` hoặc có `POST_CONTENT`, ngược lại `ForbiddenException`. [post.helper.ts:220-230](content-service/src/core/helper/post.helper.ts#L220), [post.helper.ts:391-397](content-service/src/core/helper/post.helper.ts#L391).

## 3. Điều kiện tiên quyết (user làm thủ công)

### Cho Google OAuth (one-time setup)
1. **Google Web client credentials**: user (chủ platform) cung cấp `GOOGLE_CLIENT_ID_WEB` + `GOOGLE_CLIENT_SECRET_WEB` (lấy từ Google Cloud Console cho cùng Web client mà gateway dùng). Đặt vào `.env` của bot.
2. **Redirect URI**: đăng ký `http://localhost:<GOOGLE_OAUTH_PORT>/callback` trong Google Cloud Console (Authorized redirect URIs) cho client đó. Đặt `GOOGLE_OAUTH_REDIRECT_URI` + `GOOGLE_OAUTH_PORT` trong `.env`.
3. **One-time consent**: chạy `--mode=setup` → bot in URL consent → user mở trình duyệt, đăng nhập Google, đồng ý → bot bắt code ở redirect → exchange → lưu `googleRefreshToken` vào session file. (OAuth client phải ở trạng thái "Production" hoặc Google account nằm trong test users.)
4. Nếu Google account **chưa có trên platform**: `login-google` đầu tiên trả `register:true` → chạy `register-social` 1 lần (cần `dateOfBirth`, `country`). Tool hỗ trợ `--mode=register-social` (optional) hoặc user đăng ký qua app.

### Cho đăng bài (gate content-service — Google login KHÔNG miễn)
5. **Verify SĐT** cho account: gateway `POST /auth/verify/phone-number/send-otp` + `verify-otp` (SMS OTP). Bắt buộc.
6. **Account phải là OWNER/có POST_CONTENT trong COMMUNITY_ID**:
   - Nếu Google account của user chính là **OWNER** community đích → quyền tự thoả, bỏ qua bước cấp quyền.
   - Nếu không → owner (nick chính) phải `POST /user-community/community-member-permission { communityMemberId, permissionName:['POST_CONTENT'] }` (OWNER-only). Tool in `communityMemberId` ở `--mode=setup`.
7. Account **KHÔNG bật 2FA** (giả định; nếu bật, login-google cũng trả `require2fa` → tool phải xử lý thêm, ngoài scope).
8. Bot join community: nếu account chưa phải member → `POST /user-community/join-request/community-public` (PUBLIC) hoặc `join-request` (PRIVATE + owner approve). [joinRequest.controller.ts:66-80](user-community-service/src/infrastructure/driving-adapters/http-rest/controllers/joinRequest.controller.ts#L66).
9. Đặt `GATEWAY_URL`, `COMMUNITY_ID`, RSS feed, interval, Google creds vào `.env` (production — user tự thay).

## 4. Cấu trúc file (news-poster/)

| File | Loại | Mục đích |
|---|---|---|
| `google-oauth.ts` | mới | `getGoogleAuthUrl()`, local http server `waitForRedirectCode(port)`, `exchangeCodeForTokens()`, `refreshGoogleIdToken()` (mint id_token mới từ googleRefreshToken). Native fetch + native `http` + native `crypto`. |
| `auth.client.ts` | mới | `loginWithGoogle(gatewayUrl, idToken, deviceInfo)` → `POST /auth/login-google`; `refreshPlatformToken()`; `ensurePlatformToken()` (refresh platform trước 1h); `bootstrapViaGoogle()` = refreshGoogleIdToken + loginWithGoogle (cold-start); `deviceInfo` fake ổn định (platform:'web'). |
| `session.ts` | mới | Persist `{ platformAccessToken, platformRefreshToken, platformAccessExpiresAt, googleRefreshToken }` ra `.session.json` (gitignore). |
| `community.client.ts` | mới | `listMyCommunities()`, `getMyMemberPermission(communityId)` → confirm POST_CONTENT/OWNER. |
| `content-service.client.ts` | sửa | Đổi base sang `GATEWAY_URL/content-service/post`, nhận platform token động. Giữ `describeError()`. |
| `dedup.ts` | mới | `posted.json` — `isPosted(key)`, `markPosted(key)` (key=hash link). |
| `rss.ts` | giữ | `fetchRssItems`/`buildContent`. |
| `poster.ts` | sửa | Mode mới: `--mode=setup` (Google consent + bootstrap + in communityMemberId), `--mode=run` (continuous). Giữ `test`/`rss` one-shot (boot qua Google nếu chưa session). |
| `.env.example` | sửa | `GATEWAY_URL`, `GOOGLE_CLIENT_ID_WEB`, `GOOGLE_CLIENT_SECRET_WEB`, `GOOGLE_OAUTH_REDIRECT_URI`, `GOOGLE_OAUTH_PORT`, `COMMUNITY_ID`, `LAYOUT_TYPE`, `RSS_FEED_URL`, `RSS_LIMIT_PER_CYCLE`, `POST_INTERVAL_MS`, `DRY_RUN`, `DEVICE_INSTALLATION_ID`, `DEVICE_FINGERPRINT`, `SESSION_FILE`. Bỏ `AUTH_TOKEN`/`BOT_PASSWORD`. |
| `README.md` | sửa | Setup Google OAuth + production guide. |
| `.gitignore` | sửa | `.session.json`, `posted.json`, `.env`. |

## 5. Phases (implement theo thứ tự)

### Phase 1 — Google OAuth + platform auth bootstrap
- `google-oauth.ts`:
  - `getGoogleAuthUrl(clientId, redirectUri, state)` — scope `openid email profile`, `access_type=offline`, `prompt=consent`, `response_type=code`.
  - `waitForRedirectCode(port)` — native `http` server trên `/callback`, resolve `{ code, state }`, tự đóng server sau khi bắt code. Timeout.
  - `exchangeCodeForTokens(code, clientId, clientSecret, redirectUri)` → `{ id_token, refresh_token, access_token, expires_in }`.
  - `refreshGoogleIdToken(refreshToken, clientId, clientSecret)` → `{ id_token, expires_in }`.
- `auth.client.ts`:
  - `loginWithGoogle(gatewayUrl, idToken, deviceInfo)` → platform `{ accessToken, refreshToken, ... }`.
  - `bootstrapViaGoogle(session, env)` — nếu có `googleRefreshToken` → `refreshGoogleIdToken` → `loginWithGoogle`; else throw (cần chạy `setup` trước).
  - `ensurePlatformToken(session, gatewayUrl)` — refresh platform token nếu access còn <5 phút; refresh fail → throw (buộc bootstrap lại qua Google).
  - `deviceInfo`: `installationId` (env `DEVICE_INSTALLATION_ID`, default UUID v4 cố định), `deviceFingerprint` (env, default 64-hex cố định), `platform:'web'`, `deviceName:'news-poster-bot'`.
- `session.ts`: load/save `.session.json`.
- File refs: [verifyToken.ts:9-37](gateway-auth-service/src/infrastructure/oauth/verifyToken.ts#L9), [auth-login.service.ts:156-265](gateway-auth-service/src/application/services/auth-login.service.ts#L156), [auth-token.service.ts:36-111](gateway-auth-service/src/application/services/auth-token.service.ts#L36).

### Phase 2 — Community client (pre-flight)
- `community.client.ts`: `getMyMemberPermission(gatewayUrl, token, communityId)` → `{ role, communityPermission }`. `hasPostContent(perm)`. `listMyCommunities()`.
- Pre-flight trước đăng: thiếu POST_CONTENT/OWNER → log + exit.
- File refs: [communityMember.controller.ts:215-234](user-community-service/src/infrastructure/driving-adapters/http-rest/controllers/communityMember.controller.ts#L215), [permissions.constant.ts:13-22](user-community-service/src/application/constants/permissions.constant.ts#L13).

### Phase 3 — Rewrite content-service client
- `createPost(gatewayUrl, token, input)` → `POST {gatewayUrl}/content-service/post` với Bearer. Body giữ nguyên. Giữ `describeError()`.
- Bỏ default `CONTENT_SERVICE_URL=http://localhost:3001`.
- File ref: [post.controller.ts:75-86](content-service/src/infrastructure/driving-adapters/http-rest/controllers/post.controller.ts#L75).

### Phase 4 — Dedup
- `dedup.ts`: `posted.json` = `[{ key, ts }]`. `isPosted(key)`, `markPosted(key)`. Rotate N=1000 gần nhất.

### Phase 5 — Setup mode + Continuous run (`poster.ts`)
- `--mode=setup`:
  1. Sinh state, in consent URL (user mở browser).
  2. `waitForRedirectCode(port)` → code.
  3. `exchangeCodeForTokens` → lưu `googleRefreshToken` vào session.
  4. `refreshGoogleIdToken` → id_token → `loginWithGoogle` → platform tokens → session.
  5. In `listMyCommunities()` + `communityMemberId` (cho owner cấp quyền nếu cần) + trạng thái POST_CONTENT/OWNER.
- `--mode=run`:
  1. Load session. Nếu không platform token → `bootstrapViaGoogle`.
  2. `ensurePlatformToken`.
  3. Pre-flight: `getMyMemberPermission(COMMUNITY_ID)` — thiếu → log + exit.
  4. Loop: ensurePlatformToken → fetchRSS(limit) → mỗi item: dedup→skip / buildContent→createPost; log ok/fail (profanity→skip+continue) → sleep(POST_INTERVAL_MS).
  5. Error: 401→refresh+retry; 403→permission lost→log+exit; 429→backoff; network→retry backoff.
  6. SIGINT/SIGTERM → persist session + exit.
- Giữ `--mode=test`/`--mode=rss` one-shot (boot qua Google nếu chưa session).

### Phase 6 — Config + docs
- `.env.example` (như §4). `POST_INTERVAL_MS` default 900000 (15ph), `RSS_LIMIT_PER_CYCLE=1`.
- `README.md`: setup Google OAuth (Google Cloud Console client + redirect URI), `--mode=setup` consent, prerequisites (phone/POST_CONTENT), `--mode=run` loop, cảnh báo profanity/rate-limit, DRY_RUN trước khi prod.
- `.gitignore`: `.session.json`, `posted.json`, `.env`.

### Phase 7 (optional) — register-social / register one-time
- Chỉ nếu Google account chưa có trên platform (login-google trả `register:true`).
- `--mode=register-social`: dùng `registerToken` từ login-google → `POST /auth/register-social { register_token, displayName?, dateOfBirth, country, deviceInfo }`.
- Verify field `register_token` vs `otp` ở implementation (đọc `register-social` DTO + service).

## 6. Acceptance Criteria

- [ ] `npm run setup` (mode=setup): consent Google → bot bắt code → exchange → lưu googleRefreshToken → login-google thành công → in platform tokens + communityMemberId + list community + trạng thái POST_CONTENT.
- [ ] `npm start` (mode=run): chạy liên tục >1h không 401 (platform refresh keepalive). Cold-start boot qua Google (refreshGoogleIdToken → login-google) hoạt động.
- [ ] Pre-flight chặn đăng khi thiếu POST_CONTENT/OWNER → log + exit (không spam 403).
- [ ] Đăng bài thành công qua gateway `POST /content-service/post` với Bearer động (platform token); 201 + post id.
- [ ] Dedup: chạy lại feed không tạo trùng link.
- [ ] Bài bị profanity reject → skip + log + tiếp tục.
- [ ] `POST_INTERVAL_MS` + `DRY_RUN` tuân thủ.
- [ ] Production: mọi credential/URL trong `.env`; `.session.json`/`posted.json`/`.env` gitignore; Google client secret chỉ ở trusted infra.
- [ ] Không thêm npm dependency (native fetch + http + crypto).
- [ ] SIGINT/SIGTERM thoát sạch, persist session.

## 7. Risks / Follow-up

- **Google client secret** trong `.env` bot: chấp nhận được trên trusted infra (user sở hữu platform + bot). `.env` gitignore.
- **Google refresh_token revoke**: nếu user revoke trong Google account, hoặc Google policy → bot không mint id_token được → re-run `--mode=setup` (consent lại). Dùng `prompt=consent` + `access_type=offline` để đảm bảo nhận refresh_token.
- **OAuth client status**: client phải "Production" hoặc Google account trong test users (Google Cloud Console) — else consent lỗi.
- **Audience constraint**: id_token `aud` phải = `GOOGLE_CLIENT_ID_WEB` của platform. Bot dùng đúng client đó → match. Nếu gateway dùng `GOOGLE_WEB_ID` (mobile) thay vì `GOOGLE_CLIENT_ID_WEB`, gửi `platform` khác → cần verify env thật ở prod.
- **Register-social field** (Phase 7): verify `register-social` DTO.
- **Profanity filter** reject tin nhạy cảm → feed an toàn (tech/sports/entertainment).
- **Rate limit** gateway (`JwtThrottlerGuard`+`EnforcementGuard`): `POST_INTERVAL_MS` hợp lý (≥ vài phút/bài).
- **2FA**: giả định account KHÔNG bật 2FA. Nếu bật → login-google trả `require2fa` (tempToken+OTP) → ngoài scope.
- **Platform refresh chain**: mỗi refresh trả RT mới 7d + invalidate RT cũ → chuỗi kéo dài vô hạn miễn refresh đều. Process chết >7d → bootstrap lại qua Google (googleRefreshToken).
- **Port note**: content-service ở 3004, nhưng tool qua gateway 3005 nên không đụng port trực tiếp.

## 8. Out of scope

- Ảnh đính kèm (upload-service fileId — v2).
- Đa feed / cron phức tạp (`setInterval` đủ cho "liên tục").
- Bypass profanity cho bot (sửa content-service, plan riêng).
- 2FA login flow.
- Device flow Google (web client không hỗ trợ).
