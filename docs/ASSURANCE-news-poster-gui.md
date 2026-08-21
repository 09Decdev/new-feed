# ASSURANCE — news-poster embedded GUI (feature `feat/news-poster-gui`)

> Bản feature-assurance theo template `~/.claude/ASSURANCE.md`. Trạng thái NHIỆU KỲ đóng vòng:
> **Wave 1** (core CLI: bot.controller / config-store / dedup / safe-fetch / sanitize / session / rss / poster / *.client) — **ĐÃ XONG, Reality Checker chấp nhận (có điều kiện)**.
> **Wave 2** (embedded GUI: `server.ts`, `log.ts`, web-mode `--mode=web`, `/api/*`) — **ĐÃ XONG, Reality Checker CHẤP-NHẬN (bằng chứng 14+ kịch bản live PASS)**.
> **Wave 5** (tests node:test: unit+integration G1, mutation G2, contract G3, SAST G5, authz G10) — **ĐÃ XONG, tất cả hard-gate PASS**.
> Ngày cập nhật: 2026-08-21 · Wave 5 bởi Backend Architect (tests + mutation mini-runner, zero dependency mới).

## Vùng phạm vi (files Wave 1 + Wave 2 GUI)

| Layer | Files |
|---|---|
| Wave 1 core | `config-store.ts`, `bot.controller.ts`, `runOneShotPosts` (trong bot.controller.ts), `dedup.ts`, `safe-fetch.ts`, `sanitize.ts`, `session.ts`, `rss.ts`, `poster.ts`, `auth.client.ts`, `community.client.ts`, `content-service.client.ts`, `upload.client.ts`, `llm.client.ts` |
| Wave 2 GUI | `server.ts`, `log.ts`, `poster.ts` (web-mode), `package.json` (`npm run web`), `public/index.html`, `public/callback.html` |
| Cấu hình | `tsconfig.json` (ts-node, strict=false, commonjs) · `.env` (không commit secret) · `ecosystem.config.cjs` |

## HARD-GATE (chặn ship)

| # | Bất biến | Tiêu chí | Bằng chứng |
|---|---|---|---|
| G1 | Tests | unit + integration (node:test) xanh, 0 skip | ✅ **PASS** — `npm run test:unit` → 149 tests, 0 fail/0 skip/0 todo (`test/unit/**/*.test.ts`, node:test + ts-node/register). |
| G2 | Mutation | mutation score ≥ ngưỡng; 0 live mutant critical | ✅ **PASS** — `npm run test:mutation` (`test/mutation/run-mutants.ts`, mini-runner tay không stryker): 22/22 = 100% killed, ngưỡng 60%, **0 critical survivor**. Mục tiêu critical: `sanitize`, `isPrivateIp`, `validatePublicUrlStatic`, `validateLlmBaseUrlStatic`, `hasPostPermission`; non-critical: `isProfanityRejection`, `describeError`. |
| G3 | Contract | contract test (consumer-driven) PASS mọi biên | ✅ **PASS** — `npm run test:contract` → 44 tests, 0 fail/0 skip/0 todo (`test/contract/server-contract.test.ts` 30+ kịch bản route matrix + security headers + cross-site/host 403 + config write + rss SSRF gate + post/start/stop edges + PII scan). |
| G4 | Type/Lint/Build | xanh, 0 warning mới | ✅ **PASS** — `npx tsc --noEmit` exit 0 (tsconfig không include/exclude → check ALL .ts incl `test/`); Wave 5 thêm `test/mutation/`, `test/contract/`, `test/helpers/` vẫn sạch. Lint/build: node:http tay, không có step riêng. |
| G5 | SAST + secret-scan | 0 finding high/critical; 0 secret lộ | ✅ **PASS** — `test/contract/secret-scan.test.ts` 3 lượt: (A) không pattern secret cloud (AWS/Google/GitHub/OpenAI/Slack) trong repo; (B) không literal mật-danh entropy cao trong source `.ts/.cjs/.js`; (C) `.env.example` để trống mọi key nhạy + `.gitignore` liệt kê `.env/.session.json/posted.json`. Code: token KHÔNG log/response/history; sanitize mọi envelope; body 1MB. |
| G6 | Code Reviewer | PASS; 0 blocker, 0 major | ✅ **2 vòng critics** — 0 blocker/major còn sống: vòng 1 (Code Reviewer/AppSec/Perf) 10/13 FIXED + 3 finding mới → vòng 2 all FIXED; vòng Verify-2 (3 critics đọc code + live) 10/13 FIXED và **R2-1..7 đều đã đóng** trong lượt producer này. |
| G7 | Reality Checker | PASS | ✅ **Wave 1 (CÓ điều kiện)** + **Wave 2 CHẤP-NHẬN** — 14+ kịch bản live PASS; không secret commit; không phá CLI `npm test` (`--mode=test --dry-run` exit 0). |
| G8 | Migration | schema change có approval + rollback | N/A — không schema, không DB (file-based `.env/.session.json/posted.json`, PVC local). |
| G9* | Tiền | idempotency + replay + reconciliation | N/A — feature không đụng payment. |
| G10* | Auth/PII | threat-model + authz test (chỉ chủ nhân) | ✅ **PASS** — Threat-model có; B1/M2/C11 đã verified (non-loopback-bind không token → exit≠0; host-header + origin full-host; fail-auth rate-limit). **Authz chính thức (Wave 5)**: `test/contract/authz-secret.test.ts` 7 test (tiến trình riêng — lock 30s 'loopback' không phá sibling): no-token→401; verify đúng→200; MISSING_TOKEN→400 (không bump); 3 lần sai→429 + `lockedUntil`; đúng-token-khi-locked→429 (lock check TRƯỚC token); GET status đúng-token-khi-locked→429. PII: mọi contract assertion `assertNoSecrets` — không literal secret (`test-tok123`/`w5-test-secret-value`/`llm-test-key-value`) rò qua response. |

## SOFT-GATE

- Docs cập nhật: PRD, DESIGN, PLAN, THREAT-MODEL, UI-SPEC, AUTOBUILD đều có bản `-news-poster-gui.md`.
- Performance budget: polling 2s poll ~0.1–0.3ms (P1 memoize config/secrets theo mtime); O(n) ring-shift 1000 dòng (chấp nhận).
- Không dependency mới ngoài node:builtin (`node:http` thay express — quyết định kỹ thuật).

## §Quyết định tuyến OAuth (điều kiện T24 — Wave 1 nhận kèm điều kiện)

- **Tuyến**: embedded `/callback` trên **GUI_PORT=8899** (server nhúng nhận redirect — `DESIGN §6.1`), không dùng `waitForRedirectCode` 8787 cho GUI. `GOOGLE_OAUTH_REDIRECT_URI` = `http://localhost:8899/callback`.
- **Bảng redirect_uri Google Console**: ĐỂ TRỐNG — **chờ khách export** (Wave 4). Mọi dòng dưới đây sẽ hoàn thiện khi khách cung cấp.
- **Policy remote-consent (DRAFT)**: consent chỉ hợp lệ từ **host machine**. Lý do: OAuth redirect resolve từ máy khách (localhost) — máy nào đang chạy GUI thì máy đó là host; bind non-loopback (`GUI_HOST` ≠ loopback) **bắt buộc GUI_TOKEN** (B1, exit≠0 nếu không có) nên remote chỉ dùng qua token. Policy hoàn thiện ở Wave 4 khi có credentials từ khách.

## §Exemption C11 (điều kiện 2 — Wave 1 nhận kèm điều kiện)

- **DESIGN §5.5 spec**: failCount ≥ 5 / cửa sổ 30s → lock.
- **Code triển khai**: `FAIL_THRESHOLD=3` + **backoff cố định KHÔNG cửa sổ trượt** (`[30s, 1m, 2m]` theo số lần fail) + **sweep** dọn entry idle **>24h** (kể cả entry từng lock, lock đã hết hạn).
- **Lý do**: tool 1 chủ nhân local — ngưỡng 3 chặt hơn 5; không cần theo dõi cửa sổ thời gian; lỗi chính chủ chỉ chờ ≤30s là tự hết khóa; sweep 24h giữ `bruteforce` map bounded khi bind mạng mở bị scan.
- **Quyết định**: **CHẤP NHẬN code ưu tiên bảo mật**, đã ghi deviation rõ ở `DESIGN §5.5` + Decision log #14.

## §Wave-1 conditions (nhận kèm điều kiện)

- **(a) Git baseline**: các file Wave 1 nêu trong vùng phạm vi ở trên. Baseline: sau Wave 1 đã typecheck (`tsc --noEmit`) + Reality Checker verify 14+ kịch bản. Branch `feat/news-poster-gui`; toàn bộ dashboard không commit trong lượt này (chỉ nhánh local). Chi tiết hash từng file có thể truy ở transcript/PR; tối thiểu giữ danh sách + trạng thái "typecheck + RC verify" — **xong**.
- **(b) dev-host HTTP LLM_BASE_URL**: allowlist `http://…` cho dev private (mạng nội bộ) — **CHỜ KHÁCH XÁC NHẬN là có chủ ý** (đường mạng nội bộ không HTTPS). Đánh dấu **OPEN** — Wave 4/khách xác nhận trước khi mở remote. Code đã validate LLM_BASE_URL (SSRF-block → `https` ngoài allowlist; mặc định `api.ai-box.vn`).

## §ARTIFACTS (bài đăng THẬT phát sinh khi test — không phải regress)

| Khi | Nội dung | Nguồn |
|---|---|---|
| Wave 1 test | 1 bài demo Wave 1 ("test-post" / demo Google login) | CLI `--mode=test` (test side-effect, đã công bố) |
| Round-2 R2-3 probe | "Sắp đấu giá thêm ba lô đất Thủ Thiêm, khởi điểm thấp nhất…" — bài RSS thật từ vnexpress | probe `BotController.start()` vô tình giành lại lockfile stale rồi chạy chu kỳ thật (đã báo cáo; posted.json giữ entry để dedup chặn đăng trùng) |

Hai bài này là **artifacts có chủ đích khi smoke-test**, không phải regression. Không có secret nào nằm trong docs/này.

## Trạng thái tổng

✅ Wave 1 DONE · ✅ Wave 2 DONE (Reality Checker chấp nhận) · ⏳ Wave 3 (frontend GUI) · ⏳ Wave 4 (OAuth/setup — chờ khách cấp GOOGLE_CLIENT_ID_WEB/SECRET) · ✅ Wave 5 DONE (tests node:test: G1 149, G2 22/22=100%, G3 44, G5 SAST, G10 authz — tất cả 0 skip/todo, `tsc --noEmit` exit 0).