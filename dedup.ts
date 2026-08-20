import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { atomicWrite, atomicWriteSync } from './config-store';

/**
 * Dedup + post history (T2).
 *
 * - `hashKey` is UNCHANGED (backward-compat dedup: old keys keep matching).
 * - `PostedEntry` is extended to `{ key, title, link, postId?, status, reason?, humanMessage?, ts }`.
 * - `markPosted` records posted AND failed entries (failed entries are NOT retried — decision GATE 2),
 *   merges legacy `{key, ts}` entries in place, caps the file at 1000, and writes atomically.
 * - `listHistory` sorts ts DESC, filters by status, default limit 100, hard cap 1000.
 */

export interface PostedEntry {
  key: string;
  ts: number;
  title?: string;
  link?: string;
  postId?: string;
  status?: 'posted' | 'skipped' | 'failed';
  reason?: string;
  humanMessage?: string;
}

export type PostStatus = 'posted' | 'skipped' | 'failed';

export interface PostHistoryQuery {
  limit?: number;
  status?: PostStatus;
}

const MAX = 1000;

export function load(file: string): PostedEntry[] {
  try {
    if (!existsSync(file)) return [];
    const arr = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function hashKey(link: string): string {
  return createHash('sha256').update(link).digest('hex');
}

export function isPosted(file: string, key: string): boolean {
  return load(file).some((e) => e.key === key);
}

/**
 * Record one processed item. Async atomic write (used by the bot loop / one-shot).
 * Merges legacy `{key, ts}` entries in place instead of pushing a duplicate key.
 */
export async function markPosted(file: string, entry: PostedEntry): Promise<void> {
  return updatePosted(file, entry, true);
}

/** Synchronous variant for call sites that cannot await. */
export function markPostedSync(file: string, entry: PostedEntry): void {
  void updatePosted(file, entry, false);
}

async function updatePosted(file: string, entry: PostedEntry, asyncWrite: boolean): Promise<void> {
  const arr = load(file);
  const existing = arr.find((e) => e.key === entry.key);
  if (existing) {
    // Legacy `{key,ts}` (no status) → upgrade in place.
    if (!existing.status && (entry.status === 'posted' || entry.status === 'failed')) {
      existing.title = entry.title;
      existing.link = entry.link;
      existing.postId = entry.postId;
      existing.status = entry.status;
      existing.reason = entry.reason;
      existing.humanMessage = entry.humanMessage;
      existing.ts = entry.ts;
    } else {
      // Already recorded (posted on a previous cycle) → keep original, do not duplicate.
      return;
    }
  } else {
    arr.push(entry);
  }
  const trimmed = arr.length > MAX ? arr.slice(arr.length - MAX) : arr;
  const content = JSON.stringify(trimmed, null, 2);
  if (asyncWrite) await atomicWrite(file, content);
  else atomicWriteSync(file, content);
}

/** Read history: sort ts DESC, filter by status, limit (default 100, hard cap 1000).
 *  Legacy `{key, ts}` entries (pre-T2, no status) are rendered as `status:'posted'`
 *  for filter purposes — they are never dropped from a status-filtered view. */
export function listHistory(file: string, q?: PostHistoryQuery): PostedEntry[] {
  const arr = load(file);
  const filtered = q?.status ? arr.filter((e) => (e.status ?? 'posted') === q.status) : arr.slice();
  filtered.sort((a, b) => b.ts - a.ts);
  const limit = q?.limit === undefined ? 100 : Math.max(0, Math.min(1000, Math.floor(q.limit)));
  return filtered.slice(0, limit);
}