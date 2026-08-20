/**
 * Config store (T3) — typed `.env` load/serialize + mask + Windows-safe atomic write.
 *
 * Design contract (§3.1–§3.6):
 *  - `loadConfig` reads `.env` directly (NOT via process.env) → typed `Config` (+ GUI_*).
 *  - `applyUpdates` writes ONLY the allowlist; unknown fields are rejected;
 *    secret re-set goes through `*_SET` tri-state (absent = keep, value = write, '' = delete);
 *    foreign lines / comments are preserved (round-trip safe).
 *  - `toPublic` masks secrets as `{ set: true|false }` — never leaks values.
 *  - `atomicWrite` / `atomicWriteSync` : temp file in same dir → flush → rename;
 *    retry ≤3 with backoff on EPERM/EBUSY; original file is left untouched on failure.
 *  - `applyUpdates` syncs each changed key back into `process.env` (or deletes it when
 *    cleared), including the exact secret key — that IS the reload path (round-2: the old
 *    `reloadEnvAllowlist` was dead code and could resurrect deleted env keys → removed).
 */

import { promises as fsp, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import * as path from 'node:path';
import { buildDeviceInfo, type DeviceInfo } from './auth.client';
import { validateLlmBaseUrlStatic } from './safe-fetch';

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

export interface Config {
  gatewayUrl: string; // GATEWAY_URL
  googleClientId: string; // GOOGLE_CLIENT_ID_WEB (not writable via GUI)
  googleClientSecret: string; // GOOGLE_CLIENT_SECRET_WEB (secret)
  googleRedirectUri: string; // GOOGLE_OAUTH_REDIRECT_URI (not writable via GUI)
  googlePort: number; // GOOGLE_OAUTH_PORT
  communityId: string; // COMMUNITY_ID
  layoutType: string; // LAYOUT_TYPE
  rssUrl: string; // RSS_FEED_URL
  rssLimit: number; // RSS_LIMIT_PER_CYCLE
  intervalMs: number; // POST_INTERVAL_MS
  dryRun: boolean; // DRY_RUN
  sessionFile: string; // SESSION_FILE
  dedupFile: string; // DEDUP_FILE
  device: DeviceInfo; // DEVICE_INSTALLATION_ID / DEVICE_FINGERPRINT
  rewriteWithAi: boolean; // REWRITE_WITH_AI
  llmBaseUrl: string; // LLM_BASE_URL
  llmApiKey: string; // LLM_API_KEY (secret)
  llmModel: string; // LLM_MODEL
  // GUI_* + operational extras
  guiHost: string; // GUI_HOST (default 127.0.0.1)
  guiPort: number; // GUI_PORT (default 8899)
  guiToken: string; // GUI_TOKEN (secret — only {set} exposed)
  lockFile: string; // LOOP_LOCK_FILE (default loop.lock)
  envFile: string; // path of the .env being loaded
}

export type PublicConfig = Record<string, unknown>;

/** Fields a GUI/user may write back to `.env`. Anything else → reject 400. */
export const WRITE_ALLOWLIST_ENV: string[] = [
  'RSS_FEED_URL',
  'RSS_LIMIT_PER_CYCLE',
  'POST_INTERVAL_MS',
  'COMMUNITY_ID',
  'LAYOUT_TYPE',
  'DRY_RUN',
  'REWRITE_WITH_AI',
  'LLM_BASE_URL',
  'LLM_MODEL',
];

/** Secret re-set fields (tri-state via `*_SET`). */
export const SECRET_SET_ENV: string[] = ['LLM_API_KEY_SET', 'GOOGLE_CLIENT_SECRET_WEB_SET'];

/** Non-secret keys synced back into process.env during in-cycle reload (T4). */
export const RELOAD_ENV_ALLOWLIST: string[] = [
  'RSS_FEED_URL',
  'RSS_LIMIT_PER_CYCLE',
  'POST_INTERVAL_MS',
  'COMMUNITY_ID',
  'LAYOUT_TYPE',
  'DRY_RUN',
  'REWRITE_WITH_AI',
  'LLM_BASE_URL',
  'LLM_MODEL',
];

const SECRET_BASE_TO_ENV: Record<string, string> = {
  LLM_API_KEY_SET: 'LLM_API_KEY',
  GOOGLE_CLIENT_SECRET_WEB_SET: 'GOOGLE_CLIENT_SECRET_WEB',
};

// ---------------------------------------------------------------------------
// .env parsing
// ---------------------------------------------------------------------------

interface DotEnv {
  values: Record<string, string>;
  keyIndex: Map<string, number>;
  lines: string[];
}

function parseEnvFile(file: string): DotEnv {
  let lines: string[] = [];
  try {
    const raw = readFileSync(file, 'utf8');
    lines = raw.split(/\r?\n/);
  } catch {
    lines = [];
  }
  const values: Record<string, string> = {};
  const keyIndex = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trimEnd();
    if (val.length >= 2) {
      const q = val[0];
      const last = val[val.length - 1];
      if ((q === '"' && last === '"') || (q === "'" && last === "'")) {
        val = val.slice(1, -1);
        if (q === '"') val = val.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
    }
    values[key] = val;
    keyIndex.set(key, i);
  }
  return { values, keyIndex, lines };
}

function serializeValue(v: string): string {
  // Neutralize CR/LF so a value containing raw newlines can never inject extra .env lines.
  const escaped = v.replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/"/g, '\\"');
  if (/[\s#"']/.test(v)) {
    return '"' + escaped + '"';
  }
  return escaped;
}

// ---------------------------------------------------------------------------
// Typed load (reads the file directly — not process.env)
// ---------------------------------------------------------------------------

function num(values: Record<string, string>, key: string, def: number): number {
  const v = values[key];
  if (v === undefined || v === '') return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function bool(values: Record<string, string>, key: string, def: boolean): boolean {
  const v = values[key];
  if (v === undefined || v === '') return def;
  return String(v).toLowerCase() === 'true';
}

// Keys that may legitimately come from process.env only (PM2 env block, shell-set).
const KNOWN_KEYS = [
  'GATEWAY_URL',
  'GOOGLE_CLIENT_ID_WEB',
  'GOOGLE_CLIENT_SECRET_WEB',
  'GOOGLE_OAUTH_REDIRECT_URI',
  'GOOGLE_OAUTH_PORT',
  'COMMUNITY_ID',
  'LAYOUT_TYPE',
  'RSS_FEED_URL',
  'RSS_LIMIT_PER_CYCLE',
  'POST_INTERVAL_MS',
  'DRY_RUN',
  'SESSION_FILE',
  'DEDUP_FILE',
  'DEVICE_INSTALLATION_ID',
  'DEVICE_FINGERPRINT',
  'REWRITE_WITH_AI',
  'LLM_BASE_URL',
  'LLM_API_KEY',
  'LLM_MODEL',
  'GUI_HOST',
  'GUI_PORT',
  'GUI_TOKEN',
  'LOOP_LOCK_FILE',
];

/**
 * Semantics (Major: env-var-only regression fix): `.env` file is the DEFAULT,
 * `process.env` OVERRIDES it. This restores old modeRun behavior where a shell /
 * PM2 / dotenv block could supply feeds, gateway, LLM key, etc. without a file change.
 * Empty-string env vars are treated as absent (so a cleared secret does not resurrect).
 */
function mergedValues(file: string): Record<string, string> {
  const { values: fileVals } = parseEnvFile(file);
  const values: Record<string, string> = { ...fileVals };
  for (const k of KNOWN_KEYS) {
    const ev = process.env[k];
    if (ev !== undefined && ev !== '') values[k] = ev;
  }
  return values;
}

// ---------------------------------------------------------------------------
// Explicitly-cleared secrets (round-2 finding): once the GUI clears a secret via
// `_SET=''`, the in-memory swapConfig carry-over must NOT resurrect it on reload.
// ---------------------------------------------------------------------------

let clearedSecretsSink: Set<string> | null = null;

/** Register the controller's cleared-secret set (or null to stop observing). */
export function watchClearedSecrets(sink: Set<string> | null): void {
  clearedSecretsSink = sink;
}

export function loadConfig(file = '.env'): Config {
  const values = mergedValues(file);
  const port = num(values, 'GOOGLE_OAUTH_PORT', 8787);
  const lockValue = values.LOOP_LOCK_FILE || 'loop.lock';
  return {
    gatewayUrl: values.GATEWAY_URL || 'http://localhost:3005',
    googleClientId: values.GOOGLE_CLIENT_ID_WEB || '',
    googleClientSecret: values.GOOGLE_CLIENT_SECRET_WEB || '',
    googleRedirectUri: values.GOOGLE_OAUTH_REDIRECT_URI || `http://localhost:${port}/callback`,
    googlePort: port,
    communityId: values.COMMUNITY_ID || '',
    layoutType: values.LAYOUT_TYPE || 'CLASSIC',
    rssUrl: values.RSS_FEED_URL || 'https://vnexpress.net/rss/tin-moi-nhat.rss',
    rssLimit: num(values, 'RSS_LIMIT_PER_CYCLE', 1),
    intervalMs: num(values, 'POST_INTERVAL_MS', 900000),
    dryRun: bool(values, 'DRY_RUN', false),
    sessionFile: values.SESSION_FILE || '.session.json',
    dedupFile: values.DEDUP_FILE || 'posted.json',
    device: buildDeviceInfo(values as NodeJS.ProcessEnv),
    rewriteWithAi: bool(values, 'REWRITE_WITH_AI', true),
    llmBaseUrl: values.LLM_BASE_URL || 'https://api.ai-box.vn',
    llmApiKey: values.LLM_API_KEY || '',
    llmModel: values.LLM_MODEL || 'deepseek-v4-flash[1m]',
    guiHost: values.GUI_HOST || '127.0.0.1',
    guiPort: num(values, 'GUI_PORT', 8899),
    guiToken: values.GUI_TOKEN || '',
    // Absolute lockfile path anchored to the .env directory → one lock per deployment,
    // regardless of process.cwd() (minor fix).
    lockFile: path.isAbsolute(lockValue) ? lockValue : path.resolve(path.dirname(path.resolve(file)), lockValue),
    envFile: path.resolve(file),
  };
}

/** Mask secrets — single source of truth for every GET config/status response. */
export function toPublic(cfg: Config): PublicConfig {
  return {
    RSS_FEED_URL: cfg.rssUrl,
    RSS_LIMIT_PER_CYCLE: cfg.rssLimit,
    POST_INTERVAL_MS: cfg.intervalMs,
    COMMUNITY_ID: cfg.communityId,
    LAYOUT_TYPE: cfg.layoutType,
    DRY_RUN: cfg.dryRun,
    REWRITE_WITH_AI: cfg.rewriteWithAi,
    LLM_BASE_URL: cfg.llmBaseUrl,
    LLM_MODEL: cfg.llmModel,
    GOOGLE_CLIENT_SECRET_WEB: { set: !!cfg.googleClientSecret },
    LLM_API_KEY: { set: !!cfg.llmApiKey },
    GUI_HOST: cfg.guiHost,
    GUI_PORT: cfg.guiPort,
    GUI_TOKEN: { set: !!cfg.guiToken },
  };
}

// ---------------------------------------------------------------------------
// Serialize + write (allowlist only, tri-state _SET, preserve foreign lines)
// ---------------------------------------------------------------------------

export interface ApplyResult {
  written: string[]; // env keys that were set/changed
  deleted: string[]; // env keys that were removed (secret cleared)
}

/** Validate one writable field and normalize it to its serialized string form. */
function normalizeFieldValue(key: string, value: unknown): string {
  switch (key) {
    case 'RSS_LIMIT_PER_CYCLE':
    case 'POST_INTERVAL_MS': {
      const n = typeof value === 'number' ? value : parseInt(String(value), 10);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`Invalid value for ${key}: must be a positive integer`);
      }
      return String(n);
    }
    case 'DRY_RUN':
    case 'REWRITE_WITH_AI': {
      if (typeof value === 'boolean') return String(value);
      const s = String(value).toLowerCase();
      if (s === 'true' || s === 'false') return s;
      throw new Error(`Invalid value for ${key}: must be a boolean`);
    }
    case 'RSS_FEED_URL':
    case 'COMMUNITY_ID':
    case 'LAYOUT_TYPE':
    case 'LLM_MODEL': {
      if (value === null || value === undefined) throw new Error(`Invalid value for ${key}`);
      const s = String(value).trim();
      if (!s) throw new Error(`Invalid value for ${key}: must not be empty`);
      return s;
    }
    case 'LLM_BASE_URL': {
      if (value === null || value === undefined) throw new Error(`Invalid value for ${key}`);
      const s = String(value).trim();
      if (!s) throw new Error(`Invalid value for ${key}: must not be empty`);
      // Reject file://, ftp://, http:// tới public host, private/metadata targets —
      // guards LLM_API_KEY exfil (Threat C9). http được phép CHỈ cho loopback/private LAN đã khai báo.
      validateLlmBaseUrlStatic(s);
      return s;
    }
    default:
      throw new Error(`Unknown config field: ${key}`);
  }
}

/** Merge env-key changes into the original lines, preserving comments and foreign lines. */
function applyLineChanges(env: DotEnv, changes: Map<string, string | undefined>): string {
  const remove = new Set<number>();
  for (const [key, val] of changes) {
    if (val === undefined && env.keyIndex.has(key)) remove.add(env.keyIndex.get(key)!);
  }
  const out: string[] = [];
  for (let i = 0; i < env.lines.length; i++) {
    if (!remove.has(i)) out.push(env.lines[i]);
  }
  const lineIndex = new Map<string, number>();
  for (let i = 0; i < out.length; i++) {
    const m = out[i].match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m) lineIndex.set(m[1], i);
  }
  const appended: string[] = [];
  for (const [key, val] of changes) {
    if (val === undefined) continue;
    const line = `${key}=${serializeValue(val)}`;
    const idx = lineIndex.get(key);
    if (idx != null) out[idx] = line;
    else appended.push(line);
  }
  let joined = out.join('\n');
  if (appended.length) {
    if (joined.length > 0 && !joined.endsWith('\n')) joined += '\n';
    joined += appended.join('\n') + '\n';
  }
  return joined;
}

/**
 * Apply updates supplied by the GUI POST /api/config body.
 * Only allowlist keys accepted; secrets via `*_SET` tri-state.
 * Writes atomically. Throws on validation error (file untouched).
 */
export async function applyUpdates(file: string, payload: Record<string, unknown>): Promise<ApplyResult> {
  const env = parseEnvFile(file);
  const changes = new Map<string, string | undefined>();
  const written: string[] = [];
  const deleted: string[] = [];

  for (const rawKey of Object.keys(payload)) {
    const value = payload[rawKey];
    if (rawKey.endsWith('_SET')) {
      const base = SECRET_BASE_TO_ENV[rawKey];
      if (!base) throw new Error(`Unknown config field: ${rawKey}`);
      if (value === undefined || value === null) continue; // absent → keep current secret
      if (value === '') {
        changes.set(base, undefined);
        deleted.push(base);
        // Round-2: remember this secret was explicitly cleared so in-memory
        // carry-over (swapConfig) cannot resurrect it on the next config reload.
        if (clearedSecretsSink) clearedSecretsSink.add(base);
      } else if (typeof value === 'string' && value.trim()) {
        changes.set(base, value.trim());
        written.push(base);
        if (clearedSecretsSink) clearedSecretsSink.delete(base);
      } else {
        throw new Error(`Invalid value for ${rawKey}`);
      }
      continue;
    }
    if (!WRITE_ALLOWLIST_ENV.includes(rawKey)) {
      throw new Error(`Unknown config field: ${rawKey}`);
    }
    const normalized = normalizeFieldValue(rawKey, value);
    changes.set(rawKey, normalized);
    written.push(rawKey);
  }

  if (changes.size === 0) return { written: [], deleted: [] };

  const content = applyLineChanges(env, changes);
  try {
    await atomicWrite(file, content);
  } catch (e: any) {
    // R2-4: tag system-level write faults so the GUI can answer 500 (not 400 VALIDATION).
    const err = new Error(`Không ghi được tệp cấu hình ${file}: ${e?.message ?? String(e)}`);
    (err as any).code = 'CONFIG_WRITE_FAILED';
    throw err;
  }
  // Sync back — non-secrets through the allowlist, changed secrets to their exact key.
  const reparsed = parseEnvFile(file);
  for (const key of changes.keys()) {
    if (reparsed.values[key] !== undefined) {
      process.env[key] = reparsed.values[key];
    } else {
      delete process.env[key]; // cleared secret — never leave a stale value behind
    }
  }
  return { written, deleted };
}

// ---------------------------------------------------------------------------
// Atomic write (Windows-safe, shared by .env / posted.json / .session.json)
// ---------------------------------------------------------------------------

function resolveRetries(opts?: { retries?: number }): number {
  const n = opts?.retries ?? 3;
  return Number.isInteger(n) && n > 0 ? n : 3;
}

function isTransientFsError(e: any): boolean {
  return e?.code === 'EPERM' || e?.code === 'EBUSY' || e?.code === 'EACCES';
}

function backoff(attempt: number): Promise<void> {
  return new Promise((r) => setTimeout(r, 50 * attempt));
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function tmpPathFor(file: string): string {
  const dir = path.dirname(path.resolve(file));
  return path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
}

/** Async atomic write: temp file (same dir) → flush → rename; retry ≤3 on EPERM/EBUSY. */
export async function atomicWrite(file: string, content: string, opts?: { retries?: number }): Promise<void> {
  const retries = resolveRetries(opts);
  const tmp = tmpPathFor(file);
  for (let attempt = 1; attempt <= retries; attempt++) {
    let fh: fsp.FileHandle | undefined;
    try {
      fh = await fsp.open(tmp, 'w');
      await fh.writeFile(content, 'utf8');
      await fh.sync();
      await fh.close();
      fh = undefined;
      try {
        await fsp.rename(tmp, file);
        return;
      } catch (e: any) {
        if (isTransientFsError(e) && attempt < retries) {
          await backoff(attempt);
          continue;
        }
        throw e;
      }
    } catch (e: any) {
      if (fh) await fh.close().catch(() => {});
      await fsp.unlink(tmp).catch(() => {});
      if (attempt < retries) {
        await backoff(attempt);
        continue;
      }
      throw new Error(`atomicWrite fail ${file}: ${e?.message ?? String(e)}`);
    }
  }
}

/** Synchronous atomic write (kept for call sites that were synchronous: markPosted / saveSession). */
export function atomicWriteSync(file: string, content: string, opts?: { retries?: number }): void {
  const retries = resolveRetries(opts);
  const tmp = tmpPathFor(file);
  for (let attempt = 1; attempt <= retries; attempt++) {
    let fd: number | undefined;
    try {
      fd = openSync(tmp, 'w');
      writeFileSync(fd, content, 'utf8');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      try {
        renameSync(tmp, file);
        return;
      } catch (e: any) {
        if (isTransientFsError(e) && attempt < retries) {
          sleepSync(50 * attempt);
          continue;
        }
        throw e;
      }
    } catch (e: any) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          /* ignore */
        }
      }
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      if (attempt < retries) {
        sleepSync(50 * attempt);
        continue;
      }
      throw new Error(`atomicWrite fail ${file}: ${e?.message ?? String(e)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Env sync helpers (T4)
// ---------------------------------------------------------------------------

/** Re-read the file and sync an explicit set of env keys (used after a secret write). */
export async function syncEnvKeys(file: string, keys: string[]): Promise<void> {
  const { values } = parseEnvFile(file);
  for (const k of keys) {
    if (values[k] !== undefined) process.env[k] = values[k];
  }
}

/** Direct file read (no process.env) of the non-secret allowlist + all keys, for tests. */
export function readEnv(file: string): Record<string, string> {
  return parseEnvFile(file).values;
}