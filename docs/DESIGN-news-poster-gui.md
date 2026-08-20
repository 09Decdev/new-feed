# DESIGN — Backend + API Contract cho Web GUI news-poster (v1)

**Trạng thái**: Design v1.1 — đã vá theo vòng phản biện chéo (2026-08-20, Decision log ở cuối) · **Ngày**: 2026-08-20 · **Tác giả**: Backend Architect
**Dùng làm chuẩn API contract cho**: T19 (API Tester), T5–T10/T22–T24 (Phase C), T16/T17 (Phase E). **Không** thiết kế UI chi tiết, **không** viết lại threat-model.

**Input đã đóng**: PRD FR-1..FR-8, §8, §10; PLAN «Quyết định của khách»; THREAT-MODEL P0 C1/C1b/C4/C5/C8/C9/C7/C12.

---

## 1. Kiến trúc tổng

**Quyết định kiến trúc**: server nhúng + 1 process (đúng PRD §8). Bot loop và GUI HTTP server chạy chung 1 process Node. `npm run web` mở GUI (bot ở `STOPPED`, chờ nút Start). `npm start`/PM2 giữ nguyên `mode=run` tự động chạy loop.

**Zero runtime dependency** (chỉ `node:http`, `node:fs`, `node:crypto`, `node:dns`, `node:path`, `node:events`). `node:test` chỉ dùng cho test (devDeps hiện có).

```
┌────────────────────────────────── news-poster (1 process, Node ≥18) ─────────────────────────────────┐
│                                                                                                       │
│ poster.ts  (entrypoint, giữ loadDotEnv/loadConfig/parseArgs)                                          │
│   ├─ mode=run        → BotController.start() rồi chờ SIGINT/SIGTERM → stop()      (CLI/PM2 — giữ nguyên)
│   ├─ mode=web        → server.ts lên + auto-openBrowser + BotController idle (STOPPED)
│   │                     · 0.0.0.0 không GUI_TOKEN → exit≠0 (TRƯỚC listen)
│   │                     · port bận → lỗi thân thiện, exit≠0
│   └─ mode=setup|test|rss|communities → giữ nguyên, chỉ đổi markPosted/saveSession sang atomic
│
│ ┌──────────────────────────── BotController (singleton — bot.controller.ts) ──────────────────────────┐
│ │ state: STOPPED → STARTING → RUNNING → STOPPING → STOPPED | ERROR                                   │
│ │ start():  acquire loop.lock → bootstrap token → pre-flight permission → RUNNING → loop              │
│ │ stop():   stopping=true + abort sleep → (nếu đang batch: chờ hết batch) → STOPPED → release lock  │
│ │ getStatus() / sự kiện typed (state-changed, entry-posted)                                          │
│ │ loop (mỗi cycle): reload config (T4) → refresh token → fetch RSS → dedup → scrape → rewrite → post  │
│ │                   → saveSession → abortableSleep(intervalMs)                                        │
│ └────────────┬─────────────────────────────────────────────────────────────────────────────────────────┘
│              │ start/stop/status/event · đọc config
│ ┌───────── config-store.ts ─────────┐   ┌──────────── log.ts (ring buffer 1000 + sanitize) ────────────┐
│ │ parse .env / serialize allowlist  │   │ wrap console.* → ghi stdout + ring {seq,level,ts,line}      │
│ │ toPublic() {set:true|false}       │   │ redact Bearer/x-api-key/giá trị secret                      │
│ │ reloadEnvAllowlist(non-secret)    │   └────────────▲─────────────────────────────────────────────────┘
│ │ atomicWrite (temp+flush+rename) ────────► dùng cho .env · posted.json · .session.json               │
│ └────────────┬──────────────────────┘                │
│              │ read/write                            │ server poll (GET /api/logs?since=)
│ ┌──────────── server.ts (GUI HTTP — node:http router tay) ──────────────┐   ┌────── safe-fetch.ts ──────┐
│ │ Bearer middleware (sha256+timingSafeEqual, precompute hash)           │   │ http(s) only; block        │
│ │ Host-header check khi bind loopback (chống DNS rebinding)             │   │ private/loopback/link-local│
│ │ Cross-site guard §4.4 trên POST state-changing (finding 3)            │   │ metadata; DNS re-check;    │
│ │ Router /api/* (contract §8) + static anonymous public/ + 404/405/413  │   │ redirect ≤3; timeout 5s;   │
│ │ Fail-auth rate-limit mọi route bị gate (§5.5) · CSP…, no CORS         │   │ size ≤2MB; host allowlist; │
│ │ OAuth route /callback (state single-use + TTL)                        │   │ validateBaseUrl (P0, f.2)  │
│ └────────────────────────────────────────────────────────────────────────┘   └────────▲─────────────┘
│                                           │                    rss.ts · bot.controller (fetchRssItems /
│ public/ (static GUI — ANONYMOUS, finding 11)                           fetchArticleBody / downloadImage — P0)
│   index.html · app.js · style.css (token form IN-PAGE, bỏ redirect)    │
│                                           │
│ Peers không đổi: rss.ts · google-oauth.ts · auth.client.ts · session.ts · community.client.ts        │
│                  content-service.client.ts · upload.client.ts · llm.client.ts · dedup.ts (mở rộng T2)│
└───────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Ánh xạ task → module** (để mỗi task biết chỗ implement):

| Task | Nơi code |
|---|---|
| T1 (BotController) | `bot.controller.ts` (mới), `poster.ts` (wrapper mỏng + signal handler mới); **wire loop fetchers qua `safeFetchUrl`** (`fetchRssItems`/`fetchArticleBody`/`downloadImage` — P0, finding 2) |
| T2 (history) | `dedup.ts` (extend `PostedEntry` + `listHistory` + markPosted dùng atomicWrite) |
| T3 (config-store) | `config-store.ts` (mới, kèm helper `atomicWrite` dùng chung) |
| T4 (reload chu kỳ kế tiếp) | `bot.controller.ts` đầu vòng loop; helper trong `config-store.ts` |
| T5 (server + static + mode web) | `server.ts` (mới), `poster.ts` (mode `web`), `package.json` (`"web"`), `public/` (placeholder) |
| T6 (log ring) | `log.ts` (mới) |
| T7 (status + history API) | `server.ts` routes; `bot.controller.ts.getStatus()`; `dedup.listHistory` |
| T8 (config/rss-preview/communities) | `server.ts` routes; `safe-fetch.ts` (mới, gồm `validateBaseUrl` — P0); tái dùng `rss.ts`/`community.client.ts`; wire `rss-preview` + loop fetchers qua safeFetchUrl (P0) |
| T9 (one-shot guard 409) | `server.ts` route `POST /api/post`; `modeOneShot` tái cấu trúc nhẹ thành `postOneShotHandler` |
| T10 (remote + Bearer) | `server.ts` middleware Bearer + **fail-auth rate-limit trên mọi route bị gate** + static ANONYMOUS + form token in-page (bỏ token.html/redirect) + cross-site guard no-token mode (finding 1/3/11) |
| T22 (start/stop API) | `server.ts` routes; `bot.controller.ts` |
| T23 (single-instance lock) | `bot.controller.ts` (acquire/release/probe); expose `lockHeldBy` |
| T24 (OAuth route contract) | đã chốt: embedded `/callback`; danh sách redirect_uri §6.4 |

---

## 2. State machine BotController

### 2.1 States & transitions

```
                    ┌────────────────────────────────┐
                    ▼                                │
  ┌─────────┐  start()1  ┌─────────┐   pre-flight   ┌─────────┐
  │ STOPPED │ ──────────► │ STARTING│ ───────OK────► │ RUNNING │
  └─────────┘             └────┬────┘                └────┬────┘
       ▲         start()       │ pre-flight fail/         │ stop()2  (hoặc stop() trong STARTING → STOPPING)
       │  loop-exit/stop-done  │ lock bận / bootstrap lỗi │ ▼
       │                       ▼                        ┌─────────┐
  ┌─────────┐              ┌─────────┐                  │ STOPPING│── làm nốt cycle hiện tại ─► (về STOPPED)
  │  ERROR  │ ◄──────────── │  ERROR  │                  └────┬────┘
  └─────────┘   (nếu có)    └─────────┘                       │
       │                        ▲                            │
       └────── start() ─────────┘◄── (start lại từ bất kỳ lỗi)
```

- `start()` từ `STOPPED`/`ERROR` → `STARTING`. Khi `STARTING/RUNNING/STOPPING` → **409** (guard T22/T9).
- `stop()` từ `RUNNING` (**hoặc `STARTING` để cancel pre-flight**) → `STOPPING`. Từ `STOPPING` → **409**; từ `STOPPED`/`ERROR` → **400**.
- `STARTING`: pre-flight (bootstrap token + `getMyMemberPermission` + `hasPostPermission`) → OK thì `RUNNING`; fail → `ERROR` kèm `errorMessage` (process vẫn sống).
- `RUNNING`: chỉ thoát về `STOPPED` khi loop kết thúc (stop request) hoặc lỗi không bắt được ở tầng vòng lặp → `ERROR`.
- `STOPPED`/`ERROR` là trạng thái ổn định; GUI thể hiện rõ phân biệt "đã dừng" vs "lỗi + message".

### 2.2 API

```ts
class BotController {
  start(): Promise<never> /* throw ApiError CONFLICT nếu sai trạng thái */
  stop(): void            /* throw ApiError CONFLICT nếu sai trạng thái */
  getStatus(): StatusSnapshot
  on(event: 'state'|'post'|'cycle', cb): void   // EventEmitter nhẹ (node:events)
  acquireLoopLock(): Promise<void>              // T23
  releaseLoopLock(): void                       // T23
  isLoopLocked(): Promise<{ held: boolean; pid?: number; stale?: boolean }>
}
```

`StatusSnapshot`:

```ts
interface StatusSnapshot {
  state: 'STOPPED'|'STARTING'|'RUNNING'|'STOPPING'|'ERROR';
  errorMessage?: string;            // khi ERROR — reason GỐC (mã/raw, dùng cho test/log)
  humanMessage?: string;            // tiếng Việt cho người dùng (map code→VN, fallback generic) — finding 5
  startedAt?: number; lastCycleAt?: number;
  cycleCount: number; postedToday: number;
  cycleProgress?: { done: number; total: number } | null;  // finding 7: item đang xử lý trong chu kỳ hiện tại (null khi không batch)
  lastPostResult?: { ok: boolean; title?: string; postId?: string; reason?: string; humanMessage?: string; ts: number };
  config: PublicConfig;             // toPublic() §3.3
  auth: AuthStatus;                 // §8.13
  lock: { held: boolean; lockHeldBy?: number; stale?: boolean };  // T23
}
```

### 2.3 Stop-giữa-sleep (đáp ứng Stop ≤5s — AC-2 PRD)

**Cơ chế: abortable sleep** dùng `AbortController`. Không dùng `sleep()` thô vì `sleep()` hiện tại (poster.ts:122) không bị ngắt bởi cờ.

```ts
// controller giữ:  private sleepAbort = new AbortController();

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); resolve(); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
```

**stop()** làm đúng 2 việc: gán `stoppingFlag = true` + `sleepAbort.abort()`.

Hai nhánh đều test được với `POST_INTERVAL_MS` nhỏ (VD 5s — runlist T21):

- **Stop khi đang NGỦ**: `abort()` → promise sleep resolve ngay → loop lặp `if (stoppingFlag) break` → cuối loop save session, emit STOPPED, release lock. Toàn bộ < 1s (không đo đạc thêm), thoải mái trong hạn 5s.
- **Stop khi đang GIỮA BATCH**: `stoppingFlag=true`, không abort tác vụ network đang treo. Vòng `for (const it of items)` đã có `if (stoppingFlag) break` ở đầu mỗi item (giữ nguyên như poster.ts:370) → item **đang xử lý** chạy đủ (post/ghi history), item kế tiếp bị bỏ, hết loop → break → STOPPED. Ngữ nghĩa "chờ hết chu kỳ hiện tại" được giữ y như SIGTERM cũ.
- **Báo tiến trình trong STOPPING (finding 7)**: controller cập nhật `cycleProgress {done,total}` mỗi khi xong 1 item (done = số item đã xử lý xong của batch hiện tại, total = số item chu kỳ). `GET /api/status` trong lúc STOPPING trả kèm `cycleProgress` + `humanMessage="Đang dừng — chờ hết item {done}/{total}…"` để GUI hiện "chờ hết item n/m" thay vì user tưởng treo. Bắt đầu chu kỳ mới: `{done:0,total:N}`; ngoài batch: `null`.
- **Stop trong `STARTING`**: gán `cancelled=true`; sau pre-flight, nếu cancelled → không vào `RUNNING`, emit `STOPPED` (và release lock nếu đã acquire). Trả về `{state:'STOPPING'}` ngay.

**Yêu cầu giữ VERBATIM từ `modeRun` cũ** (T1): refresh-on-401 đúng 1 lần; profanity re-rewrite tránh từ flagged retry ≤2; scrape fail → teaser `buildContent`; ảnh fail → text-only; `saveSession` mỗi cycle; cấu trúc try/catch per bước giữ nguyên; `process.on('SIGINT'/'SIGTERM')` → gọi `controller.stop()` (không `process.exit` ngay — để chu kỳ đóng sạch; sau khi `STOPPED` → process thoát tự nhiên vì không còn work).

### 2.4 Cấu trúc vòng lặp (pseudocode)

```ts
private async runLoop(): Promise<void> {
  try { await this.acquireLoopLock(); } catch (e) { this.setError(e.message); return; }
  this.swapConfig(this.configStore.load());          // T4: config áp dụng NGAY từ cycle này (mới start)
  let lastConfig = this.config;
  while (!this.stoppingFlag) {
    // T4: reload config từ .env mỗi cycle → config thay đổi hiệu lực từ CHU KỲ KẾ TIẾP
    try { this.swapConfig(this.configStore.load()); lastConfig = this.config; }
    catch { /* parse fail → giữ config đang dùng, log warning */ }

    const ok = await this.runOneCycle(this.config);  // 1 cycle: token→fetch→dedup→scrape→rewrite→post→saveSession
    if (!ok && this.fatal) { this.setError(...); return; }

    if (this.stoppingFlag) break;
    this.emitCycleDone();
    // Stop-giữa-sleep: await này resolve ngay khi stop() abort
    await abortableSleep(this.config.intervalMs, this.sleepAbort.signal);
  }
  try { saveSessionAtomic(this.config.sessionFile, this.session); } catch {}
  this.setState('STOPPED'); this.releaseLoopLock();
}
```

`runOneCycle` giữ nguyên từng bước của `modeRun` (bootstrap/refresh token per cycle; fetch RSS with `cfg.rssUrl`; per item: `hashKey` → `isPosted` → nếu đã đăng `[SKIP]`; scrape `fetchArticleBody`; rewrite; dryRun print; upload image; `postOne`; retry dance). Điểm mới duy nhất trong `runOneCycle` (T2): sau khi xử lý từng item, ghi entry lịch sử — **posted** (kèm postId), **failed** (ghi reason, **KHÔNG retry**), **skipped** (chỉ khi entry chưa tồn tại — xem §7).

---

## 3. Config-store (`config-store.ts`)

### 3.1 Schema Config (typed)

```ts
interface Config {
  gatewayUrl: string;           // GATEWAY_URL
  googleClientId: string;       // GOOGLE_CLIENT_ID_WEB            (không ghi qua GUI)
  googleClientSecret: string;   // GOOGLE_CLIENT_SECRET_WEB         (secret)
  googleRedirectUri: string;    // GOOGLE_OAUTH_REDIRECT_URI        (không ghi qua GUI)
  googlePort: number;           // GOOGLE_OAUTH_PORT                (không ghi qua GUI)
  communityId: string;          // COMMUNITY_ID
  layoutType: string;           // LAYOUT_TYPE
  rssUrl: string;               // RSS_FEED_URL
  rssLimit: number;             // RSS_LIMIT_PER_CYCLE
  intervalMs: number;           // POST_INTERVAL_MS
  dryRun: boolean;              // DRY_RUN
  sessionFile: string;          // SESSION_FILE                     (không ghi qua GUI)
  dedupFile: string;            // DEDUP_FILE                       (không ghi qua GUI)
  device: DeviceInfo;           // DEVICE_INSTALLATION_ID / DEVICE_FINGERPRINT (không ghi qua GUI)
  rewriteWithAi: boolean;       // REWRITE_WITH_AI
  llmBaseUrl: string;           // LLM_BASE_URL
  llmApiKey: string;            // LLM_API_KEY                      (secret)
  llmModel: string;             // LLM_MODEL
}
```

### 3.2 Allowlist ghi (qua GUI)

```
RSS_FEED_URL, RSS_LIMIT_PER_CYCLE, POST_INTERVAL_MS, COMMUNITY_ID, LAYOUT_TYPE, DRY_RUN,
REWRITE_WITH_AI, LLM_BASE_URL, LLM_MODEL,
LLM_API_KEY_SET, GOOGLE_CLIENT_SECRET_WEB_SET
```

- `POST /api/config` nhận field **thuộc allowlist ghi**. Field khác allowlist (kể cả `GATEWAY_URL`, `GOOGLE_CLIENT_ID_WEB`, `GOOGLE_OAUTH_REDIRECT_URI`, `GUI_*`, `SESSION_FILE`, `DEDUP_FILE`, `DEVICE_*`) → **reject 400** (threat model C5.2).
- Secret đặt lại qua field `…_SET` — **tri-state (CHỐT, finding 4)**:
  - **`_SET` vắng mặt** (key không có trong body) → **giữ nguyên** secret hiện tại. Đây là trường hợp mặc định khi form lưu mà user KHÔNG đụng tới ô secret — key không bị thay đổi/xóa.
  - `LLM_API_KEY_SET="abc"` → ghi `LLM_API_KEY=abc`.
  - `LLM_API_KEY_SET=""` (chuỗi rỗng) → **xóa hẳn** secret: dòng `LLM_API_KEY` bị loại khỏi file. Xóa chỉ xảy ra khi user CHỦ ĐỘNG bấm "Đặt lại" rồi để trống ô nhập mà lưu (caphNew explicit).
  - Ràng buộc GUI (T15/contract): ô secret không mở "Đặt lại" → form KHÔNG gửi key `*_SET` nào. Chỉ gửi `_SET` khi user mở ô nhập (giá trị mới hoặc rỗng = xóa).
  - Secret chỉ qua `_SET`; mọi response tuyệt đối không chứa giá trị secret.

### 3.3 Mask `toPublic()` (mọi GET config/status phải dùng hàm này)

```jsonc
{
  "RSS_FEED_URL": "https://vnexpress.net/rss/tin-moi-nhat.rss",
  "RSS_LIMIT_PER_CYCLE": 1,
  "POST_INTERVAL_MS": 900000,
  "COMMUNITY_ID": "…",
  "LAYOUT_TYPE": "CLASSIC",
  "DRY_RUN": false,
  "REWRITE_WITH_AI": true,
  "LLM_BASE_URL": "https://api.ai-box.vn",
  "LLM_MODEL": "deepseek-v4-flash[1m]",
  "GOOGLE_CLIENT_SECRET_WEB": { "set": true },
  "LLM_API_KEY": { "set": false },
  "GUI_HOST": "127.0.0.1",      // đọc-only hiển thị
  "GUI_PORT": 8899,
  "GUI_TOKEN": { "set": false } // chỉ "đã/chưa đặt"
}
```

Qui ước: giá trị thường trả thẳng; secret luôn là object `{ set: boolean }`; `GUI_TOKEN` cũng là `{set}` (không bao giờ trả giá trị — T10). `toPublic()` là **nguồn duy nhất** cho mọi route (T7/T8).

### 3.4 Parse/serialize `.env`

- Parse: dòng `KEY=VALUE`, trim, giải quote đơn/kép; giữ nguyên mọi dòng khác (comment `#`, dòng trắng, biến ngoài allowlist — không bao giờ xóa trừ khi `_SET=""`). **Round-trip: parse→write→parse giữ nguyên comment/dòng lạ** (T3.AC.1).
- Quotes: khi serialize, value chứa ký tự đặc biệt (khoảng trắng/`#`/quote) → wrap `"…"`.
- `load()` đọc thẳng file `.env` (KHÔNG qua `process.env`) → dùng cho `controller.swapConfig()`. Riêng trường hợp `GATEWAY_URL`/`GOOGLE_CLIENT_ID_WEB`/secret thiếu → controller giữ config cũ + log (KHÔNG `requireEnv`/`exit` trong đường GUI).

### 3.5 Atomic write (Windows-safe) — dùng chung cho `.env`, `posted.json`, `.session.json`

Qui tắc bắt buộc:
1. Ghi **temp file cùng thư mục** (cùng filesystem → `rename` nguyên tử).
2. `fh.sync()` (flush) TRƯỚC close (đảm bảo dữ liệu xuống đĩa).
3. `rename(tmp, target)` — trên Windows có thể EPERM/EBUSY khi file đang bị đọc/mở (AV scan, editor) → **retry ≤3 với backoff** (`50ms → 100ms → 200ms`); vẫn fail → ném lỗi, **file gốc bị để nguyên** (không bao giờ mở+truncate file đích).
4. Mọi lỗi đều dọn temp file (`unlink` best-effort).

```ts
// pseudocode — config-store.atomicWrite(file, content)
async function atomicWrite(file: string, content: string, opts = { retries: 3 }): Promise<void> {
  const dir = path.dirname(path.resolve(file));
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  for (let attempt = 1; attempt <= opts.retries; attempt++) {
    let fh;
    try {
      fh = await fs.promises.open(tmp, 'w');
      await fh.writeFile(content, 'utf8');
      await fh.sync();
      await fh.close(); fh = undefined;
      try {
        await fs.promises.rename(tmp, file);
        return;                              // thành công
      } catch (e) {
        if (attempt < opts.retries) { await sleep(50 * attempt); continue; }  // EPERM/EBUSY → thử lại
        throw e;
      }
    } catch (e) {
      if (fh) await fh.close().catch(() => {});
      await fs.promises.unlink(tmp).catch(() => {});   // luôn dọn temp
      if (attempt < opts.retries) { await sleep(50 * attempt); continue; }
      throw new Error(`atomicWrite fail ${file}: ${e.message}`);
    }
  }
}
```

- `markPosted` (T2) và `saveSession` (T18/atomic) chuyển sang dùng `atomicWrite` — phải xong sớm, trước khi tồn tại 2 writer (loop + one-shot) trên cùng file (R15).
- Stress 50 lần trên Windows → không `.tmp` tồn dư, file luôn là JSON hợp lệ (T3.AC.3).

### 3.6 Reload env allowlist cho `process.env` (T4)

Không dùng `loadDotEnv()` cũ (chỉ điền biến chưa có — R4). Helper mới:

```ts
// config-store.reloadEnvAllowlist(parsed, keys)
// Chỉ đồng bộ các key KHÔNG phải secret: RSS_FEED_URL, RSS_LIMIT_PER_CYCLE, POST_INTERVAL_MS,
// COMMUNITY_ID, LAYOUT_TYPE, DRY_RUN, REWRITE_WITH_AI, LLM_BASE_URL, LLM_MODEL
for (const k of keys) {
  if (parsed[k] !== undefined) process.env[k] = parsed[k];
}
```

- **Không** đồng bộ secret (T4.AC.3: secret nằm ngoài danh sách sync). Lý do: secret hiệu lực qua `activeConfig` (object) chứ không qua `process.env`; `auth.client` vẫn nhận `process.env` nhưng `GOOGLE_CLIENT_ID_WEB`/`GOOGLE_CLIENT_SECRET_WEB` không đổi trong chu kỳ chạy — chỉ thay đổi khi user ghi `*_SET` hoặc restart.
- Điểm neo duy nhất để secret mới có hiệu lực trong cùng process: **sau `POST /api/config` thành công, `config-store` re-parse .env và cập nhật process.env cho ĐÚNG key secret vừa thay đổi** (chỉ trigger khi user chủ động ghi; không phải reload tuần hoàn) → `GET /api/setup/start` + `/callback` exchange ngay chạy đúng secret mới (R5/T16 không lệch bản ghi cũ).

### 3.7 Áp dụng từ chu kỳ kế tiếp (semantics)

- Config đọc lại **đầu mỗi cycle** (§2.4 code: `swapConfig(configStore.load())`). `POST_INTERVAL_MS` mới dùng cho sleep của **đúng cycle sau khi reload**; `RSS_FEED_URL` mới cho fetch kế tiếp (T4.AC.1/2).
- GET /api/config/status phản ánh **config đang hiệu lực** (đã reload), không phải config trên form.
- Response `POST /api/config` ghi rõ `appliedAt: 'next-cycle'` để UI hiển thị "áp dụng từ chu kỳ kế tiếp" (FR-5.2).

---

## 4. HTTP server (`server.ts`)

### 4.1 Bind & startup quy tắc (T5)

- `GUI_HOST` (mặc định `127.0.0.1`) × `GUI_PORT` (mặc định `8899`).
- **Reject startup (exit≠0, thông báo rõ) TRƯỚC `listen`** khi `GUI_HOST=0.0.0.0` và `GUI_TOKEN` rỗng (C2/T5.AC.3). `GUI_TOKEN` phải tồn tại với (warn, không chặn) entropy ≥32 ký tự base64url (C11).
- `port` bận → `server.on('error', EADDRINUSE)` → log thân thiện `[web] Port 8899 is in use — another instance?` + `process.exit(1)` (không stacktrace thô).
- Khi bind loopback → **Host-header check** (C7, §5.4). Khi `0.0.0.0` → bỏ qua host check (Bearer đã gate).
- Auto `openBrowser(selfUrl)` (tái dùng `openBrowser` poster.ts:126); fail → in đường dẫn tay.
- Static `public/`: `index.html`, `app.js`, `style.css`. Không CDN, không template. (`token.html`/`token.js` bỏ — form token in-page theo finding 11; giữ lại tối đa như static cũ để bookmark cũ không 404.)

### 4.2 Router (tay, `node:http`)

- Bảng route duy nhất (có thể khai báo mảng hằng); traffic gồm: hop middleware (Bearer + Host check + security headers) → nếu `OPTIONS` → **405** (`{ok:false,code:'METHOD_NOT_ALLOWED',message:'CORS not enabled'}`) — không trả allow-origin → preflight fail = CSRF bị chặn (C7).
- Method không khớp route → `405`; path không khớp → `404` (`{ok:false,code:'NOT_FOUND'}`).
- Đọc JSON body có **giới hạn 1MB** (config/post), đọc streaming rồi parse; quá → `413 PAYLOAD_TOO_LARGE` (không nhồi memory).
- Trả JSON mọi API response `Content-Type: application/json; charset=utf-8`.

**Error envelope chuẩn (mọi lỗi API)**: `{ ok:false, code:string, message:string, retryable?:boolean }`

| HTTP | code | retryable | Dùng khi |
|---|---|---|---|
| 400 | `BAD_REQUEST` | false | body sai/thiếu field, unknown config field, sai định dạng URL |
| 400 | `INVALID_STATE` | true | `/callback` state sai/hết hạn/đã dùng |
| 400 | `BLOCKED_URL` | false | SSRF guard chặn (rss-preview/one-shot) |
| 401 | `UNAUTHORIZED` | false | thiếu/sai Bearer, sai GUI_TOKEN |
| 403 | `INVALID_HOST` | false | Host-header check fail (loopback) |
| 403 | `FORBIDDEN` | true | login-google `register` / thiếu quyền post / **cross-site request blocked (§4.4)** |
| 404 | `NOT_FOUND` | false | path lạ |
| 405 | `METHOD_NOT_ALLOWED` | false | method sai / OPTIONS |
| 409 | `CONFLICT` | true | start khi đang chạy, stop khi không chạy, post khi STARTING/RUNNING/STOPPING, lock bận |
| 413 | `PAYLOAD_TOO_LARGE` | false | body >1MB |
| 429 | `RATE_LIMITED` | true | rate limit verify/setup |
| 500 | `CONFIG_WRITE_FAILED` | false | ghi `.env` thất bại (atomicWrite) — §8.5 |
| 500 | `INTERNAL` | false | lỗi không biết (ẩn chi tiết, log đầy đủ) |
| 502 | `FETCH_RSS_FAILED` | true | lỗi fetch/parse RSS (rss-preview / one-shot) — §8.6, §8.8 |
| 502/503 | `UPSTREAM_ERROR` | true | gateway/RSS/LLM fail (map `describeError`) |

### 4.3 Security headers (mọi response — T5/C8)

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
                        img-src 'self' https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cache-Control: no-store            (API + index.html; app.js/style.css có thể no-cache ngắn)
```

- **KHÔNG** bất kỳ header `Access-Control-*` (C5/ C7).
- GUI lệnh cấm `innerHTML` là ràng buộc frontend (T11/T13/T14/T15), không nằm doc này; server chỉ cam kết headers + không bao giờ serve HTML do user/feed sinh ra tại API zone (regex check T19).

### 4.4 Cross-site guard trên state-changing POST (finding 3 — P0, bù lỗ hổng no-token local)

**Vấn đề**: Host-check (§5.4) chặn DNS-rebinding nhưng KHÔNG chặn trang web độc hại cùng máy gọi thẳng `http://127.0.0.1:8899` qua **direct-IP** (Host header vẫn là `127.0.0.1:8899` → pass host-check). Trong **no-token local mode**, `POST /api/start`/`stop`/`post`/`setup/start` không cần header `Authorization`, body rỗng hoặc form → **simple request** (không preflight) → start/stop bot trái phép từ 1 tab web xấu.

**Sửa (middleware, mọi `POST` state-changing: `/api/start`, `/api/stop`, `/api/post`, `/api/config`, `/api/setup/start`)**:

```ts
function crossSiteBlocked(req): boolean {
  // 1) Nếu có Origin: cho qua chỉ khi same-origin với GUI (so host + scheme, bỏ qua port khác biệt KHÔNG — so đầy đủ origin)
  if (req.headers.origin) {
    return new URL(req.headers.origin).host === req.headers.host;   // false → chặn
  }
  // 2) Không Origin (curl, tool, iframe document): dựa Sec-Fetch-Site
  const sfs = req.headers['sec-fetch-site'];
  if (sfs === 'cross-site') return true;          // chặn
  // same-origin / same-site / none → cho qua
  return false;
}
```

- Chặn → `403 {ok:false,code:'FORBIDDEN',message:'Cross-site request blocked'}` (không log secret).
- **No-token mode**: áp luôn (không có Bearer để dựa preflight). **Token mode**: `Authorization: Bearer` trên bất kỳ fetch cross-origin đều kích hoạt preflight; server không trả `Access-Control-Allow-Headers` → preflight fail → header không bao giờ được gửi → 401. Vì vậy ở token mode cross-site chỉ còn là defense-in-depth; middleware vẫn bật (phí không đáng kể) để chặn cả kịch bản attacker dùng form POST mà attacker site vẫn chèn được Sec-Fetch-Site vốn do browser đặt.
- **GET (read-only)** không cần guard riêng: đã bị SOP chặn đọc (không CORS) và không có tác dụng phụ.
- Lưu ý: browser gửi `Origin` trên mọi POST (kể cả same-origin form) ở các bản hiện đại → nhánh (1) đủ với trình duyệt chuẩn; nhánh (2) phủ tool/curl.

---

## 5. Auth middleware Bearer (T10 + C1/C1b/C7)

### 5.1 Kích hoạt

Auth bật khi: `GUI_TOKEN` đặt (`!= ''`), **hoặc** `GUI_HOST=0.0.0.0` (mọi trường hợp remote — bắt buộc). Nếu bind local và không token → không auth (1 user local, PRD FR-8).

### 5.2 So sánh timing-safe (P0)

```ts
import { createHash, timingSafeEqual } from 'node:crypto';
const sha256 = (s: string) => createHash('sha256').update(s).digest();
const expectedHash = GUI_TOKEN ? sha256(GUI_TOKEN) : null;      // precompute tại startup

function compareBearer(provided: string): boolean {
  if (expectedHash === null) return true;                        // không đặt token → không auth
  try {
    return timingSafeEqual(sha256(provided), expectedHash);      // so hash(hash) — chống timing oracle prefix
  } catch { return false; }
}
```

- Đọc token từ `Authorization: Bearer <token>` **chỉ trong header** (không cookie — xem C7: browser không tự gắn, CSRF giảm mạnh).
- Token **KHÔNG**: log, response body, URL, localStorage, browser history; chỉ hiển thị `guiTokenSet: boolean`. GUI giữ token trong memory hoặc sessionStorage (per-tab, mất khi đóng tab — Decision log #13).

### 5.3 Anonymous list (finding 11 — static ANONYMOUS; API anonymous tối thiểu)

```
Static (/, index.html, app.js, style.css)   → ANONYMOUS, KHÔNG gate Bearer (finding 11)
POST /api/auth/verify                        → anonymous (chỉ trả 200/401, không dữ liệu)
GET  /callback                               → bắt buộc anonymous — redirect cấp top-level từ Google KHÔNG gắn được Authorization header (R13)
Ngoài ra: MỌI route khác /api/*              → gate Bearer khi auth bật
```

- `GET /callback` response là **HTML tĩnh do server sinh** (không echo code/state/secret).
- **KHÔNG còn `token.html`/`token.js`**: form token nằm in-page trong `index.html` (§ thay thế T10.AC.6 cũ — xem Decision log #11). `token.html`/`token.js` có thể bỏ hẳn khỏi `public/` (nếu giữ file cũ chỉ để tương thích bookmark, vẫn serve anonymous như static).

**Quyết định hội đồng (finding 11 — static trở thành ANONYMOUS)**: **mọi static (`/`, `index.html`, `app.js`, `style.css`) serve ANONYMOUS, KHÔNG gate Bearer**. Chỉ **`/api/*`** bị gate. `index.html` onload gọi `GET /api/status`; nhận `401` → render **form nhập token IN-PAGE** (không redirect navigation — navigation không gắn được header, tránh deadlock "mãi token page"). Nhập đúng → giữ token trong memory (hoặc sessionStorage — xem Decision log #13) và re-render app. Không còn file `token.html`/`token.js` riêng (bỏ khỏi tree). `/callback` và `/api/auth/verify` vẫn anonymous (lý do C1b/§6).

### 5.4 Host-header check (chống DNS rebinding — C7, P0)

Khi `GUI_HOST` là loopback (`127.0.0.1`/`localhost`/`::1`/[::1]) — **bất kể có token hay không**:

```ts
function hostHeaderAllowed(host: string): boolean {
  try {
    const hostname = new URL('http://' + host).hostname.toLowerCase();  // xử lý đúng `[::1]:8899` — finding 12
    return ['127.0.0.1', 'localhost', '::1'].includes(hostname);
  } catch {
    return false;   // Host lạ/không parse → chặn
  }
}
```

- Host sai (`evil.example`) → `403 {ok:false,code:'INVALID_HOST'}` — chặn trang web độc hại gọi tới GUI local qua phản hồi Host giả.
- Khi `0.0.0.0` → bỏ qua (Host là IP/hostname thật của máy; Bearer đã gate).

### 5.5 Rate-limiting (C11 — fail-auth P0 trên mọi route bị gate)

In-memory per source IP — **đặt trong Bearer middleware, áp cho MỌI route bị gate (finding 1, blocker)**.
**Triển khai THỰC TẾ (Wave 2, đã verify)** — lệch với spec §5.5 gốc, xem rationale bên dưới + Decision log #14:
- **Fail-auth counter chung per-IP** (`bruteforce: Map<ip, {failures, lockedUntil, lastAt}>`): mỗi lần Bearer check thất bại trên bất kỳ route bị gate (mọi `/api/*` khi auth bật) → `failures++`, cập nhật `lastAt`. Khi `failures ≥ FAIL_THRESHOLD (3)` → `lockedUntil = now + backoff[clamp(failures-3, 0..2)]` với backoff hàm mũ `[30s, 1m, 2m]` — cố định theo số lần fail, KHÔNG cửa sổ trượt 30s. Trả `429 RATE_LIMITED` (retryable + `lockedUntil`) cho MỌI request tiếp theo của IP (dù route là GET/POST). **Success auth (Bearer đúng, kể cả `/api/auth/verify`) → xóa entry** (`clearFailures`).
- **Sweep bộ nhớ** (`sweepBrute`, M10/R2-6): evict entry idle >24h (không có activity mới), kể cả entry từng bị lock nhưng lock đã hết hạn; entry đang locked active được giữ → map bounded khi bind mạng mở bị scan.
- Chặn: attacker remote brute-force GUI_TOKEN qua GET/POST bất kỳ (trước đây mỗi route đều là 'oracle' 401). Khóa 30s đầu + backoff lũy thoái đủ làm chậm brute-force offline-grade.
- `POST /api/auth/verify`: dùng CHUNG counter Bearer (không tầng riêng) — đúng token xóa entry; sai → đếm như mọi route.
- `POST /api/setup/start`: giữ nguyên ≤6 lần/phút/IP (chống spam consent URL; reset khi thành công) — route này triển khai ở Wave 4.
- Lưu ý: trong no-token mode (local), không có auth để fail → counter không kích hoạt.

> **Rationale deviation (spec `failCount ≥ 5 / cửa sổ 30s` → code `FAIL_THRESHOLD=3` + backoff cố định, không window, sweep idle>24h)**: tool 1 chủ nhân chạy local, không cần cửa sổ thời gian phức tạp; ngưỡng 3 chặt hơn 5; lỗi chính chủ chỉ chờ ≤30s là tự hết khóa, không gây khó chủ nhân; bộ nhớ được giới hạn bằng sweep idle 24h — chấp nhận như **deviation ưu tiên bảo mật + đơn giản** (Decision log #14).

---

## 6. OAuth embedded `/callback` (T16, T24, C4/C10)

### 6.1 Quyết định tuyến (T24 đã chốt)

- **Embedded `/callback` trên `GUI_PORT`** (server nhúng nhận redirect). KHÔNG dùng `waitForRedirectCode` port 8787 cho GUI. Tuyến cũ `--mode=setup` CLI giữ nguyên (không phá).
- Đổi `GOOGLE_OAUTH_REDIRECT_URI` mặc định/mẫu thành `http://localhost:<GUI_PORT>/callback` (GUI_PORT mặc định 8899). Trong web-mode, server embed dùng URI này để tạo consent URL + exchange.

### 6.2 State single-use + TTL

```ts
// in-memory: Map<state, { expiresAt: number }>, cap ~50
const stateStore = new Map<string, number>();   // state → expiresAt (ms)
function issueState(): string {
  const state = newState();                      // randomBytes(16).hex
  stateStore.set(state, Date.now() + 600_000);   // TTL 10 phút
  prunestateStore();
  return state;
}
```

- `/callback` nhận `code` + `state`. Kiểm tra theo thứ tự: không có `state` → 400; `state` không nằm trong `stateStore` hoặc hết TTL → 400 (page lỗi thân thiện); **`stateStore.delete(state)` ngay khi kiểm tra** (single-use, chống replay). So khớp bằng `timingSafeEqual` trên chuỗi state (C10/ C1b).
- `code` **không** được exchange khi state fail. Exchange **server-side** bằng `client_secret` (credential nằm `.env`; code lộ không exchange được — T7 giảm rủi ro).

### 6.3 Flow

```
POST /api/setup/start  (Bearer, rate-limit)
  → state = issueState(); url = getGoogleAuthUrl(clientId, redirectUri, state)
  → { ok:true, data:{ url, state, expiresInSec:600,
                      noteRemote: (GUI_HOST==='0.0.0.0') ? 'OAuth phải thực hiện trên máy host (R10)...' : undefined } }

Browser → Google consent → 302 → GET /callback?code=…&state=…  (exempt Bearer)
  → validate state (single-use/TTL/timingSafeEqual)
  → tokens = exchangeCodeForTokens({code, clientId, clientSecret, redirectUri})       // từ activeConfig
  → platform = loginWithGoogle(gatewayUrl, tokens.id_token, device)                   // ném require2fa / register
  → saveSession(sessionFile, session)  (atomic) + ghi oauth.lastError = undefined
  → HTML 200: "Đăng nhập thành công — bạn có thể đóng tab này." (static, không echo code/state)
  catch require2fa  → HTML 400 card (self-contained, finding 6): "Tài khoản Google đang bật xác thực 2 bước (2FA) — bot chưa hỗ trợ đăng nhập với tài khoản 2FA. Hãy tắt xác thực 2 bước trong cài đặt Google (myaccount.google.com/security → Xác minh 2 bước → Tắt) rồi thử lại. Lưu ý: chỉ nên tắt tạm trong lúc đăng nhập và bật lại sau khi hoàn tất." <không chứa lệnh CLI/--mode=setup — North Star không đẩy user về terminal>
  catch register    → HTML 400 card: "Tài khoản Google chưa được đăng ký trên nền tảng. Đăng ký một lần qua app/social trước rồi thử lại."
  catch other       → HTML 400 card generic (không in message thô nếu chứa body lạ)
  (mọi lỗi đồng thời ghi oauth.lastError để GET /api/auth-status trả JSON cho GUI hiển thị — T16.AC.3; **lastOAuthError phải qua cùng bộ sanitize của log (§8.2) trước khi lưu/trả — finding 9**)
```

### 6.4 Danh sách redirect_uri phải đăng ký Google Console (T24 — xuất cho khách)

| Môi trường | Authorized redirect URI (đăng ký Console) |
|---|---|
| Local (mặc định) | `http://localhost:<GUI_PORT>/callback` (GUI_PORT = 8899) |
| Remote — host có domain/IP | `http://<hostname-hoặc-IP-thật>:<GUI_PORT>/callback` (phải thêm; console không nhận `localhost` của máy khách) |

**R10 (giới hạn bắt buộc minh bạch)**: khi `GUI_HOST=0.0.0.0`, browser máy KHÁCH redirect `localhost` về **chính nó**, không về máy host → consent từ máy khác vô hồi. **Setup OAuth phải thực hiện trên máy host** (browser của máy host dùng localhost, đúng URI). Không hứa OAuth remote-consent trong v1.

GATE-E: verify 1 consent flow thật với URI mới.

### 6.5 `POST /api/auth/verify` (trang nhập token)

- Body: hoặc `Authorization: Bearer <token>` header, hoặc JSON `{ "token": "<token>" }` (tiện cho trang nhập). Không body → 400.
- Đúng → `200 {ok:true, data:{authenticated:true}}`; sai → `401 {ok:false,code:'UNAUTHORIZED'}`. Không trả dữ liệu khác. Rate-limit §5.5.

---

## 7. Data model history (`dedup.ts`, T2)

### 7.1 Mở rộng `PostedEntry` (backward-compat)

```ts
interface PostedEntry {
  key: string;            // sha256(link || title) — KHÔNG ĐỔI (hashKey bất biến, dedup cũ vẫn khớp)
  ts: number;             // epoch ms
  title?: string;
  link?: string;
  postId?: string;        // khi status=posted
  status?: 'posted' | 'skipped' | 'failed';
  reason?: string;        // khi failed (describeError raw — máy đọc/test) / skipped
  humanMessage?: string;  // tiếng Việt cho người dùng (finding 5); null khi không lỗi
}
interface PostHistoryQuery { limit?: number; status?: 'posted' | 'skipped' | 'failed' }
function listHistory(file: string, q?: PostHistoryQuery): PostedEntry[]  // sort ts DESC, filter status, limit (mặc định 100, cap cứng 1000)
```

- Entry cũ `{key, ts}` đọc không throw; render `title/link/postId/status/reason = '—'` (threat: render bằng `textContent` — frontend).
- Cap cứng **1000** entry như hiện tại (cắt cuối theo ts).

### 7.2 Ghi entry từ vòng lặp

- **posted**: post OK (sau cả retry dance) → entry `{key,title,link,status:'posted',postId,ts}`. postId lấy từ response `/content-service/post` (`data.id || id`).
- **failed**: **mọi** thất bại sau túi retry (profanity hết lượt, 401 hết lượt, server 5xx, image/text-only vẫn fail) → entry `{key,title,link,status:'failed',reason:describeError(e),ts}`. **KHÔNG retry link đó ở cycle sau vì key đã tồn tại trong posted.json → `isPosted` chặn** (quyết định khách GATE 2, T2.AC.5 — ĐỔI hành vi so với poster.ts:401).
- **skipped**: item đã được post trước (isPosted trả true) → KHÔNG thêm entry mới mỗi cycle (tránh phình file ~1000 bản ghi thừa). Entry đã tồn tại giữ nguyên; `skipped` status chỉ xuất hiện khi một luồng one-shot post trùng link (modeOneShot) ghi entry `skipped` **nếu key chưa có** — đảm bảo không duplicate key.
- Cơ chế `markPosted(file, entry)`:
  1. `load(file)` (read file, parse).
  2. `existing = arr.find(e => e.key === entry.key)`.
  3. Nếu `existing` và status entry mới là `failed`/`posted` mà existing chưa có status (legacy `{key,ts}`) → merge bổ sung field (upgrade in place); không thêm bản ghi mới.
  4. Nếu không có existing → `arr.push(entry)`; cắt cap 1000.
  5. Ghi bằng `atomicWrite(file, JSON.stringify(arr, null, 2))` — **KHÔNG `writeFileSync`** (R15).

### 7.3 Đọc lịch sử

`GET /api/history` → `listHistory(file, {limit, status})`; nếu file lỗi parse → trả `[]` (không crash). Dữ liệu trả ra **không chứa bất kỳ secret** (chỉ title/link/postId/status/reason/humanMessage/ts).

---

## 8. API contract chi tiết (chuẩn cho T19)

Thời điểm "Bearer": có nghĩa — nếu auth bật → phải có `Authorization: Bearer <GUI_TOKEN>`. All times epoch ms. All responses masked, no secret, no token.

### 8.1 `GET /api/status`

```jsonc
// 200
{ "ok": true, "data": {
    "state": "RUNNING",                       // STOPPED|STARTING|RUNNING|STOPPING|ERROR
    "errorMessage": null,                     // reason gốc khi ERROR (máy đọc)
    "humanMessage": null,                     // tiếng Việt cho người dùng (finding 5); khi ERROR: "Lỗi chạy vòng lặp: <VN>"
    "startedAt": 1730000000000, "lastCycleAt": 1730000010000,
    "cycleCount": 12, "postedToday": 3,
    "cycleProgress": null,                    // {done,total} khi đang xử lý item (finding 7)
    "lastPostResult": { "ok": true, "title": "Bài viết…", "postId": "abc123", "reason": null, "humanMessage": null, "ts": 1730000010000 },
    "config": { /* toPublic() §3.3 */ },
    "auth": { /* AuthStatus §8.13 */ },
    "lock": { "held": true, "lockHeldBy": 12345, "stale": false }
} }
```
`postedToday` = đếm entry `status='posted'` có ts cùng ngày (local). T7.AC.1: status phản ánh ≤1s (cơ chế: event `state` → emit → route trả snapshot ngay từ controller).

### 8.2 `GET /api/logs?since=<seq>&filter=all|fail|skip`

```jsonc
// 200
{ "ok": true, "data": {
    "lines": [ { "seq": 12, "level": "info", "ts": 1730000000000, "message": "[news-poster] Cycle done…" } ],
    "firstSeq": 1, "lastSeq": 12, "reset": false
} }
```
- `since` bỏ → trả **1000 dòng gần nhất** (toàn buffer); `since=lastSeq` → 0 dòng + `lastSeq` không đổi (không gap/không trùng, T6.AC.3).
- `since < firstSeq` (bỏ sót do cap) → trả buffer + `reset:true` để GUI reset con trỏ (T20).
- Filter server-side theo prefix `[FAIL]` / `[SKIP]` / `[OK]` / `[DRY]`…; level từ `console.error→error`, `console.warn→warn`, còn lại `info`.
- Sanitize nội dung (C12): regex `/Bearer\s+\S+/i`, `x-api-key`, và chuỗi giá trị `GUI_TOKEN`/`LLM_API_KEY`/`GOOGLE_CLIENT_SECRET_WEB` đang nhớ — thay `[REDACTED]`.
- Poll 1000 dòng < 50ms là tầng dữ liệu; route chỉ slice (không IO đĩa).
- **`reset` / `source`**: sau khi restart process buffer rỗng → `firstSeq=0,lastSeq=0,reset=true`.

### 8.3 `GET /api/history?limit=100&status=posted|skipped|failed`

```jsonc
// 200
{ "ok": true, "data": {
    "entries": [ { "key": "ab…", "title": "…", "link": "https://…", "postId": "id1", "status": "posted", "reason": null, "humanMessage": null, "ts": 1730000000000 } ]
} }
```
- Entry legacy → `{key,ts,title:"—",link:"—",postId:"—",status:"posted",reason:"—",humanMessage:"—"}`.
- Dữ liệu sort `ts` DESC; `limit` mặc định 100, max 1000; cap file 1000.

### 8.4 `GET /api/config`

```jsonc
// 200
{ "ok": true, "data": { /* toPublic() §3.3 — secret = {set} */ } }
```

### 8.5 `POST /api/config`

Request body — **chỉ allowlist ghi (§3.2)**:

```jsonc
{
  "RSS_FEED_URL": "https://vnexpress.net/rss/tin-moi-nhat.rss",
  "POST_INTERVAL_MS": 1800000,
  "COMMUNITY_ID": "comm-1",
  "LAYOUT_TYPE": "CLASSIC",
  "DRY_RUN": false,
  "LLM_BASE_URL": "https://api.ai-box.vn",
  "LLM_MODEL": "deepseek-v4-flash[1m]",
  "LLM_API_KEY_SET": "sk-…",           // tri-state: vắng mặt = giữ; "abc" = ghi mới; "" = XÓA secret (finding 4)
  "GOOGLE_CLIENT_SECRET_WEB_SET": ""     // "" = xóa — chỉ xảy ra khi user chủ động mở "Đặt lại" + lưu trống
}
```

- Mọi key ≠ allowlist → `400 {ok:false,code:'BAD_REQUEST',message:'Unknown config field: GATEWAY_URL'}` (C5.2).
- Validate giá trị: `RSS_LIMIT_PER_CYCLE`/`POST_INTERVAL_MS` là số >0; `DRY_RUN` boolean; `LLM_BASE_URL` nếu set → phải `https://` + non-private (**P0, finding 2** — dùng `safeFetchUrl.validateBaseUrl`, chặn kênh exfil key); URL feed không đổi ngay (không gọi network trong POST — preview là chuyện riêng).
- Ghi atomic `.env` → thành công:
```jsonc
// 200
{ "ok": true, "data": { "appliedAt": "next-cycle", "written": ["RSS_FEED_URL", "POST_INTERVAL_MS"], "deleted": ["GOOGLE_CLIENT_SECRET_WEB"] } }
```
- Keys có `_SET` vắng mặt (user không đụng secret) → KHÔNG xuất hiện trong `written`/`deleted`; giá trị được giữ nguyên (finding 4).
- Ghi fail (atomicWrite ném) → `500 {ok:false,code:'CONFIG_WRITE_FAILED',message:'Không ghi được tệp cấu hình.',humanMessage:'Không ghi được tệp cấu hình. Kiểm tra quyền ghi tệp.',retryable:false}` — file gốc nguyên vẹn. (Validate input vẫn `400 VALIDATION_ERROR`; phân biệt bằng tag `code='CONFIG_WRITE_FAILED'` ở lớp ghi.)
- Sau ghi: reparse + nếu có `*_SET` thì sync đúng secret đó lên process.env (chỉ khi bị đổi) + `controller.swapConfig` (để status phản ánh ngay; thực thi thật ở cycle kế).

### 8.6 `GET /api/rss-preview?url=<url>&limit=<n>` (T8 — SSRF vector chính, C9)

- Bắt buộc qua `safeFetchUrl` (§9). Query `url` decode chuẩn (không manual string concat).
```jsonc
// 200
{ "ok": true, "data": {
    "items": [ { "title": "…", "link": "https://…", "description": "…", "pubDate": "…", "imageUrl": "…" } ],
    "preview": { "index": 0, "title": "…", "content": "tiêu đề\n\n…mô tả/teaser THÔ từ item đầu tiên…" }
} }
```
- **`preview.content` = teaser THÔ (title + description/summary item, CẮT ~200 từ), KHÔNG chạy LLM** (finding 8): xem feed không được phát sinh chi phí/gọi rewrite. Nội dung CUỐI (rewrite/LLM) chỉ xuất hiện ở `POST /api/post {dryRun:true}` — dry-run là nơi user thấy bài cuối trước khi đăng. UI (nút "Kiểm tra feed") dùng `rss-preview`; modal "Đăng thử" dùng `POST /api/post dryRun` (§8.8) — 2 vùng khác nhau, không lẫn.
- SSRF block → `400 {ok:false,code:'BLOCKED_URL',message:'URL resolves to a private/loopback address'}` (KHÔNG echo URL gốc — C5.3, có thể chứa query token feed trả phí; chỉ in host đã mask).
- Lỗi fetch → `502 {ok:false,code:'FETCH_RSS_FAILED',message:'Không tải được feed RSS.',humanMessage:'Không tải được feed RSS. Kiểm tra URL/mạng hoặc URL bị chặn.',retryable:true}`; parse RSS 0 item → `{ok:true,data:{items:[],preview:null}}`.
- `limit` mặc định = `RSS_LIMIT_PER_CYCLE` (≤50).

### 8.7 `GET /api/communities`

```jsonc
// 200
{ "ok": true, "data": { "communities": [ { "id": "comm-1", "name": "Cộng đồng A", "role": "OWNER", "canPost": true } ] } }
```
- Tái dùng `listMyCommunities` + `getCommunityDetail` + `getMyMemberPermission` + `hasPostPermission`. Lỗi auth/platform → `401/502` mapped (không RAW body). Role `'?'` nếu không fetch được; `canPost=false`.

### 8.8 `POST /api/post` (one-shot, T9)

Request:
```jsonc
{ "mode": "test",  "content": "…text…",  "dryRun": false }          // test post
{ "mode": "rss",   "rssUrl": "https://…", "limit": 2, "dryRun": true } // RSS one-shot (rssUrl mặc định RSS_FEED_URL)
```

- **Guard 409**: bot ở `STARTING|RUNNING|STOPPING` → `409 {ok:false,code:'CONFLICT',message:'Bot đang <state> — dừng chờ cuối chu kỳ để post one-shot',retryable:true}` (R15: tránh 2 writer posted.json).
- `dryRun=true` → không gọi gateway/upload; trả preview:
```jsonc
// 200
{ "ok": true, "data": { "mode":"rss", "dryRun": true,
    "previews": [ { "title":"…", "content":"…" } ] } }
```
- `dryRun=false` (hoặc bỏ) → thực post; tái cấu trúc `modeOneShot` thành hàm handler dùng chung:
```jsonc
// 200 (mỗi item được ghi vào history qua markPosted)
{ "ok": true, "data": { "mode":"rss", "dryRun": false,
    "results": [ { "title":"…", "ok": true, "postId":"id1", "reason": null, "humanMessage": null },
                 { "title":"…", "ok": false, "reason":"PROFANITY_REJECTED (words: đánh)", "humanMessage":"Bài viết bị từ chối do chứa từ vi phạm." } ] } }
```
- **`humanMessage` (finding 5)**: message tiếng Việt cho người dùng cho từng kết quả (map code→VN, fallback generic "Không đăng được bài: <code>"); `reason` giữ raw cho test/contract T19.
- Link một-shot `rssUrl` cũng phải qua `safeFetchUrl` (C9 — user chủ động nhưng GUI là bề mặt SSRF).
- Tham số `rssUrl`/`content`/`limit`/`dryRun` không validate được → 400.

### 8.9 `POST /api/start` (T22)

```jsonc
// 200 — request không cần body
{ "ok": true, "data": { "state": "STARTING" } }
```
- **Guard 409** khi `STARTING|RUNNING|STOPPING`: `{ok:false,code:'CONFLICT',message:'Bot đang <state>',retryable:true}`.
- Pre-flight fail → **không** 200 mà `502 {ok:false,code:'FORBIDDEN',message:'Không có quyền POST_CONTENT…' ,retryable:true}` + state → `ERROR` (process sống). Lock bận → `409 {ok:false,code:'CONFLICT',message:'Đã có vòng lặp khác chạy (pid N). Tắt nó trước khi Start.',retryable:true}`.
- `RUNNING` đạt ≤3s sau Start từ STOPPED (thoả AC-2) — đo bằng status poll.

### 8.10 `POST /api/stop` (T22)

```jsonc
// 200
{ "ok": true, "data": { "state": "STOPPING" } }
```
- Từ `RUNNING`/`STARTING` → `STOPPING`; từ `STOPPING` → `409 CONFLICT`; từ `STOPPED`/`ERROR` → `400 {ok:false,code:'BAD_REQUEST',message:'Bot đang STOPPED'} `.
- Sau Stop → status poll `STOPPED` ≤5s (abortable sleep §2.3).

### 8.11 `POST /api/setup/start` (T16)

```jsonc
// 200
{ "ok": true, "data": {
    "url": "https://accounts.google.com/o/oauth2/v2/auth?client_id=…&redirect_uri=http://localhost:8899/callback&…",
    "state": "a1b2…", "expiresInSec": 600,
    "noteRemote": "GUI_HOST=0.0.0.0 — OAuth phải được thực hiện trên máy host (R10)." // chỉ khi remote
} }
```
- Rate-limited §5.5; thiếu `GOOGLE_CLIENT_ID_WEB`/secret → `400` với hướng dẫn.

### 8.12 `GET /callback?code=…&state=…` (exempt, HTML)

- 200 HTML success / 400 HTML error card (không echo code/state/secret). Không phải JSON — top-level redirect của browser.
- Không có state → 400. State đã dùng/hết hạn → 400.

### 8.13 `GET /api/auth-status`

```jsonc
// 200
{ "ok": true, "data": {
    "hasSession": true,                       // có token platform hoặc googleRefresh trong .session.json
    "accessExpiresAt": 1730003600000,         // ms | null
    "hasGoogleRefresh": true,
    "communityPermission": { "communityId": "comm-1", "role": "OWNER", "canPost": true }, // null nếu chưa
    "lastOAuthError": null,                   // bản đồ lỗi 2FA/register/other → message tiếng Việt (T16.AC.3); PHẢI qua sanitize log (§8.2) trước khi lưu/trả — finding 9
    "guiTokenSet": true                       // "đã/chưa đặt", KHÔNG giá trị (T10)
} }
```
- Không bắt buộc gọi network: đọc `session.ts` + `decodeJwtExp`; `communityPermission` fetch qua `getMyMemberPermission` (thất bại → null, không 500).

### 8.14 Static & misc

| Route | Ghi chú |
|---|---|
| `GET /` `GET /app.js` `GET /style.css` | **ANONYMOUS** (finding 11): serve file thô, KHÔNG gate Bearer. Lệnh cấm XSS + render bằng `textContent` nằm ở frontend (T11–T15) — server chỉ serve tĩnh. |
| Form token | In-page trong `index.html` (onload → `GET /api/status`; 401 → hiện form; đúng → reload app). KHÔNG navigation redirect, KHÔNG file `token.html` riêng. |
| `GET /callback` | **anonymous** (bắt buộc R13) — HTML tĩnh server sinh, không echo code/state/secret. |
| `POST /api/auth/verify` | **anonymous** — chỉ trả `200 {ok:true,data:{authenticated:true}}` hoặc `401`. |
| `GET /favicon.ico` | `204` im lặng (tránh 404 ồn) |
| khác | `404` JSON |
| Mọi `POST` state-changing | Cross-site guard §4.4 (403 khi Origin/Sec-Fetch-Site cross-site) — kể cả no-token mode. |

### 8.15 Bảng tóm tắt endpoints

| Method | Path | Auth | Req body | Resp 2xx |
|---|---|---|---|---|
| GET | `/` `/app.js` `/style.css` | anonymous | – | tĩnh |
| GET | `/callback` | anonymous | – | HTML |
| POST | `/api/auth/verify` | anonymous | `{token}` | `{ok,data:{authenticated}}` |
| GET | `/api/status` | Bearer | – | §8.1 |
| GET | `/api/logs` | Bearer | – | §8.2 |
| GET | `/api/history` | Bearer | – | §8.3 |
| GET | `/api/config` | Bearer | – | §8.4 |
| POST | `/api/config` | Bearer + §4.4 | allowlist fields | §8.5 |
| GET | `/api/rss-preview` | Bearer | – | §8.6 |
| GET | `/api/communities` | Bearer | – | §8.7 |
| POST | `/api/post` | Bearer + §4.4 | `{mode,content?,rssUrl?,limit?,dryRun?}` | §8.8 |
| POST | `/api/start` | Bearer + §4.4 | – | §8.9 |
| POST | `/api/stop` | Bearer + §4.4 | – | §8.10 |
| POST | `/api/setup/start` | Bearer + §4.4 | – | §8.11 |
| GET | `/api/auth-status` | Bearer | – | §8.13 |
| – | unknown/OPTIONS | – | – | 404/405 |

\* **anonymous** = serve không cần token (mọi chế độ); **Bearer** = khi auth bật (token đặt hoặc `0.0.0.0`), thiếu/sai → 401 + fail-auth rate-limit §5.5; **§4.4** = cross-site guard trên POST state-changing.

---

## 9. `safeFetchUrl` — helper chống SSRF (C9, P0)

Module `safe-fetch.ts`, một helper dùng chung như threat-model yêu cầu. Default-deny.

```ts
interface SafeFetchOptions {
  method?: 'GET'|'POST'; headers?: Record<string,string>; body?: string;
  timeoutMs?: number;        // mặc định 5000
  maxBytes?: number;         // mặc định 2MB
  maxRedirects?: number;     // mặc định 3
  hostAllowlist?: string[];  // tùy chọn (exact hostname hoặc suffix '.')
  allowPrivate?: boolean;    // mặc định false; bật khi GUI_ALLOW_PRIVATE_FETCH=true (kèm warn log)
}
async function safeFetchUrl(urlStr: string, opts?: SafeFetchOptions): Promise<SafeResponse>
interface SafeResponse { ok: boolean; status: number; headers: Headers; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }
```

### 9.1 Kiểm tra (thứ tự)

1. **Scheme**: chỉ `http`/`https` → `data:`/`file:`/`ftp:`/`gopher:`… `BLOCKED_URL`.
2. **Host cấm tuyệt đối** (kể cả literal): `localhost`, `127.0.0.0/8`, `::1`, `0.0.0.0`, `10/8`, `172.16/12` (đến 172.31), `192.168/16`, `169.254.0.0/16` (gồm metadata `169.254.169.254`), `100.64/10` (CGNAT, chặn), `::ffff:` (IPv4-mapped), `fe80::/10` (link-local v6), `fc00::/7` (ULA v6).
3. **DNS re-check**: `dns.lookup(hostname, { all: true, verbatim: true })` → lấy **mọi** address; nếu **bất kỳ** address nào rơi vào dải trên → `BLOCKED_URL` (không dựa hostname string — chặn `foo.127.0.0.1.nip.io`, `[::1]`, CNAME trỏ private).
4. **Host allowlist** (nếu opts có): `hostname` phải nằm trong list hoặc kết thúc `.<item>`.
5. **Redirect**: follow thủ công ≤3 hop; mỗi hop **lặp lại bước 1–4** với URL mới; quá → `BLOCKED_URL` (`redirect too long`) hoặc dừng.
6. **Timeout**: `AbortSignal.timeout(timeoutMs)` cho cả connect+read.
7. **Size cap**: đọc stream chunk; tổng vượt `maxBytes` → abort + throw `PAYLOAD_TOO_LARGE`.
8. `allowPrivate` (opt-out qua `GUI_ALLOW_PRIVATE_FETCH=true`) → bỏ block private IP nhưng **vẫn log 1 cảnh báo** mỗi lần dùng; dùng khi chính chủ feed nội bộ (threat C9.6).

### 9.2 Wire vào

| Call site | Vòng nào | Trạng thái |
|---|---|---|
| `GET /api/rss-preview` (T8) | GUI | **BẮT BUỘC (P0)** |
| `POST /api/post mode=rss` (rssUrl user nhập) | GUI | **BẮT BUỘC** |
| `fetchRssItems(feedUrl)` (rss.ts) | loop + preview | **BẮT BUỘC (P0, finding 2)** — UI-SPEC/THREAT-MODEL xếp Cao: feed chạy mỗi chu kỳ KHÔNG cần GUI/token, là input địch. Chuyển sang `safeFetchUrl` (giữ param `fetchImpl` injectable để test T18); `allowPrivate` đọc từ env flag |
| `fetchArticleBody(link)` (rss.ts) | loop | **BẮT BUỘC (P0)** — feed độc hại nhét internal link, SSRF chạy ngầm giữa chu kỳ |
| `downloadImage(imageUrl)` (bot.controller/poster) | loop | **BẮT BUỘC (P0)** — imageUrl từ feed, cùng lý do |
| `LLM_BASE_URL` — validate **khi khởi động** (poster.ts mode run/web, trước loop/listen) | startup | **BẮT BUỘC (P0, finding 2)** — nếu `LLM_BASE_URL` không `https://` hoặc resolve về private/loopback → warn rõ + **KHÔNG khởi động loop** (exit≠0 cho mode run/CLI; web vẫn mở GUI nhưng start() trả 400/ERROR kèm message) — chặn kênh exfil LLM_API_KEY (C6/T4) |
| `LLM_BASE_URL` — validate lúc ghi config | GUI | **BẮT BUỘC (P0)** — `https` + non-private (đã cập nhật §8.5) |

**Ảnh hưởng task (finding 2)**: `safe-fetch.ts` + `validateBaseUrl` → **T8**; wire loop fetchers (`fetchRssItems`/`fetchArticleBody`/`downloadImage`) → **T1/T4** (phần loop trong `bot.controller` + `rss.ts`); validate `LLM_BASE_URL` lúc startup → **T4** (config-load/khởi động) + **T9** (one-shot không đăng lệch URL); AC tương ứng bổ sung vào T1/T4/T8 (thêm dòng trong bảng ánh xạ §1).

Lưu ý thời điểm: một feed nội bộ hợp lệ (VD VnExpress mirror trên LAN) sẽ bị chặn — đúng mặc định; dùng `GUI_ALLOW_PRIVATE_FETCH=true`.

---

## 10. Rủi ro + trade-off

| Trade-off / Rủi ro | Lựa chọn | Lý do + Mitigation |
|---|---|---|
| **Polling 2s vs SSE/WebSocket** | **Polling 2s** (logs + status) | Đúng locus PRD §8: 1 user, độ trễ chấp nhận 2s, 0 dependency, reconnect đơn giản (`since` monotonic + `reset`). SSE = enhancement v2 (vẫn dùng chung ring buffer). Rủi ro: 2 req/2s rất nhỏ trên node:http; không ảnh hưởng loop (route chỉ slice buffer). |
| **Single-instance lock (T23) — stale pid lockfile** | Lockfile `loop.lock` ghi **`{pid, startedAt, ppid?}`** (finding 10); acquire dùng `open('wx')` (chống race 2 process cùng giành); nếu tồn có pid + `isAlive(pid)` → giữ; pid chết → stale → xóa + thử lại ('wx' lại). Stale-detect khi `isAlive=true`: **so process start time** nếu lấy được trên Windows, nếu không → dùng `ppid` cross-check (so với parent hiện hữu) + age heuristic (lock >7 ngày → stale, kèm warning). `release` khi stop/process-exit (best-effort). | Rủi ro chính: **PID reuse** sau crash → tưởng lock còn sống (chặn Start). Mitigation v1: ghi `startedAt` + (khi làm được) so `creation time` của PID hiện tại với `startedAt` — lệch → khác process → stale. **Hạn chế còn lại ghi rõ**: Node stdlib trên Windows không có API cross-process tin cậy lấy process start time (chỉ `tasklist`/PowerShell — chậm, fragile, lỗi địa hóa) → mặc định **không** bật; dùng age heuristic 7 ngày. v2: cờ OS file lock (Windows `CreateFile` share-deny). GUI expose `lockHeldBy`/`stale` để người dùng thấy rõ. PM2 `--mode=run` giữ nguyên (không sửa config). |
| **Port conflict** | Bắt `EADDRINUSE` → log thân thiện + exit≠0 (mode web). `npm run web` lần 2 → báo port bận rõ ràng (T23.AC.4). OAuth redirect cũ dùng port 8787 (mode setup CLI) — tách biệt, không conflict với 8899. | Nếu khách vẫn muốn OAuth port cũ trên GUI: không dùng — T24 đã chốt embedded. |
| **Secret hiệu lực trong process đang chạy** | Periodic reload KHÔNG đụng secret (`process.env` keep startup); chỉ sau `POST /api/config` có `*_SET` mới sync đúng secret đó + swap activeConfig. | Tránh race đọc nửa chừng (write atomic nên không thể xảy ra), nhận diện khác biệt "config thường áp dụng chu kỳ kế tiếp" vs "secret thay đổi → OAuth/restart mới chắc chắn". Ghi rõ trên UI (→ T15). |
| **Read-modify-write cạnh tranh 2 writer** (`posted.json`) | Guard 409 one-shot khi STARTING/RUNNING/STOPPING (bắt buộc, T9) + mọi ghi qua `atomicWrite` (không truncate; rename nguyên tử) → không lost update/folder hỏng. | R15; test dual-writer ở T18/T19. |
| **OAuth remote-consent (R10)** | Setup OAuth phải chạy trên máy host; redirect_uri ghép `http://localhost:<GUI_PORT>/callback` (local) hoặc host thật (remote) — đăng ký Google Console trước. | Không hứa remote-consent v1; GUI nêu giới hạn (noteRemote). GATE-E verify consent thật. |
| **DNS TOCTOU trong SSRF guard** | Re-check bằng `dns.lookup` trước fetch, cả per-redirect. | Chấp nhận cửa hẹp cho single-user (threat §8.4); chặn tầng socket = P2 (nhìn chặn IP trước connect). |
| **Sniff token khi remote (`0.0.0.0`)** | `0.0.0.0` bắt buộc token + warning entropy + rate-limit; vẫn plain HTTP. | Chỉ chạy trên LAN trusted hoặc sau HTTPS reverse proxy (threat C16/P1); UI nêu rõ. |
| **Thay config khi đang sleep giữa cycle** | Reload đầu cycle → interval mới dùng từ cycle kế (đúng cam kết FR-5). | Không cần restart; test T4. |

**Rủi ro hiện hữu giữ nguyên**: GUI chết cùng process (chấp nhận, PM2 autorestart), 1 non-goal không có DB.

---

## Decision log (hội đồng phản biện chéo, 2026-08-20)

Quy ước: **CHẤP NHẬN** = giữ nguyên (đã/sẽ vá vào design) · **BÁC** = không áp dụng (lý do kỹ thuật) · **ĐIỀU CHỈNH** = áp một phần / áp với ghi chú.

| # | Finding | Quyết định | Lý do / nơi vá |
|---|---|---|---|
| 1 | [SEC] blocker — rate-limit chỉ verify/setup, brute-force token qua route khác | **CHẤP NHẬN** | Fail-auth counter đặt trong Bearer middleware, áp mọi route bị gate, per-IP + backoff hàm mũ (§5.5, §8.15, T10). |
| 2 | [SEC] blocker — loop SSRF + validate LLM_BASE_URL P1 nhưng threat-model Cao | **CHẤP NHẬN** | Nâng P0: loop fetchers (`fetchRssItems`/`fetchArticleBody`/`downloadImage`) qua `safeFetchUrl` + validate LLM_BASE_URL lúc khởi động + lúc ghi config (§9.2, §8.5). Ảnh hưởng task T1/T4/T8/T9 ghi rõ §9.2. |
| 3 | [SEC] major — Host-check không chặn direct-IP; start/stop trái phép no-token | **CHẤP NHẬN** | Thêm §4.4 cross-site guard (Origin + Sec-Fetch-Site) trên POST state-changing; token mode giải thích qua preflight do `Authorization` header (§4.4, §8.14, §8.15). |
| 4 | [UX] major — `_SET=""` xóa secret âm thầm | **CHẤP NHẬN** | Chốt tri-state: vắng mặt = giữ, `=""` = xóa explicit. Ràng buộc GUI: chỉ gửi `_SET` khi user mở "Đặt lại" (§3.2, §8.5). |
| 5 | [UX] major — reason/errorMessage trả describeError raw EN | **CHẤP NHẬN** | Thêm `humanMessage` (map code→VN, fallback generic) vào `lastPostResult`/`cycleProgress` status, `errorMessage` song hành, `history.reason`, `POST /api/post results`; giữ `reason` raw cho T19 (§2.2, §8.1, §8.3, §8.8). |
| 6 | [UX] major — 2FA card đẩy user về terminal | **CHẤP NHẬN** | Message tự-trọn, hướng dẫn Google 2FA chung, bỏ lệnh CLI (§6.3). |
| 7 | [UX] minor — Stop mid-batch không progress | **CHẤP NHẬN** | `cycleProgress {done,total}` + trạng thái "chờ hết item n/m" (§2.2, §2.3, §8.1, T22/T7). |
| 8 | [UX] minor — rss-preview chạy LLM | **CHẤP NHẬN** | preview = teaser thô (title + description ~200 từ), KHÔNG LLM; dry-run là nơi content cuối (§8.6). |
| 9 | [SEC] minor — lastOAuthError không sanitize | **CHẤP NHẬN** | Đưa qua cùng bộ sanitize log (§6.3, §8.13). |
| 10 | [SEC] minor — lockfile PID-reuse | **CHẤP NHẬN (có hạn chế ghi rõ)** | Ghi `{pid, startedAt, ppid?}`; stale-detect: so process start time nếu làm được trên Windows, không → ppid cross-check + age heuristic. Hạn chế: Node stdlib Windows không có API đáng tin lấy start-time cross-process (`tasklist` fragile) → mặc định age 7 ngày; v2 = OS file lock (§10). |
| 11 | [SEC] minor — GET / không token → token.html mãi (deadlock) | **CHẤP NHẬN** | Static → ANONYMOUS, form token in-page trong `index.html` (onload status → 401 → form), bỏ redirect navigation + file `token.html`/`token.js` (§5.3, §8.14, §8.15, bảng task §1, AC T10). Lệch với THREAT-MODEL C1b liệt kê `/token.html` — route đó trở thành vestigial (static anonymous đã bao phủ); THREAT-MODEL không sửa theo thỏa thuận, T19 regex test cập nhật theo contract mới. |
| 12 | [SEC] minor — Parse Host `[::1]:8899` vỡ | **CHẤP NHẬN** | Dùng `new URL('http://'+host).hostname` (§5.4). |
| 13 | [UX] minor — sessionStorage + auto-scroll | **CHẤP NHẬN (kèm ghi chú contract)** | (a) Token: DESIGN cho phép lưu **sessionStorage** (per-tab, đóng tab là mất, không vào localStorage/history) để reload không mất token — **nâng cấp** ràng buộc "memory-only" của T11/UI-SPEC §3; T11 implement theo DESIGN. Rủi ro = XSS cùng-origin đọc token — đã bằng (mọi XSS có quyền truy cập memory token). (b) Pause auto-scroll khi user kéo lên: **frontend-only, không phải contract** — UI-SPEC §4.2 toggle "Theo cuối" có sẵn; DESIGN không thêm field, không thay đổi `GET /api/logs`. |
| 14 | [Design→Code] — §5.5 spec `failCount ≥5/30s window` ≠ code triển khai `FAIL_THRESHOLD=3` + backoff cố định không window + sweep idle 24h | **CHẤP NHẬN (deviation ưu tiên bảo mật + đơn giản)** | Ngưỡng 3 chặt hơn 5; không cần cửa sổ trượt cho tool 1 chủ nhân local; lỗi chính chủ tự hết sau ≤30s (lần thứ 3); bộ nhớ bounded bằng `sweepBrute` idle>24h — không rò rỉ khi bind mạng mở bị scan. §5.5 đã cập nhật là mô tả THỰC TẾ, §8 giữ HTTP status chuẩn, chuẩn hóa tên code (`CONFIG_WRITE_FAILED` 500, `FETCH_RSS_FAILED` 502). |

Không finding nào bị BÁC. Các thay đổi này đồng thời cập nhật: API contract (§2.2, §6.3, §8.x), state machine (§2.3), server module (§4.4, §5, §9.2), config-store `_SET` (§3.2), lockfile (§10), bảng ánh xạ task (§1), và T19 sẽ assert `humanMessage` + static-anonymous + fail-auth rate-limit.

---

## Phụ lục — PNG tóm tắt tích hợp threat-model P0 vào design

| Threat-model P0 | Control | Thiết kế đáp ứng (mục) |
|---|---|---|
| C1/C1b | Bearer timing-safe + anonymous list | §5.2 (sha256+timingSafeEqual, precompute), §5.3 (static anonymous + `/api/auth/verify` + `/callback`) |
| C4/C10 | `/callback` state single-use + TTL + exchange server-side | §6.2, §6.3 |
| C5 | Mask secret + allowlist write + no CORS | §3.3 (toPublic), §3.2 (allowlist + `_SET` tri-state), §4.3 (no CORS) |
| C8 | CSP + security headers (backend) | §4.3 |
| C9 | SSRF guard `safeFetchUrl` | §9 toàn bộ (loop fetchers + validate LLM_BASE_URL nâng P0) |
| C2 | Từ chối khởi động `0.0.0.0` thiếu token | §4.1 |
| C7 | Bearer header (no cookie) + Host check loopback + cross-site guard POST | §5 + §5.4 + §4.4 |
| C11 | Fail-auth rate-limit mọi route bị gate + entropy tối thiểu | §5.5, T10/T16 |
| C12 | Sanitize log/error, không echo raw | §8.2 sanitize, §8.6 không echo URL, error mapping §4.2 |