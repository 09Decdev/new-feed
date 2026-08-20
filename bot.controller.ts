/**
 * BotController (T1/T4/T23-core) — wraps the former `modeRun` loop as a singleton
 * with a real state machine: STOPPED → STARTING → RUNNING → STOPPING → STOPPED | ERROR.
 *
 * Semantics preserved VERBATIM from `poster.ts modeRun`:
 *  - 401 → refresh + retry once
 *  - profanity → re-rewrite avoiding flagged words, retry ≤2
 *  - scrape fail → teaser (`buildContent`); image fail → text-only
 *  - `saveSession` every cycle; stop-flag checked between batch items
 *
 * New in this wave:
 *  - abortable sleep (Stop ≤5s while idle between cycles)
 *  - history entries are written for EVERY processed item (posted + failed, no retry of failed links)
 *  - config is reloaded from the config-store at the top of every cycle (T4)
 *  - single-instance loop lock (T23 baseline: `{pid, startedAt}`, atomic `wx`, stale detect)
 *  - GUI path failures land in ERROR state WITHOUT process.exit; CLI path exits via the caller.
 */

import { EventEmitter } from 'node:events';
import { promises as fsp } from 'node:fs';
import type { Session } from './session';
import { loadSession, saveSession } from './session';
import { getAccessToken, type DeviceInfo } from './auth.client';
import { getMyMemberPermission, hasPostPermission, type MemberPermission } from './community.client';
import { fetchRssItems, fetchArticleBody, buildContent, type RssItem } from './rss';
import { hashKey, isPosted, markPosted, listHistory } from './dedup';
import { loadConfig, toPublic, watchClearedSecrets, type Config, type PublicConfig } from './config-store';
import { sanitize, stripUrlQuery } from './sanitize';
import { safeFetchDownload, validateLlmBaseUrl, SafeUrlError } from './safe-fetch';
import { uploadImage } from './upload.client';
import { rewriteArticle } from './llm.client';
import { createPost, describeError } from './content-service.client';

// ---------------------------------------------------------------------------
// Error envelope shared with the GUI server (Wave 2 reuses this).
// ---------------------------------------------------------------------------

export interface ApiErrorInit {
  statusCode: number;
  code: string;
  message: string;
  retryable?: boolean;
}

export class ApiError extends Error {
  statusCode: number;
  code: string;
  retryable: boolean;

  constructor(init: ApiErrorInit) {
    super(init.message);
    this.name = 'ApiError';
    this.statusCode = init.statusCode;
    this.code = init.code;
    this.retryable = !!init.retryable;
  }
}

// ---------------------------------------------------------------------------
// Controller types
// ---------------------------------------------------------------------------

export type BotState = 'STOPPED' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'ERROR';

export interface CycleProgress {
  done: number;
  total: number;
}

export interface PostResult {
  ok: boolean;
  title?: string;
  postId?: string;
  reason?: string;
  humanMessage?: string;
  ts: number;
}

export interface StatusSnapshot {
  state: BotState;
  errorMessage?: string;
  errorDetail?: string;
  humanMessage?: string;
  startedAt?: number;
  lastCycleAt?: number;
  cycleCount: number;
  postedToday: number;
  cycleProgress: CycleProgress | null;
  lastPostResult?: PostResult;
  config: PublicConfig;
  auth: { hasSession: boolean };
  lock: { held: boolean; lockHeldBy?: number; stale: boolean };
}

interface LoopLockPayload {
  pid: number;
  startedAt: number;
}

const STATE_LABEL: Record<BotState, string> = {
  STOPPED: 'STOPPED',
  STARTING: 'STARTING',
  RUNNING: 'RUNNING',
  STOPPING: 'STOPPING',
  ERROR: 'ERROR',
};

const STALE_LOCK_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ---------------------------------------------------------------------------
// Pure helpers (exported so `poster.ts` one-shot modes share them)
// ---------------------------------------------------------------------------

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Sleep that resolves immediately when the signal is aborted (Stop ≤5s guarantee). */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

type RewriteCfg = Pick<Config, 'rewriteWithAi' | 'llmApiKey' | 'llmBaseUrl' | 'llmModel'>;

/** Collect currently-known secret values so sanitize() can redact them from any message. */
export function collectSecrets(
  cfg?: { llmApiKey?: string; googleClientSecret?: string; guiToken?: string },
  session?: { platformAccessToken?: string; googleRefreshToken?: string; platformRefreshToken?: string },
): string[] {
  const out: string[] = [];
  const push = (v?: string) => {
    if (typeof v === 'string' && v.length >= 4) out.push(v);
  };
  push(cfg?.llmApiKey);
  push(cfg?.googleClientSecret);
  push(cfg?.guiToken);
  push(session?.platformAccessToken);
  push(session?.googleRefreshToken);
  push(session?.platformRefreshToken);
  return out;
}

export async function buildRewrittenContent(
  cfg: RewriteCfg,
  item: RssItem,
  scraped: string | null,
  bannedOverride?: string[],
  secrets?: readonly string[],
): Promise<string> {
  if (!scraped) return buildContent(item); // no body → teaser
  if (cfg.rewriteWithAi) {
    if (!cfg.llmApiKey) {
      console.error(
        '[LLM]  REWRITE_WITH_AI=true but LLM_API_KEY missing — fallback to teaser',
      );
      return buildContent(item);
    }
    // SSRF guard: a private/loopback/downgraded LLM_BASE_URL could exfil LLM_API_KEY.
    // Runtime gate is ASYNC (DNS re-check) so an env edit mid-run cannot bypass it.
    try {
      await assertLlmBaseUrl(cfg.llmBaseUrl);
    } catch (e: any) {
      const reason = e instanceof SafeUrlError ? e.message : String(e?.message ?? e);
      console.error(
        `[LLM]  unsupported LLM_BASE_URL: ${sanitize(reason, secrets)} — fallback to teaser`,
      );
      return buildContent(item);
    }
    try {
      const rewritten = await rewriteArticle({
        baseUrl: cfg.llmBaseUrl,
        apiKey: cfg.llmApiKey,
        model: cfg.llmModel,
        title: item.title,
        body: scraped,
        bannedWordsOverride: bannedOverride,
      });
      if (rewritten) {
        console.log(
          `[LLM]  rewritten (${rewritten.length} chars)${bannedOverride ? ` (retry avoiding: ${bannedOverride.join(', ')})` : ''}`,
        );
        return buildContent(item, rewritten);
      }
    } catch (e: any) {
      console.error(
        `[LLM]  rewrite failed: ${sanitize(e?.message ?? String(e), secrets)} — fallback to teaser`,
      );
    }
    return buildContent(item); // rewrite failed → teaser (avoid raw body)
  }
  return buildContent(item, scraped); // no rewrite → raw scraped body
}

export async function downloadImage(
  url: string,
): Promise<{ bytes: Uint8Array; filename: string; mimeType: string } | null> {
  try {
    const r = await safeFetchDownload(url, {
      timeoutMs: 20000,
      maxBytes: 5 * 1024 * 1024, // >5MB → treat as failure (finding: image size cap)
      headers: { 'User-Agent': 'news-poster/1.0 (+content-service)' },
    });
    if (!r.ok) return null;
    const mimeType = r.mimeType || 'image/jpeg';
    const ext =
      (mimeType.split('/')[1] || 'jpeg').replace(/[^a-z0-9]/gi, '').slice(0, 4) || 'jpg';
    return { bytes: r.bytes, filename: `img-${Date.now()}.${ext}`, mimeType };
  } catch {
    return null; // SSRF-rejected, timeout, or oversize all degrade to text-only
  }
}

export async function prepareImageFileIds(
  cfg: { gatewayUrl: string },
  token: string,
  imageUrl?: string,
  secrets?: readonly string[],
): Promise<string[] | undefined> {
  if (!imageUrl) return undefined;
  const img = await downloadImage(imageUrl);
  if (!img) {
    console.log('[IMG]   image download failed — posting text-only');
    return undefined;
  }
  try {
    const fileId = await uploadImage(cfg.gatewayUrl, token, img);
    console.log(`[IMG]   uploaded -> ${fileId}`);
    return [fileId];
  } catch (e: any) {
    console.error(
      `[IMG]   image upload failed: ${sanitize(e?.message ?? String(e), secrets)} — posting text-only`,
    );
    return undefined;
  }
}

export interface PostOneResult {
  ok: boolean;
  postId?: string;
  status?: number;
  words?: string[];
  reason?: string;
}

/** Profanity rejection if flagged words are present OR the reason code says so (no words). */
export function isProfanityRejection(res: PostOneResult): boolean {
  if (res.words && res.words.length) return true;
  const r = (res.reason || '').toLowerCase();
  return r.startsWith('profanity_rejected') || r.includes('inappropriate_content') || r.includes('40001');
}

export async function postOne(
  cfg: { gatewayUrl: string; communityId: string; layoutType: string },
  accessToken: string,
  content: string,
  label: string,
  fileIds?: string[],
  secrets?: readonly string[],
): Promise<PostOneResult> {
  const input: {
    communityId: string;
    content: string;
    layoutType: string;
    fileIds?: string[];
  } = {
    communityId: cfg.communityId,
    content,
    layoutType: cfg.layoutType,
  };
  if (fileIds && fileIds.length) input.fileIds = fileIds;
  try {
    const result = await createPost(cfg.gatewayUrl, accessToken, input);
    const postId = result?.data?.id || result?.id || '(unknown id)';
    console.log(`[OK]   Posted: "${truncate(label, 60)}" -> ${postId}`);
    return { ok: true, postId };
  } catch (e: any) {
    // Finding: sanitize secrets at value level so the raw reason never leaks into posted.json/logs.
    const reason = sanitize(describeError(e), secrets);
    console.error(`[FAIL] "${truncate(label, 60)}" — ${reason}`);
    const words = Array.isArray(e?.body?.words) ? e.body.words : undefined;
    return { ok: false, status: e?.status, words, reason };
  }
}

// ---------------------------------------------------------------------------
// VN human messages (finding 5)
// ---------------------------------------------------------------------------

const HUMAN_MESSAGES: Record<string, string> = {
  MISSING_COMMUNITY_ID: 'Chưa đặt COMMUNITY_ID — bắt buộc để chạy vòng lặp. Điền vào tab Cấu hình rồi lưu.',
  AUTH_BOOTSTRAP_FAILED: 'Đăng nhập Google/refresh token thất bại. Kiểm tra kết nối mạng hoặc mở lại Google OAuth.',
  NO_POST_PERMISSION: 'Bot không có quyền POST_CONTENT/OWNER trong cộng đồng mục tiêu.',
  PREFLIGHT_FAILED: 'Không lấy được quyền trong cộng đồng — kiểm tra gateway.',
  LOCK_BUSY: 'Đã có vòng lặp khác đang chạy. Tắt nó trước khi Start.',
  LOOP_CYCLE_ERROR: 'Lỗi bất ngờ trong vòng lặp — xem nhật ký để biết chi tiết.',
  LLM_BASE_URL_INVALID: 'LLM_BASE_URL không hợp lệ (chỉ chấp nhận http(s) ra internet). Kiểm tra lại cấu hình.',
  PROFANITY_REJECTED: 'Bài viết bị từ chối do chứa từ vi phạm.',
  UNAUTHORIZED: 'Phiên đăng nhập hết hạn — tài khoản bị từ chối.',
  FORBIDDEN: 'Bị từ chối quyền đăng bài (không phải thành viên / thiếu quyền).',
  SERVER_ERROR: 'Lỗi máy chủ khi đăng bài — thử lại sau.',
  DEFAULT: 'Không đăng được bài.',
};

/** Map an error code/reason to a Vietnamese message; falls back to generic text. */
export function describeForUser(reason?: string): string {
  if (!reason) return 'Không xác định được lỗi.';
  if (reason.startsWith('PROFANITY_REJECTED')) return HUMAN_MESSAGES.PROFANITY_REJECTED;
  if (reason.startsWith('UNAUTHORIZED')) return HUMAN_MESSAGES.UNAUTHORIZED;
  if (reason.startsWith('FORBIDDEN')) return HUMAN_MESSAGES.FORBIDDEN;
  if (reason.startsWith('SERVER_ERROR')) return HUMAN_MESSAGES.SERVER_ERROR;
  return HUMAN_MESSAGES[reason] || `${HUMAN_MESSAGES.DEFAULT} (${reason})`;
}

// ---------------------------------------------------------------------------
// Shared one-shot post executor (T9): single source of truth for BOTH the CLI
// one-shot modes (poster.ts mode=test|rss, kept verbatim) AND the GUI
// POST /api/post route. Runs the same scrape → rewrite → post → history path.
// ---------------------------------------------------------------------------

export interface OneShotPost {
  title: string;
  link: string;
  description: string;
  imageUrl?: string;
  content?: string;
}

type OneShotCfg = {
  dedupFile: string;
  gatewayUrl: string;
  communityId: string;
  layoutType: string;
  rewriteWithAi: boolean;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
};

export interface OneShotRunResult {
  ok: number; // posted count
  failed: number; // failed count
  lastOk?: { title?: string; link?: string; postId?: string };
  lastFailed?: { title?: string; link?: string; reason?: string; humanMessage?: string };
}

export async function runOneShotPosts(
  posts: OneShotPost[],
  mode: 'test' | 'rss',
  cfg: OneShotCfg,
  session: Session,
  accessToken: string,
  dryRun: boolean,
  secrets?: readonly string[],
): Promise<OneShotRunResult> {
  let ok = 0;
  let failed = 0;
  let lastOk: OneShotRunResult['lastOk'];
  let lastFailed: OneShotRunResult['lastFailed'];
  for (const p of posts) {
    if (mode === 'rss' && p.link) {
      const key = hashKey(p.link);
      if (isPosted(cfg.dedupFile, key)) {
        console.log(`[SKIP] already posted: "${truncate(p.title, 60)}"`);
        continue;
      }
    }
    const item = { title: p.title, link: p.link, description: p.description, pubDate: '' } as RssItem;
    const scraped = p.content ? null : await fetchArticleBody(p.link);
    let content = p.content || (await buildRewrittenContent(cfg, item, scraped, undefined, secrets));
    if (dryRun) {
      console.log(`\n[${p.title}]\n${content}\n`);
      continue;
    }
    const fileIds =
      mode === 'rss' ? await prepareImageFileIds(cfg, accessToken, p.imageUrl, secrets) : undefined;
    let res = await postOne(cfg, accessToken, content, p.title, fileIds, secrets);
    let profanityAttempts = 0;
    while (!res.ok && isProfanityRejection(res) && profanityAttempts < 2) {
      profanityAttempts++;
      content = await buildRewrittenContent(cfg, item, scraped, res.words, secrets);
      res = await postOne(cfg, accessToken, content, p.title, fileIds, secrets);
    }
    if (res.ok) {
      ok++;
      lastOk = { title: p.title, link: p.link, postId: res.postId };
      if (mode === 'rss' && p.link) {
        await markPosted(cfg.dedupFile, {
          key: hashKey(p.link),
          title: p.title,
          link: p.link,
          status: 'posted',
          postId: res.postId,
          ts: Date.now(),
        });
        botController.recordPostedNow(); // share the today counter with the running loop
      }
    } else {
      failed++;
      lastFailed = {
        title: p.title,
        link: p.link,
        reason: res.reason,
        humanMessage: res.reason ? `Đăng bài thất bại: ${res.reason}` : 'Đăng bài thất bại.',
      };
    }
  }
  return { ok, failed, lastOk, lastFailed };
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

// ---------------------------------------------------------------------------
// LLM base-URL gate (round-2 major): the runtime per-rewrite check MUST run the
// async DNS validation (not just static), so a config edited while RUNNING cannot
// bypass the gate. Results are cached by URL to avoid a DNS lookup per article;
// a changed config == a changed key == automatic re-validation.
// ---------------------------------------------------------------------------

const LLM_URL_CACHE_TTL_MS = 5 * 60 * 1000;
const llmUrlCache = new Map<string, { at: number; ok: boolean; err?: string }>();

/** Throws SafeUrlError when the LLM provider URL violates policy. Cached per URL. */
async function assertLlmBaseUrl(url: string): Promise<void> {
  const hit = llmUrlCache.get(url);
  if (hit && Date.now() - hit.at < LLM_URL_CACHE_TTL_MS) {
    if (!hit.ok) throw new SafeUrlError(hit.err || 'LLM_BASE_URL bị chặn');
    return;
  }
  try {
    await validateLlmBaseUrl(url);
    llmUrlCache.set(url, { at: Date.now(), ok: true });
  } catch (e: any) {
    const err = e instanceof SafeUrlError ? e.message : String(e?.message ?? e);
    llmUrlCache.set(url, { at: Date.now(), ok: false, err });
    throw new SafeUrlError(err);
  }
}

export class BotController {
  private state: BotState = 'STOPPED';
  /** R2-3: set when start() failed to acquire loop.lock (another process owns it). */
  private lockConflict = false;
  private errorMessage?: string;
  private errorDetail?: string;
  private humanMessage?: string;

  private stoppingFlag = false;
  private sleepAbort = new AbortController();
  private startedAt?: number;
  private lastCycleAt?: number;
  private cycleCount = 0;
  private postedTodayCount = 0;
  private cycleProgress: CycleProgress | null = null;
  private lastPostResult?: PostResult;

  private session: Session = {};
  private config!: Config;
  private lockHeldBy?: number;
  private lockStale = false;

  /** Secrets explicitly cleared via the GUI (`_SET=''`) — blocks swapConfig resurrect. */
  private readonly clearedSecrets = new Set<string>();
  /** Local `YYYY-M-D` key of the postedToday bucket (reset at midnight). */
  private todayStamp = '';

  private readonly envFile: string;
  private readonly emitter = new EventEmitter();
  private readonly stoppedResolvers: Array<() => void> = [];
  private lockPath: string | null = null;

  constructor(opts?: { envFile?: string }) {
    this.envFile = opts?.envFile || '.env';
    this.config = loadConfig(this.envFile);
    watchClearedSecrets(this.clearedSecrets);
  }

  // -- public API -----------------------------------------------------------

  /** Start the loop. Resolves once RUNNING (or ERROR/STOPPED after a cancel). Throws 409 on busy state. */
  async start(): Promise<void> {
    if (this.state === 'STARTING' || this.state === 'RUNNING' || this.state === 'STOPPING') {
      throw new ApiError({
        statusCode: 409,
        code: 'CONFLICT',
        retryable: true,
        message: `Bot đang ${STATE_LABEL[this.state]}`,
      });
    }

    this.stoppingFlag = false;
    this.lockConflict = false;
    this.sleepAbort = new AbortController();
    this.errorMessage = undefined;
    this.humanMessage = undefined;
    this.setState('STARTING');

    // T4: config is always loaded fresh from the config-store (initial seed).
    try {
      this.swapConfig(loadConfig(this.envFile));
    } catch (e: any) {
      this.setError('LOOP_CYCLE_ERROR', sanitize(e?.message ?? String(e)));
      return;
    }
    const cfg = this.config;

    // SSRF guard (Threat C9): a private/loopback LLM_BASE_URL could exfil LLM_API_KEY while the
    // loop runs. Validate the effective base URL (including DNS) before starting.
    if (cfg.rewriteWithAi && cfg.llmApiKey) {
      try {
        await assertLlmBaseUrl(cfg.llmBaseUrl);
      } catch (e: any) {
        const msg = e instanceof SafeUrlError || e instanceof ApiError ? e.message : String(e?.message ?? e);
        console.error(`[news-poster] LLM_BASE_URL rejected: ${sanitize(msg)}`);
        // R2-2: stop() during this await → land STOPPED, not ERROR.
        if (this.stoppingFlag) {
          this.setState('STOPPED');
          return;
        }
        this.setError('LLM_BASE_URL_INVALID', msg);
        return;
      }
    }

    // Single-instance loop lock (T23).
    try {
      await this.acquireLoopLock(cfg.lockFile);
    } catch (e: any) {
      // R2-3: mark lock-race explicitly (not by string-matching errorMessage later).
      this.lockConflict = true;
      if (this.stoppingFlag) {
        this.setState('STOPPED');
        return;
      }
      if (e instanceof ApiError) {
        this.setError(e.code, e.message);
      } else {
        this.setError('LOCK_ERROR', sanitize(e?.message ?? String(e)));
      }
      return;
    }
    if (this.stoppingFlag) {
      await this.releaseLoopLock();
      this.setState('STOPPED');
      return;
    }

    // Bootstrap platform token.
    this.session = loadSession(cfg.sessionFile);
    try {
      await getAccessToken(this.session, cfg.gatewayUrl, process.env, cfg.device);
      saveSession(cfg.sessionFile, this.session);
    } catch (e: any) {
      const msg = sanitize(e?.message ?? String(e));
      console.error(`[news-poster] Auth bootstrap failed: ${msg}`);
      await this.releaseLoopLock();
      // R2-2: stop() during this pre-flight → land STOPPED, not ERROR.
      if (this.stoppingFlag) {
        this.setState('STOPPED');
        return;
      }
      this.setError('AUTH_BOOTSTRAP_FAILED', msg);
      return;
    }
    if (this.stoppingFlag) {
      await this.releaseLoopLock();
      this.setState('STOPPED');
      return;
    }

    // Pre-flight permission.
    if (!cfg.communityId) {
      console.error('[news-poster] COMMUNITY_ID required for mode=run');
      await this.releaseLoopLock();
      // R2-2: stop() during the awaits above → land STOPPED, not ERROR.
      if (this.stoppingFlag) {
        this.setState('STOPPED');
        return;
      }
      this.setError('MISSING_COMMUNITY_ID', 'COMMUNITY_ID not configured');
      return;
    }
    let perm: MemberPermission | null = null;
    try {
      perm = await getMyMemberPermission(cfg.gatewayUrl, this.session.platformAccessToken!, cfg.communityId);
    } catch (e: any) {
      const msg = sanitize(e?.message ?? String(e));
      console.error(`[news-poster] Pre-flight: cannot fetch permission for ${cfg.communityId}: ${msg}`);
      await this.releaseLoopLock();
      // R2-2
      if (this.stoppingFlag) {
        this.setState('STOPPED');
        return;
      }
      this.setError('PREFLIGHT_FAILED', msg);
      return;
    }
    if (!hasPostPermission(perm)) {
      console.error(
        `[news-poster] Bot lacks POST_CONTENT/OWNER in ${cfg.communityId} (role=${perm?.role || 'none'}). ` +
          'Owner must grant permission. Exiting.',
      );
      await this.releaseLoopLock();
      // R2-2
      if (this.stoppingFlag) {
        this.setState('STOPPED');
        return;
      }
      this.setError('NO_POST_PERMISSION', `role=${perm?.role || 'none'}`);
      return;
    }
    if (this.stoppingFlag) {
      await this.releaseLoopLock();
      this.setState('STOPPED');
      return;
    }

    // Seed the today counter from history so a restart mid-day reports the true count.
    this.todayStamp = this.todayKey();
    this.postedTodayCount = this.seedPostedToday();

    console.log(
      `[news-poster] Pre-flight OK (role=${perm?.role}). Starting loop ` +
        `(interval=${cfg.intervalMs}ms, limit=${cfg.rssLimit}/cycle).`,
    );
    this.setState('RUNNING');
    this.startedAt = Date.now();
    this.runLoop().catch(() => {
      /* terminal state is handled inside runLoop */
    });
  }

  /** Stop after the current cycle/item. Throws 400 (not running) / 409 (already stopping). */
  stop(): void {
    if (this.state === 'STOPPED' || this.state === 'ERROR') {
      throw new ApiError({
        statusCode: 400,
        code: 'BAD_REQUEST',
        message: `Bot đang ${STATE_LABEL[this.state]}`,
      });
    }
    if (this.state === 'STOPPING') {
      throw new ApiError({
        statusCode: 409,
        code: 'CONFLICT',
        retryable: true,
        message: 'Bot đang STOPPING',
      });
    }
    this.stoppingFlag = true;
    this.sleepAbort.abort();
    console.log('\n[news-poster] Stopping after current cycle…');
    this.setState('STOPPING');
  }

  // -- postedToday (round-2 major: correct midnight boundary + seeds) --------------

  private todayKey(): string {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  /** Reset the counter when the local day rolls over. Cheap: called from poll + emit. */
  private syncTodayCounter(): void {
    const k = this.todayKey();
    if (this.todayStamp !== k) {
      this.todayStamp = k;
      this.postedTodayCount = 0;
    }
  }

  /** Bump the today counter (post success). Public so the one-shot CLI path shares it. */
  recordPostedNow(): void {
    this.syncTodayCounter();
    this.postedTodayCount += 1;
  }

  /** Seed the counter from history on start(): posts already made earlier today. */
  private seedPostedToday(): number {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    try {
      return (listHistory(this.config.dedupFile) ?? []).filter(
        (e) => (e.status ?? 'posted') === 'posted' && e.ts >= todayStart,
      ).length;
    } catch {
      return 0;
    }
  }

  /** R2-3: true when the most recent start() attempt failed due to loop.lock ownership. */
  get lockConflictFlag(): boolean {
    return this.lockConflict;
  }

  getStatus(): StatusSnapshot {
    this.syncTodayCounter();
    return {
      state: this.state,
      errorMessage: this.errorMessage,
      errorDetail: this.errorDetail,
      humanMessage: this.humanMessage,
      startedAt: this.startedAt,
      lastCycleAt: this.lastCycleAt,
      cycleCount: this.cycleCount,
      postedToday: this.postedTodayCount,
      cycleProgress: this.cycleProgress,
      lastPostResult: this.lastPostResult,
      config: toPublic(this.config),
      auth: { hasSession: !!this.session.platformAccessToken || !!this.session.googleRefreshToken },
      lock: { held: !!this.lockHeldBy, lockHeldBy: this.lockHeldBy, stale: this.lockStale },
    };
  }

  /** Resolves when the loop reaches a terminal state (STOPPED/ERROR). */
  waitForStopped(): Promise<void> {
    if (this.state === 'STOPPED' || this.state === 'ERROR') return Promise.resolve();
    return new Promise((resolve) => {
      this.stoppedResolvers.push(resolve);
    });
  }

  // used by the future GUI server — typed status events
  on(event: string, cb: (...args: any[]) => void): void {
    this.emitter.on(event, cb);
  }

  /**
   * Run an exclusive operation under the loop lock (CLI one-shot: mode=test|rss / Wave 2 GUI).
   * Reuses the same stale-detection + atomic `wx` semantics as the run loop, so the
   * one-shot path never races the running loop on history/posted.json.
   * Throws ApiError(409 CONFLICT) if another process holds the lock.
   */
  async runWithLoopLock<T>(lockFile: string, fn: () => Promise<T>): Promise<T> {
    await this.acquireLoopLock(lockFile);
    try {
      return await fn();
    } finally {
      await this.releaseLoopLock();
    }
  }

  // -- internals ------------------------------------------------------------

  private setState(s: BotState): void {
    this.state = s;
    if (s === 'STOPPED') {
      this.errorMessage = undefined;
      this.errorDetail = undefined;
      this.humanMessage = undefined;
      this.cycleProgress = null;
    }
    // Finding: reset in-flight progress on ERROR too (otherwise a stale {done,total} lingers).
    if (s === 'ERROR') this.cycleProgress = null;
    if (s === 'STOPPED' || s === 'ERROR') this.resolveStopped();
    this.emitter.emit('state', { state: s });
  }

  private setError(code: string, raw: string): void {
    this.errorMessage = code;
    // Finding: keep the raw (sanitized) detail instead of dropping it behind the code.
    this.errorDetail = sanitize(raw, collectSecrets(this.config, this.session));
    this.humanMessage = describeForUser(code);
    this.setState('ERROR');
    this.resolveStopped();
  }

  private resolveStopped(): void {
    const resolvers = this.stoppedResolvers.splice(0);
    for (const r of resolvers) r();
  }

  private swapConfig(fresh: Config): void {
    const cur = this.config;
    if (cur) {
      // Carry-over exists so an env-only reload never drops secrets the fresh load
      // couldn't see (file default semantics). Round-2: a secret EXPLICITLY cleared via
      // `_SET=''` (tracked in clearedSecrets) must NOT be resurrected by this carry-over.
      const apply = <K extends keyof Config>(envKey: string, field: K): void => {
        const freshVal = fresh[field] as string | undefined;
        const curVal = cur[field] as string | undefined;
        if (freshVal) {
          this.clearedSecrets.delete(envKey); // re-set → forget the clear
          return;
        }
        if (this.clearedSecrets.has(envKey)) return; // actively cleared → never re-add
        if (curVal) (fresh as any)[field] = curVal;
      };
      apply('GOOGLE_CLIENT_ID_WEB', 'googleClientId');
      apply('GOOGLE_CLIENT_SECRET_WEB', 'googleClientSecret');
      apply('GUI_TOKEN', 'guiToken');
      apply('LLM_API_KEY', 'llmApiKey');
      apply('LLM_MODEL', 'llmModel');
    }
    this.config = fresh;
  }

  /** M8 — re-read .env immediately (≈ what a poll/start would do). Keeps current config on failure. */
  reloadConfigNow(): void {
    try {
      this.swapConfig(loadConfig(this.envFile));
    } catch (e: any) {
      console.warn(`[news-poster] Config reload failed: ${sanitize(e?.message ?? String(e))} — keeping current config`);
    }
  }

  // -- loop lock (T23 baseline) ----------------------------------------------

  private async acquireLoopLock(lockFile: string): Promise<void> {
    this.lockPath = lockFile;
    this.lockStale = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const payload: LoopLockPayload = { pid: process.pid, startedAt: Date.now() };
      try {
        await fsp.writeFile(lockFile, JSON.stringify(payload), { flag: 'wx' });
        this.lockHeldBy = process.pid;
        return;
      } catch (e: any) {
        if (e?.code !== 'EEXIST') {
          throw new Error(`cannot create lockfile: ${sanitize(e?.message ?? String(e))}`);
        }
        let existing: LoopLockPayload | null = null;
        try {
          existing = JSON.parse(await fsp.readFile(lockFile, 'utf8')) as LoopLockPayload;
        } catch {
          existing = null;
        }
        const pid = typeof existing?.pid === 'number' ? existing.pid : NaN;
        const startedAt = typeof existing?.startedAt === 'number' ? existing.startedAt : 0;
        const staleByAge = startedAt > 0 && Date.now() - startedAt > STALE_LOCK_AGE_MS;
        if (Number.isInteger(pid) && isPidAlive(pid) && !staleByAge) {
          throw new ApiError({
            statusCode: 409,
            code: 'CONFLICT',
            retryable: true,
            message: `Đã có vòng lặp khác chạy (pid ${pid}). Tắt nó trước khi Start.`,
          });
        }
        // Stale (dead pid / PID reused / too old) → remove and retry once.
        if (staleByAge) {
          console.warn(
            `[news-poster] Lockfile bị cũ hơn 7 ngày (pid ${pid}) — xem là stale và xóa.`,
          );
        } else {
          console.warn(`[news-poster] Lockfile từ process đã chết (pid ${pid}) — xóa và giành lại.`);
        }
        this.lockStale = true; // Finding: surface stale reclaim in getStatus().lock.stale
        await fsp.unlink(lockFile).catch(() => {});
      }
    }
    throw new Error('could not acquire loop lock after clearing stale file');
  }

  private async releaseLoopLock(): Promise<void> {
    this.lockHeldBy = undefined;
    this.lockStale = false;
    if (this.lockPath) {
      await fsp.unlink(this.lockPath).catch(() => {});
      this.lockPath = null;
    }
  }

  // -- the loop -------------------------------------------------------------

  private async runLoop(): Promise<void> {
    try {
      while (!this.stoppingFlag) {
        // T4: reload config from .env every cycle → changes apply next cycle.
        try {
          this.swapConfig(loadConfig(this.envFile));
        } catch (e: any) {
          console.warn(
            `[news-poster] Config reload failed: ${sanitize(e?.message ?? String(e))} — keeping current config`,
          );
        }
        try {
          const r = await this.runOneCycle();
          if (r === false) return; // ERROR already set
          if (this.stoppingFlag) break;
          if (r === 'slept') continue; // cycle already slept for its retry (auth 60s) — no double sleep
        } catch (e: any) {
          this.setError('LOOP_CYCLE_ERROR', sanitize(e?.message ?? String(e)));
          return;
        }
        console.log(`[news-poster] Cycle done. Sleeping ${this.config.intervalMs}ms…`);
        await abortableSleep(this.config.intervalMs, this.sleepAbort.signal);
      }
    } finally {
      try {
        saveSession(this.config.sessionFile, this.session);
      } catch {
        /* best-effort */
      }
      // Release the lock BEFORE announcing STOPPED so that a caller awaiting
      // waitForStopped() and immediately calling start() never self-contends.
      await this.releaseLoopLock();
      if (this.state === 'ERROR') {
        console.log('[news-poster] Loop stopped after error.');
      } else {
        console.log('[news-poster] Stopped. Session saved.');
        this.setState('STOPPED');
      }
    }
  }

  /**
   * One full cycle — token → fetch RSS → dedup → scrape → rewrite → post → history.
   * Behavior kept VERBATIM from the old `modeRun` inner loop.
   * @returns true = cycle done (runLoop sleeps intervalMs); 'slept' = already slept internally
   *          (auth retry) — skip the loop sleep; false = terminal (ERROR already set).
   */
  private async runOneCycle(): Promise<boolean | 'slept'> {
    const cfg = this.config;
    const secrets = collectSecrets(this.config, this.session);

    let accessToken: string;
    try {
      accessToken = await getAccessToken(this.session, cfg.gatewayUrl, process.env, cfg.device);
      saveSession(cfg.sessionFile, this.session);
    } catch (e: any) {
      console.error(`[news-poster] Auth error: ${sanitize(e?.message ?? String(e), secrets)}. Retry in 60s…`);
      await abortableSleep(60000, this.sleepAbort.signal);
      return 'slept';
    }

    let items: RssItem[];
    try {
      console.log(`[news-poster] Fetching RSS: ${stripUrlQuery(cfg.rssUrl)}`);
      items = await fetchRssItems(cfg.rssUrl, cfg.rssLimit);
    } catch (e: any) {
      console.error(`[news-poster] RSS fetch failed: ${sanitize(e?.message ?? String(e), secrets)}. Next cycle.`);
      return true; // single sleep happens in runLoop
    }
    if (items.length === 0) console.log('[news-poster] No RSS items found.');

    this.cycleProgress = { done: 0, total: items.length };

    for (const it of items) {
      if (this.stoppingFlag) break;

      const key = hashKey(it.link || it.title);
      if (isPosted(cfg.dedupFile, key)) {
        console.log(`[SKIP] already posted: "${truncate(it.title, 60)}"`);
        if (this.cycleProgress) this.cycleProgress.done++;
        continue;
      }

      const scraped = await fetchArticleBody(it.link);
      let content = await buildRewrittenContent(cfg, it, scraped, undefined, secrets);
      if (cfg.dryRun) {
        console.log(`[DRY]   would post: "${truncate(it.title, 60)}"\n${content}\n`);
        if (this.cycleProgress) this.cycleProgress.done++;
        continue;
      }

      const fileIds = await prepareImageFileIds(cfg, accessToken, it.imageUrl, secrets);
      let res = await postOne(cfg, accessToken, content, it.title, fileIds, secrets);
      // 401 → refresh + retry once
      if (!res.ok && res.status === 401) {
        try {
          accessToken = await getAccessToken(this.session, cfg.gatewayUrl, process.env, cfg.device);
          saveSession(cfg.sessionFile, this.session);
          res = await postOne(cfg, accessToken, content, it.title, fileIds, secrets);
        } catch (e: any) {
          console.error(
            `[news-poster] refresh-on-401 failed: ${sanitize(e?.message ?? String(e), secrets)}`,
          );
        }
      }
      // profanity → re-rewrite avoiding the flagged words, retry up to 2 times.
      // Finding: also re-rewrite when the rejection is profanity but carried no word list.
      let profanityAttempts = 0;
      while (!res.ok && isProfanityRejection(res) && profanityAttempts < 2) {
        profanityAttempts++;
        content = await buildRewrittenContent(cfg, it, scraped, res.words, secrets);
        res = await postOne(cfg, accessToken, content, it.title, fileIds, secrets);
      }

      const ts = Date.now();
      if (res.ok) {
        await markPosted(cfg.dedupFile, {
          key,
          title: it.title,
          link: it.link || '',
          status: 'posted',
          postId: res.postId,
          ts,
        });
        this.recordPostedNow(); // counter respects midnight reset + one-shot shares this
        this.lastPostResult = {
          ok: true,
          title: it.title,
          postId: res.postId,
          reason: undefined,
          humanMessage: undefined,
          ts,
        };
      } else {
        const reason = res.reason || 'POST_FAILED';
        await markPosted(cfg.dedupFile, {
          key,
          title: it.title,
          link: it.link || '',
          status: 'failed',
          reason,
          humanMessage: describeForUser(reason),
          ts,
        });
        this.lastPostResult = {
          ok: false,
          title: it.title,
          reason,
          humanMessage: describeForUser(reason),
          ts,
        };
      }
      this.emitter.emit('post', this.lastPostResult);
      if (this.cycleProgress) this.cycleProgress.done++;
    }

    this.cycleProgress = null;
    this.lastCycleAt = Date.now();
    this.cycleCount++;
    this.emitter.emit('cycle');
    return true;
  }
}

/** Shared singleton (process-wide). */
export const botController = new BotController();