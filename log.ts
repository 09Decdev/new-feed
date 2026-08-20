/**
 * T6 — in-memory ring-buffer logger with monotonic `seq`/`firstSeq`/`lastSeq`.
 *
 * `installConsoleCapture` wraps console.log/warn/error: every line is (a) recorded
 * in the ring buffer (≤1000 lines, oldest dropped) AND (b) still forwarded to the
 * original stdout — so PM2 logs stay intact.
 *
 * Every line passes through the shared sanitizer before entering the buffer
 * (never log a token / API key / secret — threat model C12). The secret list is
 * live-updatable via `setLogSecrets` (server refreshes it after config/session changes).
 *
 * Contract for GET /api/logs?since=<seq>&filter=<text>:
 *   ┌ `seed` sequential and monotonic per process (never reused after a bump/drop).
 *   └ Response: `{ lines:[{seq,level,ts,message}], firstSeq, lastSeq, reset }`.
 *     `reset=true` when the client's `since` fell behind the buffer (must backfill).
 */

import { sanitize } from './sanitize';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogLine {
  seq: number;
  level: LogLevel;
  ts: number;
  message: string;
}

export interface LogsResponse {
  lines: LogLine[];
  firstSeq: number;
  lastSeq: number;
  reset: boolean;
}

const MAX_LINES = 1000;
const MAX_LINE_CHARS = 2000; // P2 — truncate pathological single lines
const MAX_BUFFER_BYTES = 1024 * 1024; // P2 — hard byte cap (1MB) on retained messages

const ring: LogLine[] = [];
let seq = 0;
let firstSeq = 0; // seq of the oldest retained line (0 while empty)
let bufferBytes = 0; // sum of Buffer.byteLength(message) in ring
let secrets: readonly string[] = [];

/** Live-updatable secret list — server refreshes after config/session changes. */
export function setLogSecrets(next: readonly string[]): void {
  secrets = next;
}

function truncateLine(s: string): string {
  if (s.length <= MAX_LINE_CHARS) return s;
  let end = MAX_LINE_CHARS;
  // R2-7: never cut inside a surrogate pair (avoids U+FFFD). A trailing high surrogate
  // means the low half follows → include it.
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end += 1;
  return s.slice(0, end) + `… (truncated ${s.length - MAX_LINE_CHARS} chars)`;
}

function push(level: LogLevel, args: unknown[]): void {
  const message = truncateLine(sanitize(args.map(String).join(' '), secrets));
  ring.push({ seq: ++seq, level, ts: Date.now(), message });
  bufferBytes += Buffer.byteLength(message);
  // Enforce the 1MB byte cap first (oldest dropped), then the line-count cap.
  while (bufferBytes > MAX_BUFFER_BYTES && ring.length > 1) {
    bufferBytes -= Buffer.byteLength(ring[0].message);
    ring.shift();
  }
  if (ring.length > MAX_LINES) {
    bufferBytes -= Buffer.byteLength(ring[0].message);
    ring.shift();
  }
  firstSeq = ring.length ? ring[0].seq : seq;
}

export function readLogs(opts?: { since?: number; filter?: string }): LogsResponse {
  const since = opts?.since;
  // M5: 'all' (and empty) is semantically "no filter" — pass everything through.
  const rawFilter = (opts?.filter || '').trim().toLowerCase();
  const filter = rawFilter === 'all' ? '' : rawFilter;
  let reset = false;
  let lines = ring.slice();
  if (since !== undefined && Number.isFinite(since)) {
    // R2-1: reset on restart-stale clients too — after a process restart `seq` restarts
    // low, so a client holding an old `since` is AHEAD of us (since > lastSeq) and would
    // otherwise spin on an empty filter until seq catches up. Both edges → reset+backlog.
    if (since < firstSeq || since > seq) {
      reset = true; // client is behind the buffer OR came from a previous process
    } else {
      lines = lines.filter((l) => l.seq > since);
    }
  }
  if (filter) {
    lines = lines.filter(
      (l) => l.message.toLowerCase().includes(filter) || l.level.includes(filter),
    );
  }
  return { lines, firstSeq, lastSeq: seq, reset };
}

let installed = false;

/** Install console capture (idempotent). Still prints to the original stdout. */
export function installConsoleCapture(): void {
  if (installed) return;
  installed = true;
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args: unknown[]) => {
    push('info', args);
    original.log(...args);
  };
  console.warn = (...args: unknown[]) => {
    push('warn', args);
    original.warn(...args);
  };
  console.error = (...args: unknown[]) => {
    push('error', args);
    original.error(...args);
  };
}