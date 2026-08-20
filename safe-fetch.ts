/**
 * SSRF-safe fetch (THREAT C9 / DESIGN §10).
 *
 * Guards every outbound fetch whose URL can be influenced by untrusted input
 * (feed item links / images). Rules:
 *  - http(s)-only (rejects file://, ftp://, …)
 *  - blocks private / loopback / link-local / metadata IPs (IPv4 + IPv6 incl. brackets, zones, v4-mapped)
 *  - blocks well-known internal hostnames (localhost, *.local, *.internal, cloud metadata)
 *  - re-checks the resolved IPs via `dns.lookup` (hostname → private IP => rejected)
 *  - redirects are re-validated at every hop, max 3
 *  - every hop gets an AbortSignal.timeout
 *  - response body is streamed with a hard size cap
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { stripUrlQuery } from './sanitize';

export class SafeUrlError extends Error {
  code = 'SAFE_URL_REJECTED';
  constructor(message: string) {
    super(message);
    this.name = 'SafeUrlError';
  }
}

export const MAX_REDIRECTS = 3;
export const DEFAULT_TIMEOUT_MS = 5000; // design §10
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // 2 MiB default; images override to 5 MiB
const USER_AGENT = 'news-poster/1.0 (+content-service)';

// Cloud metadata + internal-only hostnames that must never be reachable.
const BLOCKED_HOSTS = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'instance-data',
  'instance-data.ec2.internal',
]);

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.');
  const n = (i: number): number => {
    const v = Number(parts[i]);
    return Number.isFinite(v) ? v : -1;
  };
  const a = n(0);
  const b = n(1);
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // loopback 127/8
  if (a === 169 && b === 254) return true; // link-local 169.254/16 (incl. metadata IP)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 192 && b === 0) return true; // 192.0.0/24 (IETF bench)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 bench
  if (a === 0) return true; // "this" network
  if (a >= 224) return true; // multicast/reserved
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true; // unspecified + loopback
  if (v.startsWith('fc') || v.startsWith('fd')) return true; // fc00::/7 ULA
  if (/^fe[89ab]/.test(v)) return true; // fe80::/10 link-local
  if (/^fec/.test(v)) return true; // fec0::/10 deprecated site-local
  if (v.startsWith('ff')) return true; // ff00::/8 multicast
  if (v.startsWith('2001:db8')) return true; // documentation
  if (v.startsWith('::ffff:')) {
    // IPv4-mapped, e.g. ::ffff:127.0.0.1 (Node may hex-normalize it: ::ffff:7f00:1)
    const dotted = ipv4MappedToIp(v);
    return dotted ? isPrivateIpv4(dotted) : true; // unparseable → be conservative
  }
  return false;
}

/** Hex tail (2 groups) → dotted quad, e.g. "7f00:1" → "127.0.0.1". Null when unparseable. */
function ipv4FromHexTail(rest: string): string | null {
  const parts = rest.split(':');
  if (parts.length !== 2) return null; // a single group is a full /128 address (e.g. ::1), not IPv4
  try {
    const n0 = parseInt(parts[0].padStart(4, '0'), 16);
    const n1 = parseInt(parts[1].padStart(4, '0'), 16);
    if (!Number.isFinite(n0) || !Number.isFinite(n1)) return null;
    return [(n0 >> 8) & 0xff, n0 & 0xff, (n1 >> 8) & 0xff, n1 & 0xff].join('.');
  } catch {
    return null;
  }
}

/**
 * Convert an IPv4-mapped IPv6 tail to dotted quad, e.g. "::ffff:7f00:1" → "127.0.0.1".
 * Also accepts the dotted literal form "::ffff:127.0.0.1". Returns null when unparseable.
 */
function ipv4MappedToIp(v: string): string | null {
  const suffix = v.slice('::ffff:'.length);
  if (suffix.includes('.') && isIP(suffix) === 4) return suffix; // dotted literal form
  if (suffix.startsWith('0:')) return null; // translated form ::ffff:0:x — handled elsewhere
  return ipv4FromHexTail(suffix);
}

/**
 * IPv4-compatible ("::a.b.c.d" / "::7f00:1", ::/96) and translated ("::ffff:0:a.b.c.d")
 * encodings of an IPv4 address → dotted quad, or null if the tail is not IPv4-shaped.
 */
function embeddedIpv4(v: string): string | null {
  if (v.startsWith('::ffff:0:')) {
    const rest = v.slice('::ffff:0:'.length);
    if (isIP(rest) === 4) return rest;
    return ipv4FromHexTail(rest);
  }
  if (v.startsWith('::ffff:')) return ipv4MappedToIp(v);
  if (v.startsWith('::') && v.length > 2) {
    const rest = v.slice(2);
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rest)) return isIP(rest) === 4 ? rest : null; // ::a.b.c.d
    return ipv4FromHexTail(rest); // "::7f00:1"
  }
  return null;
}

/** True when `ip` is a loopback/private/link-local/metadata address. IPv6 zone ids are rejected. */
export function isPrivateIp(ip: string): boolean {
  const v = String(ip).trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (v.includes('%')) return true; // fe80::1%eth0 — scope info implies link-local
  const embedded = embeddedIpv4(v);
  if (embedded) return isPrivateIpv4(embedded); // mapped / compatible / translated forms
  const kind = isIP(v);
  if (kind === 4) return isPrivateIpv4(v);
  if (kind === 6) return isPrivateIpv6(v);
  return false; // not an IP literal
}

/** Sync validation (no DNS). Throws SafeUrlError. */
export function validatePublicUrlStatic(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch (e: any) {
    throw new SafeUrlError(`URL không hợp lệ ("${stripUrlQuery(raw)}")`);
  }
  const proto = url.protocol;
  if (proto !== 'https:' && proto !== 'http:') {
    throw new SafeUrlError(`Chỉ chấp nhận http/https — nhận "${proto}"`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').trim().toLowerCase();
  if (!host) throw new SafeUrlError('Thiếu hostname');
  if (BLOCKED_HOSTS.has(host)) {
    throw new SafeUrlError(`Host nội bộ bị chặn: "${host}"`);
  }
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.home.arpa')
  ) {
    throw new SafeUrlError(`Host nội bộ bị chặn: "${host}"`);
  }
  if (isIP(host) && isPrivateIp(host)) {
    throw new SafeUrlError(`IP private/link-local bị chặn: "${host}"`);
  }
  return url;
}

/** Full validation: static + DNS re-check of resolved IPs. */
export async function validatePublicUrl(raw: string): Promise<URL> {
  const url = validatePublicUrlStatic(raw);
  const host = url.hostname.replace(/^\[|\]$/g, '').trim().toLowerCase();
  if (isIP(host)) return url; // literal IP already verified
  const addrs = await lookupWithTimeout(host);
  if (!Array.isArray(addrs) || addrs.length === 0) {
    throw new SafeUrlError(`DNS không trả về địa chỉ nào cho "${host}"`);
  }
  for (const a of addrs) {
    if (isPrivateIp(a.address)) {
      throw new SafeUrlError(`"${host}" trỏ về IP private "${a.address}" — bị chặn`);
    }
  }
  return url;
}

/**
 * `dns.promises.lookup` with a hard timeout. The bundled @types/node (older than the
 * runtime) does not declare the `signal` lookup option, so we bound it manually.
 */
function lookupWithTimeout(host: string): Promise<{ address: string; family: number }[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new SafeUrlError(`DNS lookup timeout cho "${host}"`));
    }, DEFAULT_TIMEOUT_MS);
    const cleanup = () => clearTimeout(timer);
    lookup(host, { all: true, verbatim: true }).then(
      (res: any) => {
        cleanup();
        const addrs = (Array.isArray(res) ? res : [res]) as { address: string; family: number }[];
        resolve(addrs);
      },
      (e: any) => {
        cleanup();
        if (e?.code === 'ENOTFOUND' || e?.code === 'EAI_AGAIN' || e?.code === 'ENODATA') {
          reject(new SafeUrlError(`DNS lookup thất bại cho "${host}": ${e.code}`));
        } else {
          reject(new SafeUrlError(`DNS lookup thất bại cho "${host}": ${e?.code || e?.message || String(e)}`));
        }
      },
    );
  });
}

// ---------------------------------------------------------------------------
// LLM provider URL policy (DESIGN §8.5). Guards the endpoint that receives the
// LLM_API_KEY (Threat C9): production must be https; `http:` is permitted ONLY
// for a documented known-dev allowlist (local llama.cpp/ollama/vllm on loopback
// or a private LAN that the operator explicitly controls).
// ---------------------------------------------------------------------------

/** Hosts allowed to receive an `http://` LLM base URL. Metadata (169.254/16) is EXCLUDED. */
function isKnownLlmDevHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host.startsWith('127.') ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

/** Sync LLM-BASE_URL policy for the config-store write path (no DNS). Throws SafeUrlError. */
export function validateLlmBaseUrlStatic(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch (e: any) {
    throw new SafeUrlError(`URL không hợp lệ ("${stripUrlQuery(raw)}")`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new SafeUrlError(`LLM_BASE_URL chỉ chấp nhận https/http — nhận "${url.protocol}"`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').trim().toLowerCase();
  if (!host) throw new SafeUrlError('Thiếu hostname');
  if (url.protocol === 'http:') {
    // DESIGN §8.5: http CHỈ cho loopback/private đã biết (dev endpoint), không bao giờ metadata.
    if (!isKnownLlmDevHost(host)) {
      throw new SafeUrlError('LLM_BASE_URL bắt buộc dùng https: — http chỉ cho phép localhost/private LAN đã khai báo');
    }
    return url;
  }
  return validatePublicUrlStatic(raw); // https: static SSRF rules apply too
}

/** Full LLM-BASE_URL policy: static + https enforcement + DNS re-check. */
export async function validateLlmBaseUrl(raw: string): Promise<URL> {
  const url = validateLlmBaseUrlStatic(raw);
  if (url.protocol === 'http:') return url; // known-dev loopback/LAN — no DNS hop needed
  return validatePublicUrl(raw); // https: DNS must not point at private/metadata
}

export interface SafeDownloadOptions {
  timeoutMs?: number; // default 5s
  maxBytes?: number; // default 2 MiB
  headers?: Record<string, string>;
}

export interface SafeDownload {
  ok: boolean;
  status: number;
  text: string;
  bytes: Uint8Array;
  mimeType: string;
}

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const cl = res.headers.get('content-length');
  if (cl && parseInt(cl, 10) > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new SafeUrlError(`Response quá lớn: > ${maxBytes} bytes`);
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let value: Uint8Array;
    let done = false;
    try {
      const r = await reader.read();
      done = r.done;
      value = r.value as Uint8Array;
    } catch (e: any) {
      await reader.cancel().catch(() => {});
      throw new SafeUrlError(`Lỗi đọc response: ${e?.message || String(e)}`);
    }
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new SafeUrlError(`Response quá lớn: > ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Fetch a URL with full SSRF guardrail: scheme/IP/DNS validation, capped redirects
 * (re-validated per hop), per-hop timeout, and a streamed size cap.
 * Resolves with `{ ok, status, text, bytes, mimeType }`. Throws SafeUrlError on violation.
 */
export async function safeFetchDownload(input: string, opts: SafeDownloadOptions = {}): Promise<SafeDownload> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  let url = await validatePublicUrl(input);

  for (let hop = 0; ; hop++) {
    if (hop > MAX_REDIRECTS) {
      throw new SafeUrlError(`Quá nhiều redirect (tối đa ${MAX_REDIRECTS})`);
    }
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, ...opts.headers },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e: any) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
        throw new SafeUrlError(`Timeout sau ${timeoutMs}ms khi tải "${stripUrlQuery(url.href)}"`);
      }
      throw new SafeUrlError(`Lỗi mạng khi tải "${stripUrlQuery(url.href)}": ${e?.message || String(e)}`);
    }
    const loc = res.headers.get('location');
    const isRedirect = res.status >= 300 && res.status < 400 && loc;
    if (isRedirect) {
      await res.body?.cancel().catch(() => {});
      url = await validatePublicUrl(new URL(loc, url).href); // re-validate the jump target
      continue;
    }
    const bytes = await readCapped(res, maxBytes);
    const mimeType = res.headers.get('content-type') || '';
    const text = Buffer.from(bytes).toString('utf8');
    return { ok: res.ok, status: res.status, text, bytes, mimeType };
  }
}