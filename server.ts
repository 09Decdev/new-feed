/**
 * T5/T7/T8/T9/T10/T22/T23 — embedded GUI HTTP server (node:http, hand-rolled router).
 *
 * Launch ONLY via poster.ts `--mode=web` (`npm run web`). Never import-pulls poster.ts
 * (its top-level `main()` call would re-enter web mode): all shared post logic lives in
 * bot.controller (`runOneShotPosts`) instead.
 *
 * Security posture (per THREAT-MODEL §4.3/4.4, VERBATIM):
 *  - Bearer gate on /api/* (Authorization: Bearer <GUI_TOKEN>), sha256 + timingSafeEqual;
 *    per-IP fail-auth counter with backoff 30s → 1m → 2m (429 RATE_LIMITED + lockedUntil).
 *  - Exempt: GET /callback (anonymous stub, Wave 4 OAuth), POST /api/auth/verify.
 *  - Cross-site guard ALWAYS on sensitive routes (same regardless of token):
 *        reject `Sec-Fetch-Site: cross-site` → 403; no-token mode additionally rejects an
 *        Origin outside loopback. `Sec-Fetch-Site` is still checked when a token exists
 *        (defense-in-depth; browser preflight only blocks the header path).
 *  - Host-header check when GUI_HOST is loopback (127.0.0.1/localhost/::1), token or not:
 *        any other Host → 403 INVALID_HOST. Skipped when GUI_HOST=0.0.0.0.
 *  - OPTIONS → 405 `{ok:false,code:'METHOD_NOT_ALLOWED',message:'CORS not enabled'}`
 *    (no Access-Control-Allow-Origin ever). Static + index.html are anonymous.
 *  - All responses are JSON envelopes `{ok:true,data}` / `{ok:false,code,message,...}`;
 *    never includes a secret; error/log text runs through `sanitize` (token never logged).
 *  - Security headers on every reply (CSP / nosniff / no-referrer / no-store).
 *  - Body limit 1MB; JSON only.
 *
 * Startup: refuse to listen (exit≠0) when GUI_HOST=0.0.0.0 without GUI_TOKEN;
 * EADDRINUSE → friendly error, not a raw stack trace.
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { lookup } from 'node:dns/promises';
import { loadConfig, toPublic, applyUpdates, WRITE_ALLOWLIST_ENV, SECRET_SET_ENV, type Config } from './config-store';
import { installConsoleCapture, readLogs, setLogSecrets } from './log';
import { botController, ApiError, collectSecrets, runOneShotPosts, type OneShotPost } from './bot.controller';
import { listHistory, markPosted, hashKey, type PostStatus } from './dedup';
import { fetchRssItems, buildContent } from './rss';
import { sanitize, stripUrlQuery } from './sanitize';
import { listMyCommunities, getMyMemberPermission, getCommunityDetail, hasPostPermission } from './community.client';
import { loadSession, saveSession, type Session } from './session';
import { getAccessToken } from './auth.client';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PUBLIC_DIR = path.resolve(__dirname, 'public');
const MAX_BODY_BYTES = 1024 * 1024; // 1MB
const MAX_PREVIEW_ITEMS = 10;
const MAX_POST_ITEMS = 50;
const DRY_RUN_MAX_ITEMS = 5; // M11 — cheap preview cap
const HEALTHY_LOCKOUTS_MS = [30_000, 60_000, 120_000]; // exponential backoff 30s→1m→2m
const FAIL_THRESHOLD = 3;

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

const envFile = '.env'; // config-store anchors lockFile to the .env dir already
let expectedTokenHash: Buffer | null = null; // sha256 of GUI_TOKEN (null ⇒ token off)
let guiHostStartup = '127.0.0.1';
let guiHostIsLoopback = true; // re-computed at startup

// Per-IP brute-force state (entries are TTL-swept — M10)
interface BruteState {
  failures: number;
  lockedUntil: number;
  lastAt: number;
}
const bruteforce = new Map<string, BruteState>();
let lastBruteSweepAt = Date.now();

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function normalizeIp(raw?: string): string {
  let ip = (raw || 'unknown').replace(/^::ffff:/, '');
  if (ip === '::1' || ip === '127.0.0.1') ip = 'loopback';
  return ip;
}

function fmtHost(host: string): string {
  return host === '::1' ? '[::1]' : host === '0.0.0.0' ? '127.0.0.1' : host;
}

/** Resolve a hostname and check whether it resolves to a loopback address. */
async function isLoopbackHost(hostname: string): Promise<boolean> {
  let h = hostname.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  try {
    const r = await lookup(h);
    const a = r.address;
    return a === '127.0.0.1' || a === '::1' || a.startsWith('127.');
  } catch {
    return false;
  }
}

function hostnameOfHeader(hostHeader: string): string {
  try {
    if (!hostHeader) return '';
    const h = new URL(`http://${hostHeader}`).hostname || '';
    return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h; // strip IPv6 brackets
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Config/secret memoization (P1): /api/* is polled every ~2s; never re-parse .env
// or .session.json unless their mtime changed (only POST /api/config / login mutate).
// ---------------------------------------------------------------------------

let envCache: { m: number; cfg: Config } | null = null;
let sesCache: { file: string; m: number; secrets: readonly string[] } | null = null;

function fileMtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function cachedConfig(): Config {
  const m = fileMtime(envFile);
  if (envCache && envCache.m === m) return envCache.cfg;
  const cfg = loadConfig(envFile);
  envCache = { m, cfg };
  return cfg;
}

/** Compute (cached by mtime) the current secret list — token never leaves this process. */
function computeSecrets(): readonly string[] {
  const cfg = cachedConfig();
  const m = fileMtime(cfg.sessionFile);
  if (sesCache && sesCache.file === cfg.sessionFile && sesCache.m === m) return sesCache.secrets;
  const session = loadSession(cfg.sessionFile);
  const secrets = collectSecrets(cfg, session);
  sesCache = { file: cfg.sessionFile, m, secrets };
  return secrets;
}

// ---------------------------------------------------------------------------
// Single-instance guard (T23): /api/status must show lock held even when another
// PROCESS (e.g. PM2 mode=run) owns loop.lock — the controller only knows its own.
// Mirror bot.controller's isPidAlive + 7-day staleness (same contract as the loop).
// ---------------------------------------------------------------------------

const STALE_LOCK_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

async function effectiveLock(): Promise<{ held: boolean; pid: number | null; stale: boolean }> {
  const st = botController.getStatus().lock;
  if (st.held) return { held: true, pid: st.lockHeldBy ?? null, stale: st.stale };
  const cfg = cachedConfig();
  try {
    const j = JSON.parse(fs.readFileSync(cfg.lockFile, 'utf8'));
    const pid = typeof j?.pid === 'number' ? j.pid : NaN;
    const startedAt = typeof j?.startedAt === 'number' ? j.startedAt : 0;
    const stale = startedAt <= 0 || Date.now() - startedAt > STALE_LOCK_AGE_MS;
    const alive = Number.isInteger(pid) && pidAlive(pid);
    if (alive && !stale) return { held: true, pid, stale: false };
    if (alive) return { held: false, pid, stale: true }; // PID reused / stale age — will be reclaimed by next Start
    return { held: false, pid: null, stale: false };
  } catch {
    return { held: false, pid: null, stale: false };
  }
}

// ---------------------------------------------------------------------------
// HTTP response helpers (always with security headers)
// ---------------------------------------------------------------------------

function applySecurityHeaders(res: ServerResponse): void {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
}

function send(res: ServerResponse, status: number, body: string, contentType: string): void {
  applySecurityHeaders(res);
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');
}

/** Standard error envelope — every non-2xx API reply runs through here. */
function fail(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  extra?: { humanMessage?: string; retryable?: boolean; [k: string]: unknown },
): void {
  sendJson(res, status, {
    ok: false,
    code,
    message: sanitize(message, computeSecrets()),
    ...(extra?.humanMessage ? { humanMessage: sanitize(extra.humanMessage, computeSecrets()) } : {}),
    ...(extra?.retryable ? { retryable: true } : {}),
    ...(extra ? Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'humanMessage' && k !== 'retryable')) : {}),
  });
}

// ---------------------------------------------------------------------------
// Body parsing (JSON only, 1MB limit)
// ---------------------------------------------------------------------------

async function readJsonBody(req: IncomingMessage): Promise<any> {
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (!ct.includes('application/json')) {
    throw new ApiError({ statusCode: 400, code: 'INVALID_CONTENT_TYPE', message: 'Body phải là application/json.' });
  }
  return new Promise<any>((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let done = false;
    const failOnce = (e: unknown) => {
      if (!done) {
        done = true;
        reject(e);
      }
    };
    req.on('data', (c: Buffer) => {
      if (done) return; // still draining after a 413 — emit nothing more
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        failOnce(new ApiError({ statusCode: 413, code: 'PAYLOAD_TOO_LARGE', message: 'Body vượt quá giới hạn 1MB.' }));
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new ApiError({ statusCode: 400, code: 'INVALID_JSON', message: 'Body không phải JSON hợp lệ.' }));
      }
    });
    req.on('error', (e) => failOnce(e));
  });
}

// ---------------------------------------------------------------------------
// Bearer auth + per-IP backoff rate limiting (T10)
// ---------------------------------------------------------------------------

function tokenMatches(provided: string | undefined): boolean {
  if (!expectedTokenHash) return true;
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const h = createHash('sha256').update(provided).digest();
  return h.length === expectedTokenHash.length && timingSafeEqual(h, expectedTokenHash);
}

function bumpFailure(ip: string): BruteState {
  const st = bruteforce.get(ip) ?? { failures: 0, lockedUntil: 0, lastAt: 0 };
  st.failures += 1;
  st.lastAt = Date.now();
  if (st.failures >= FAIL_THRESHOLD) {
    const idx = Math.min(st.failures - FAIL_THRESHOLD, HEALTHY_LOCKOUTS_MS.length - 1);
    st.lockedUntil = Date.now() + HEALTHY_LOCKOUTS_MS[idx];
  }
  bruteforce.set(ip, st);
  return st;
}

function clearFailures(ip: string): void {
  bruteforce.delete(ip);
}

/** M10: evict idle brute-force entries (24h without activity) so a remote bind can't leak memory. */
function sweepBrute(): void {
  const now = Date.now();
  if (now - lastBruteSweepAt < 60_000) return; // at most once a minute
  lastBruteSweepAt = now;
  const idleCap = 24 * 3600 * 1000; // 24h since last failed attempt → evict
  for (const [ip, s] of bruteforce) {
    // Unlocked idle entries and ALREADY-EXPIRED locks (lockedUntil passed) older than 24h
    // are evicted; active (still-locked) entries stay — R2-6.
    const idleOk = now - s.lastAt > idleCap;
    const lockDead = s.lockedUntil <= now;
    if (idleOk && lockDead) bruteforce.delete(ip);
  }
}

/** Reply on lockout. Returns true when locked. */
function respondLocked(res: ServerResponse, st: BruteState): void {
  fail(res, 429, 'RATE_LIMITED', 'Quá nhiều lần thử sai. Thử lại sau.', {
    humanMessage: 'Quá nhiều lần thử sai token. Hãy chờ vài phút rồi thử lại.',
    retryable: true,
    lockedUntil: st.lockedUntil,
  });
}

/** Gate every protected /api/* route. Returns true = allowed (or no token configured). */
async function bearerGate(req: IncomingMessage, res: ServerResponse, ip: string): Promise<boolean> {
  sweepBrute(); // M10 — keep the per-IP map bounded
  if (!expectedTokenHash) return true;
  const st = bruteforce.get(ip);
  if (st && st.lockedUntil > Date.now()) {
    respondLocked(res, st);
    return false;
  }
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
  if (tokenMatches(m?.[1])) {
    clearFailures(ip);
    return true;
  }
  const after = bumpFailure(ip);
  if (after.lockedUntil > Date.now()) {
    respondLocked(res, after);
    return false;
  }
  fail(res, 401, 'UNAUTHORIZED', 'Token GUI sai hoặc thiếu.', {
    humanMessage: 'Token truy cập GUI không đúng.',
    retryable: true,
  });
  return false;
}

// ---------------------------------------------------------------------------
// Cross-site + host-header guards (§4.4 / C7)
// ---------------------------------------------------------------------------

/** Sensitive routes that must never be triggered cross-site — token or not. */
function isSensitiveRoute(pathname: string): boolean {
  return (
    pathname === '/api/rss-preview' ||
    pathname === '/api/start' ||
    pathname === '/api/stop' ||
    pathname === '/api/post' ||
    pathname === '/api/config' ||
    pathname.startsWith('/api/setup/')
  );
}

/** Literal loopback host list — NO DNS resolution (M2). */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1']);

function portOfHostPort(s: string): string | null {
  try {
    const u = new URL(`http://${s}`);
    return u.port;
  } catch {
    return null;
  }
}

/** Normalize an explicit/default port so origin vs Host "127.0.0.1:8899" == "127.0.0.1" (80/443). */
function normalizedPort(port: string): string | null {
  if (!port) return '80';
  if (port === '443' || port === '80') return port;
  return port;
}

/**
 * M2: compare the request's Origin host against the Host header — same hostname AND same
 * effective port (normalizing bare http→:80 / https→:443). Synchronous, no DNS lookups.
 */
function originsMatch(originHeader: string, hostHeader: string): boolean {
  if (!originHeader || !hostHeader) return false;
  if (originHeader === 'null') return false;
  let o: URL;
  try {
    o = new URL(originHeader);
  } catch {
    return false;
  }
  if (o.protocol !== 'http:' && o.protocol !== 'https:') return false;
  // R2-5: URL.hostname keeps brackets for IPv6 (`[::1]`), Host parsing strips them —
  // normalize both to bare host so `http://[::1]:8899` == Host `[::1]:8899`.
  const originHost = o.hostname.startsWith('[') && o.hostname.endsWith(']') ? o.hostname.slice(1, -1) : o.hostname;
  const hostName = hostnameOfHeader(hostHeader);
  if (originHost !== hostName) return false;
  // Bare scheme defaults get normalized to 80/443 so "http://127.0.0.1" == "127.0.0.1:80".
  const originPort = normalizedPort(o.port);
  const hostPort = normalizedPort(portOfHostPort(hostHeader) ?? '');
  if (originPort !== hostPort) return false;
  return true;
}

/**
 * Always reject `Sec-Fetch-Site: cross-site`. In no-token mode additionally reject an
 * Origin that does not exactly match the request Host header (hostname + port).
 */
async function crossSiteAllowed(req: IncomingMessage): Promise<boolean> {
  const secFetch = String(req.headers['sec-fetch-site'] || '');
  if (secFetch === 'cross-site') return false;
  const origin = req.headers.origin;
  if (origin && !expectedTokenHash) {
    if (!originsMatch(String(origin), String(req.headers.host || ''))) return false;
  }
  return true;
}

/** Host-header check when GUI_HOST is loopback (token or not): reject foreign Host. */
async function hostCheckAllowed(req: IncomingMessage): Promise<boolean> {
  if (!guiHostIsLoopback) return true; // 0.0.0.0 → skip host check
  const host = hostnameOfHeader(String(req.headers.host || ''));
  if (!host) return false;
  return LOOPBACK_HOSTS.has(host);
}

// ---------------------------------------------------------------------------
// Static files (anonymous — council decision)
// ---------------------------------------------------------------------------

function serveStaticFile(res: ServerResponse, pathname: string): boolean {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return false; // traversal → 403 below
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.size > 5 * 1024 * 1024) return false;
  const ext = path.extname(file).toLowerCase();
  const body = fs.readFileSync(file);
  applySecurityHeaders(res); // setHeader must precede writeHead — headers flush on writeHead
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': body.length,
  });
  res.end(body);
  return true;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

// --- GET /api/status -------------------------------------------------------

async function handleStatus(res: ServerResponse): Promise<void> {
  const st = botController.getStatus();
  const lock = await effectiveLock();
  sendJson(res, 200, {
    ok: true,
    data: {
      state: st.state,
      errorMessage: st.errorMessage ?? null,
      humanMessage: st.humanMessage ?? null,
      lastCycleAt: st.lastCycleAt ?? null,
      lastPostResult: st.lastPostResult ?? null,
      cycleCount: st.cycleCount,
      postedToday: st.postedToday,
      config: st.config,
      auth: st.auth,
      lock: { held: lock.held, pid: lock.pid, stale: lock.stale },
      cycleProgress: st.cycleProgress,
      guiTokenSet: expectedTokenHash !== null,
    },
  });
}

// --- GET /api/logs ---------------------------------------------------------

async function handleLogs(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const q = new URL(req.url || '/', 'http://internal').searchParams;
  const sinceRaw = q.get('since');
  const since = sinceRaw === null || sinceRaw === '' ? undefined : parseInt(sinceRaw, 10);
  const filter = q.get('filter') || undefined;
  sendJson(res, 200, { ok: true, data: readLogs({ since, filter }) });
}

// --- GET /api/history ------------------------------------------------------

async function handleHistory(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cfg = loadConfig(envFile);
  const q = new URL(req.url || '/', 'http://internal').searchParams;
  const limitRaw = q.get('limit');
  let limit: number | undefined;
  if (limitRaw !== null && limitRaw !== '') {
    const n = Math.floor(parseInt(limitRaw, 10));
    limit = Number.isFinite(n) ? Math.max(1, Math.min(1000, n)) : undefined;
  }
  let status: PostStatus | undefined;
  const s = q.get('status') || '';
  if (s === 'posted' || s === 'skipped' || s === 'failed') status = s as PostStatus;
  const items = listHistory(cfg.dedupFile, { limit, status }).map((e) => ({
    key: e.key,
    ts: e.ts,
    title: e.title ?? '—', // legacy {key,ts} entries render an em dash
    link: e.link ?? undefined,
    postId: e.postId ?? undefined,
    status: e.status ?? 'posted', // legacy entries default to posted
    reason: e.reason ?? undefined,
    humanMessage: e.humanMessage ?? undefined,
  }));
  sendJson(res, 200, { ok: true, data: { status: status ?? 'all', count: items.length, entries: items } });
}

// --- GET/POST /api/config --------------------------------------------------

async function handleGetConfig(res: ServerResponse): Promise<void> {
  const cfg = loadConfig(envFile);
  sendJson(res, 200, {
    ok: true,
    data: {
      config: toPublic(cfg),
      writable: WRITE_ALLOWLIST_ENV,
      secretSet: SECRET_SET_ENV,
      guiTokenSet: expectedTokenHash !== null,
    },
  });
}

async function handlePostConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return fail(res, 400, 'VALIDATION_ERROR', 'Body phải là object các trường cấu hình.');
  }
  const cfg = loadConfig(envFile);
  try {
    const r = await applyUpdates(cfg.envFile, body);
    // M8: apply immediately — swap into the running controller + refresh log secret list
    botController.reloadConfigNow();
    setLogSecrets(computeSecrets()); // secret list may have changed
    sendJson(res, 200, {
      ok: true,
      data: {
        written: r.written,
        deleted: r.deleted,
        message: 'Thay đổi sẽ áp dụng từ chu kỳ kế tiếp.',
        humanMessage: 'Thay đổi sẽ áp dụng từ chu kỳ kế tiếp (hoặc ngay khi bấm Start lại).',
      },
    });
  } catch (e: any) {
    // R2-4 (§8.5): file-write failures are server faults (500); input validation stays 400.
    if (e?.code === 'CONFIG_WRITE_FAILED') {
      console.error(`[news-poster-gui] config write failed: ${sanitize(e?.message ?? String(e), computeSecrets())}`);
      return fail(res, 500, 'CONFIG_WRITE_FAILED', 'Không ghi được tệp cấu hình.', {
        humanMessage: 'Không ghi được tệp cấu hình. Kiểm tra quyền ghi tệp.',
      });
    }
    return fail(res, 400, 'VALIDATION_ERROR', e?.message ?? String(e), {
      humanMessage: 'Cấu hình không hợp lệ.',
    });
  }
}

// --- GET /api/rss-preview --------------------------------------------------

async function handleRssPreview(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const q = new URL(req.url || '/', 'http://internal').searchParams;
  const feedUrl = q.get('url');
  if (!feedUrl) {
    return fail(res, 400, 'MISSING_PARAM', 'Thiếu tham số url.', {
      humanMessage: 'Nhập URL feed RSS để xem trước.',
    });
  }
  const cfg = loadConfig(envFile);
  try {
    // fetchRssItems runs entirely through safeFetchDownload (SSRF guard + timeout + size cap).
    const items = await fetchRssItems(feedUrl, MAX_PREVIEW_ITEMS);
    const preview = items.map((it) => ({
      title: it.title,
      link: it.link,
      imageUrl: it.imageUrl,
      content: buildContent(it), // teaser only — NO LLM, NO article scrape (cheap preview)
    }));
    sendJson(res, 200, { ok: true, data: { url: stripUrlQuery(feedUrl), items: preview } });
  } catch (e: any) {
    console.log(`[news-poster-gui] rss-preview failed: ${sanitize(e?.message ?? String(e), computeSecrets())}`);
    return fail(res, 502, 'FETCH_RSS_FAILED', 'Không tải được feed RSS.', {
      humanMessage: 'Không tải được feed RSS. Kiểm tra URL hoặc mạng, hoặc URL bị chặn (private/local).',
      retryable: true,
    });
  }
}

// --- GET /api/communities --------------------------------------------------

async function handleCommunities(res: ServerResponse): Promise<void> {
  const cfg = loadConfig(envFile);
  const session = loadSession(cfg.sessionFile);
  let token: string;
  try {
    token = await getAccessToken(session, cfg.gatewayUrl, process.env, cfg.device);
    saveSession(cfg.sessionFile, session);
  } catch (e: any) {
    return fail(res, 401, 'AUTH_FAILED', sanitize(e?.message ?? String(e), computeSecrets()), {
      humanMessage: 'Không xác thực được với gateway. Hãy chạy setup để đăng nhập lại.',
    });
  }
  try {
    const ids = await listMyCommunities(cfg.gatewayUrl, token);
    setLogSecrets(computeSecrets());
    const items: { id: string; name?: string; role: string; canPost: boolean }[] = [];
    for (const id of ids.slice(0, 50)) {
      let name: string | undefined;
      let role = 'none';
      let canPost = false;
      try {
        name = (await getCommunityDetail(cfg.gatewayUrl, token, id)).name;
      } catch {
        /* name unknown — keep '?' marker */
      }
      try {
        const p = await getMyMemberPermission(cfg.gatewayUrl, token, id);
        role = p.role || 'MEMBER';
        canPost = hasPostPermission(p);
      } catch {
        /* not a member anymore — canPost false */
      }
      items.push({ id, name, role, canPost });
    }
    sendJson(res, 200, {
      ok: true,
      data: { items, targetCommunityId: cfg.communityId },
    });
  } catch (e: any) {
    return fail(res, 502, 'GATEWAY_ERROR', sanitize(e?.message ?? String(e), computeSecrets()), {
      humanMessage: 'Không lấy được danh sách cộng đồng từ gateway.',
      retryable: true,
    });
  }
}

// --- POST /api/post (T9) ---------------------------------------------------

async function handlePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cfg = loadConfig(envFile);
  if (!cfg.communityId) {
    return fail(res, 400, 'MISSING_COMMUNITY_ID', 'COMMUNITY_ID chưa cấu hình.', {
      humanMessage: 'Chưa chọn cộng đồng để đăng. Hãy điền COMMUNITY_ID trước.',
    });
  }
  const st = botController.getStatus();
  if (st.state === 'STARTING' || st.state === 'RUNNING' || st.state === 'STOPPING') {
    return fail(res, 409, 'CONFLICT', `Bot đang ${st.state}. Không thể đăng thủ công cùng lúc.`, {
      humanMessage: `Bot đang ${st.state}. Hãy dừng bot trước khi đăng thủ công.`,
      retryable: true,
    });
  }
  const body = await readJsonBody(req);
  const mode = body?.mode;
  if (mode !== 'test' && mode !== 'rss') {
    return fail(res, 400, 'VALIDATION_ERROR', 'mode phải là "test" hoặc "rss".');
  }
  const dryRun = body?.dryRun === true;
  let limit = cfg.rssLimit;
  if (body?.limit !== undefined && body.limit !== null) {
    const n = Math.floor(Number(body.limit));
    if (Number.isFinite(n) && n > 0) limit = Math.min(n, MAX_POST_ITEMS);
  }
  const defaultTest = 'Đây là bài viết demo từ news-poster (Google login) — kiểm tra luồng đăng bài qua gateway.';

  // Build the post list — same shape the CLI one-shot modes use.
  const posts: OneShotPost[] = [];
  if (mode === 'test') {
    posts.push({ title: 'test-post', link: '', description: '', content: body?.content || defaultTest });
  } else {
    const feedUrl = body?.rssUrl || cfg.rssUrl;
    if (!feedUrl) {
      return fail(res, 400, 'MISSING_PARAM', 'Thiếu rssUrl.', {
        humanMessage: 'Nhập URL feed RSS để đăng.',
      });
    }
    try {
      // M11: dryRun previews stay cheap — cap the fetch regardless of cfg.rssLimit.
      const fetchLimit = dryRun ? Math.min(limit, DRY_RUN_MAX_ITEMS) : limit;
      const items = await fetchRssItems(feedUrl, fetchLimit);
      if (items.length === 0) {
        return sendJson(res, 200, {
          ok: true,
          data: { ok: false, reason: 'NO_ITEMS', humanMessage: 'Feed không có bài nào mới.' },
        });
      }
      for (const it of items) {
        posts.push({ title: it.title, link: it.link, description: it.description, imageUrl: it.imageUrl });
      }
    } catch (e: any) {
      return fail(res, 502, 'FETCH_RSS_FAILED', 'Không tải được feed RSS.', {
        humanMessage: 'Không tải được feed RSS. Kiểm tra URL/mạng hoặc URL bị chặn.',
        retryable: true,
      });
    }
  }

  if (dryRun) {
    // Preview ONLY — no token fetch, no gateway post, no lock, no history.
    // Content still builds through the shared executor (LLM rewrite allowed; not a gateway call).
    const r = await runOneShotPosts(posts, mode, cfg, {}, '', true, computeSecrets());
    const previews = posts.map((p, i) => ({ title: p.title, link: p.link, imageUrl: p.imageUrl, content: p.content }));
    return sendJson(res, 200, {
      ok: true,
      data: {
        ok: true,
        dryRun: true,
        count: posts.length,
        posted: r.ok,
        failed: r.failed,
        message: 'Đây là bản xem trước (chưa đăng).',
        previews,
      },
    });
  }

  // Real post — bootstrap token, then run under the same atomic loop lock as the run loop.
  const session = loadSession(cfg.sessionFile);
  let token: string;
  try {
    token = await getAccessToken(session, cfg.gatewayUrl, process.env, cfg.device);
    saveSession(cfg.sessionFile, session);
  } catch (e: any) {
    return fail(res, 401, 'AUTH_FAILED', sanitize(e?.message ?? String(e), computeSecrets()), {
      humanMessage: 'Không xác thực được với gateway. Hãy chạy setup để đăng nhập lại.',
    });
  }
  setLogSecrets(computeSecrets());
  const secrets = computeSecrets();
  const lockFile = loadConfig(envFile).lockFile; // anchored to the .env dir (config-store)
  let r;
  try {
    r = await botController.runWithLoopLock(lockFile, () =>
      runOneShotPosts(posts, mode, cfg, session, token, false, secrets),
    );
  } catch (e: any) {
    if (e instanceof ApiError && e.statusCode === 409) {
      return fail(res, 409, 'CONFLICT', e.message, { humanMessage: e.message, retryable: true });
    }
    throw e;
  }

  // The shared executor records posted history; record the first failure too (GATE 2:
  // failed item is NOT retried later — same semantics as the run loop).
  if (r.failed > 0 && r.lastFailed?.link) {
    const cfgNow = loadConfig(envFile);
    await markPosted(cfgNow.dedupFile, {
      key: hashKey(r.lastFailed.link),
      title: r.lastFailed.title || 'test-post',
      link: r.lastFailed.link,
      status: 'failed',
      reason: r.lastFailed.reason,
      humanMessage: r.lastFailed.humanMessage,
      ts: Date.now(),
    });
  }

  if (r.ok === 0 && r.failed > 0) {
    return sendJson(res, 200, {
      ok: true,
      data: {
        ok: false,
        reason: r.lastFailed?.reason,
        humanMessage: r.lastFailed?.humanMessage || 'Đăng bài thất bại.',
      },
    });
  }
  const note =
    r.failed > 0 ? `Đã đăng ${r.ok} bài, ${r.failed} bài thất bại.` : `Đã đăng ${r.ok} bài.`;
  return sendJson(res, 200, {
    ok: true,
    data: {
      ok: true,
      postId: r.lastOk?.postId,
      message: note,
      humanMessage: note,
    },
  });
}

// --- POST /api/start (T22) -------------------------------------------------

async function handleStart(res: ServerResponse): Promise<void> {
  const st = botController.getStatus();
  if (st.state === 'STARTING' || st.state === 'RUNNING' || st.state === 'STOPPING') {
    return fail(res, 409, 'CONFLICT', `Bot đang ${st.state}.`, {
      humanMessage: `Bot đang ${st.state}. Không thể khởi động cùng lúc.`,
      retryable: true,
    });
  }
  // T23: another process may own loop.lock (single-instance guard) — check BEFORE
  // start() so the GUI gets a clear 409 instead of silently flipping to ERROR.
  const lock = await effectiveLock();
  if (lock.held) {
    return fail(res, 409, 'CONFLICT', `Đã có vòng lặp khác chạy (pid ${lock.pid}).`, {
      humanMessage: `Đã có vòng lặp khác chạy (pid ${lock.pid}). Tắt nó trước khi Start.`,
      retryable: true,
    });
  }
  try {
    await botController.start(); // GUI failures land in ERROR state — no process.exit
  } catch (e: any) {
    if (e instanceof ApiError) {
      return fail(res, e.statusCode, e.code, e.message, { humanMessage: e.message, retryable: !!e.retryable });
    }
    throw e;
  }
  const after = botController.getStatus();
  if (after.state === 'ERROR') {
    // Lock-race / lock-held → still report 409 (start() marks this explicitly; R2-3).
    if (botController.lockConflictFlag) {
      return fail(res, 409, 'CONFLICT', after.humanMessage || 'Đã có vòng lặp khác chạy.', {
        humanMessage: after.humanMessage || 'Đã có vòng lặp khác chạy.',
        retryable: true,
      });
    }
    // M7: pre-flight failure (e.g. RUNTIME_DEP or gateway login) → 502 FORBIDDEN retryable
    return fail(res, 502, 'FORBIDDEN', after.errorMessage || 'Không thể khởi động được.', {
      humanMessage: after.humanMessage || 'Không thể khởi động bot ngay lúc này.',
      retryable: true,
      detail: after.humanMessage ?? after.errorMessage ?? null,
    });
  }
  sendJson(res, 200, {
    ok: true,
    data: { state: after.state, errorMessage: after.errorMessage ?? null, humanMessage: after.humanMessage ?? null },
  });
}

// --- POST /api/stop (T22) --------------------------------------------------

async function handleStop(res: ServerResponse): Promise<void> {
  const st = botController.getStatus();
  if (st.state === 'STOPPING') {
    return fail(res, 409, 'CONFLICT', 'Bot đang STOPPING.', { humanMessage: 'Bot đang dừng…', retryable: true });
  }
  if (st.state !== 'RUNNING' && st.state !== 'STARTING') {
    return fail(res, 400, 'BAD_REQUEST', `Bot đang ${st.state}.`, {
      humanMessage: `Bot đang ${st.state}. Chưa cần dừng.`,
    });
  }
  botController.stop(); // bot.controller.stop() handles STARTING → STOPPING
  sendJson(res, 200, { ok: true, data: { state: 'STOPPING' } });
}

// --- GET /api/auth-status --------------------------------------------------

async function handleAuthStatus(res: ServerResponse): Promise<void> {
  const cfg = loadConfig(envFile);
  const session: Session = loadSession(cfg.sessionFile);
  sendJson(res, 200, {
    ok: true,
    data: {
      hasSession: !!(session.platformAccessToken || session.googleRefreshToken),
      hasGoogleRefresh: !!session.googleRefreshToken,
      accessExpiresAt: session.platformAccessExpiresAt ?? null,
      communityId: cfg.communityId,
      communityPermission: null, // checked on the communities screen
      lastOAuthError: null,
      guiTokenSet: expectedTokenHash !== null,
    },
  });
}

// --- POST /api/auth/verify (Bearer-exempt login helper) --------------------
// Accepts the token via `Authorization: Bearer <token>` OR JSON body `{"token": "..."}`.
// Envelope: {ok:true,data:{authenticated:boolean}}; 400 MISSING_TOKEN / 401 UNAUTHORIZED /
// 429 RATE_LIMITED (locked), wrong-token carries humanMessage + retryable + lockedUntil.

async function handleAuthVerify(req: IncomingMessage, res: ServerResponse): Promise<void> {
  sweepBrute(); // M10 — keep the per-IP map bounded on this bearer-exempt path too
  const ip = normalizeIp(req.socket?.remoteAddress);
  if (!expectedTokenHash) {
    return sendJson(res, 200, { ok: true, data: { authenticated: true, guiTokenSet: false } });
  }
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
  let token: string | undefined;
  if (m) {
    token = m[1];
  } else if (req.headers['content-type'] && String(req.headers['content-type']).toLowerCase().includes('application/json')) {
    const body = await readJsonBody(req);
    if (body && typeof body === 'object' && typeof body.token === 'string' && body.token) token = body.token;
  }
  if (!token || token.length === 0) {
    return fail(res, 400, 'MISSING_TOKEN', 'Thiếu token. Giải pháp: Authorization: Bearer <GUI_TOKEN> hoặc body {token}.', {
      humanMessage: 'Nhập token truy cập GUI.',
    });
  }
  const st = bruteforce.get(ip);
  if (st && st.lockedUntil > Date.now()) {
    return respondLocked(res, st);
  }
  if (tokenMatches(token)) {
    clearFailures(ip);
    return sendJson(res, 200, { ok: true, data: { authenticated: true, guiTokenSet: true } });
  }
  const after = bumpFailure(ip);
  if (after.lockedUntil > Date.now()) {
    return respondLocked(res, after);
  }
  return fail(res, 401, 'UNAUTHORIZED', 'Token không đúng.', {
    humanMessage: 'Token truy cập GUI không đúng.',
    retryable: true,
    lockedUntil: after.lockedUntil || undefined,
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

function methodOf(req: IncomingMessage): string {
  return (req.method || 'GET').toUpperCase();
}

function methodFail(res: ServerResponse, method: string): void {
  fail(res, 405, 'METHOD_NOT_ALLOWED', `Method phải là ${method}.`);
}

async function dispatchApi(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  // Bearer-exempt login helper first.
  if (pathname === '/api/auth/verify') {
    if (methodOf(req) !== 'POST') return methodFail(res, 'POST');
    return handleAuthVerify(req, res);
  }

  const ip = normalizeIp(req.socket?.remoteAddress);

  // Cross-site guard on sensitive routes — regardless of token (defense-in-depth).
  if (isSensitiveRoute(pathname)) {
    if (!(await crossSiteAllowed(req))) {
      console.log(`[news-poster-gui] Blocked cross-site ${methodOf(req)} ${pathname}`);
      return fail(res, 403, 'FORBIDDEN', 'Yêu cầu cross-site bị chặn.');
    }
  }

  if (!(await bearerGate(req, res, ip))) return;
  setLogSecrets(computeSecrets());

  switch (pathname) {
    case '/api/status': {
      if (methodOf(req) !== 'GET') return methodFail(res, 'GET');
      return handleStatus(res);
    }
    case '/api/logs': {
      if (methodOf(req) !== 'GET') return methodFail(res, 'GET');
      return handleLogs(req, res);
    }
    case '/api/history': {
      if (methodOf(req) !== 'GET') return methodFail(res, 'GET');
      return handleHistory(req, res);
    }
    case '/api/config': {
      if (methodOf(req) === 'GET') return handleGetConfig(res);
      if (methodOf(req) === 'POST') return handlePostConfig(req, res);
      return methodFail(res, 'GET|POST');
    }
    case '/api/rss-preview': {
      if (methodOf(req) !== 'GET') return methodFail(res, 'GET');
      return handleRssPreview(req, res);
    }
    case '/api/communities': {
      if (methodOf(req) !== 'GET') return methodFail(res, 'GET');
      return handleCommunities(res);
    }
    case '/api/post': {
      if (methodOf(req) !== 'POST') return methodFail(res, 'POST');
      return handlePost(req, res);
    }
    case '/api/start': {
      if (methodOf(req) !== 'POST') return methodFail(res, 'POST');
      return handleStart(res);
    }
    case '/api/stop': {
      if (methodOf(req) !== 'POST') return methodFail(res, 'POST');
      return handleStop(res);
    }
    case '/api/auth-status': {
      if (methodOf(req) !== 'GET') return methodFail(res, 'GET');
      return handleAuthStatus(res);
    }
    default:
      if (pathname.startsWith('/api/setup/')) {
        return fail(res, 404, 'NOT_IMPLEMENTED', 'Chưa triển khai (Wave 4).');
      }
      if (pathname === '/api/') {
        return fail(res, 404, 'API_ROOT', 'Sử dụng các endpoint /api/status, /api/config, …');
      }
      return fail(res, 404, 'NOT_FOUND', `Không tìm thấy endpoint ${pathname}.`);
  }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url || '/', 'http://internal').pathname);
  } catch {
    return fail(res, 400, 'BAD_REQUEST', 'URL không hợp lệ.');
  }

  if (methodOf(req) === 'OPTIONS') {
    return fail(res, 405, 'METHOD_NOT_ALLOWED', 'CORS not enabled');
  }

  // Host-header check (loopback bind only) — before anything else.
  if (!(await hostCheckAllowed(req))) {
    return fail(res, 403, 'INVALID_HOST', 'Host header không hợp lệ.');
  }

  // Anonymous static / callback / favicon (not Bearer-gated — council decision).
  if (methodOf(req) === 'GET') {
    if (pathname === '/favicon.ico') return send(res, 204, '', 'text/plain');
    if (pathname === '/callback') {
      serveStaticFile(res, '/callback.html');
      return;
    }
    if (serveStaticFile(res, pathname)) return;
    if (!pathname.startsWith('/api/') && pathname !== '/api') {
      return fail(res, 404, 'NOT_FOUND', 'Không tìm thấy tài nguyên.');
    }
  }

  if (pathname.startsWith('/api/')) {
    return dispatchApi(req, res, pathname);
  }
  return fail(res, 404, 'NOT_FOUND', 'Không tìm thấy endpoint.');
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

/**
 * Start the embedded GUI server. Returns the base URL after binding succeeds.
 * Refuses to start (throws → caller exits ≠0) when GUI_HOST=0.0.0.0 without GUI_TOKEN.
 */
export async function startGuiServer(): Promise<string> {
  installConsoleCapture();
  const cfg: Config = loadConfig(envFile);
  setLogSecrets(computeSecrets());

  const host = cfg.guiHost || '127.0.0.1';
  const port = cfg.guiPort;
  guiHostStartup = host;

  // B1 startup gate (Threat §4.1): any NON-loopback bind with no GUI_TOKEN = remote
  // anonymous admin → refuse to listen. 0.0.0.0 is the common case, but every public
  // host (LAN IP, hostname…) is equally dangerous, so we gate on isLoopbackHost().
  const hostLoopback = await isLoopbackHost(host);
  if (!hostLoopback && !cfg.guiToken) {
    throw new Error(
      `GUI_HOST=${host} (không phải loopback) yêu cầu GUI_TOKEN (bảo mật mạng mở). ` +
        'Set GUI_TOKEN trong .env rồi khởi động lại, hoặc dùng GUI_HOST=127.0.0.1.',
    );
  }

  expectedTokenHash = cfg.guiToken ? createHash('sha256').update(cfg.guiToken).digest() : null;
  guiHostIsLoopback = hostLoopback;

  console.log(
    `[news-poster-gui] GUI_TOKEN=${expectedTokenHash ? 'set' : 'unset'} — bind ${host}:${port}` +
      (!hostLoopback ? ' (mạng mở — bắt buộc token)' : ''),
  );

  const server = createServer((req, res) => {
    void normalizeIp(req.socket?.remoteAddress);
    handleRequest(req, res).catch((e: any) => {
      if (e instanceof ApiError) {
        // Re-thrown ApiError (415/413/400…) → keep its exact status/code envelope.
        return fail(res, e.statusCode, e.code, e.message, { humanMessage: e.message, retryable: e.retryable });
      }
      const msg = sanitize(e?.message ?? String(e), computeSecrets());
      console.error(`[news-poster-gui] 500 ${req.method} ${req.url}: ${msg}`);
      fail(res, 500, 'INTERNAL', 'Lỗi nội bộ máy chủ.', { humanMessage: 'Lỗi nội bộ máy chủ GUI.' });
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException) => {
      if (e && e.code === 'EADDRINUSE') {
        reject(
          new Error(
            `Cổng ${port} đang được dùng bởi tiến trình khác. Tắt tiến trình đó hoặc đổi GUI_PORT trong .env.`,
          ),
        );
      } else {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : fmtHost(host)}:${port}`;
  console.log(`[news-poster-gui] GUI server listening: ${url}`);
  return url;
}