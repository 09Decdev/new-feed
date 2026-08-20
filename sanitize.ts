/**
 * Shared log/error sanitizer (threat model C12).
 * Redacts bearer tokens, API keys and known secret values before they reach logs,
 * the ring buffer, or any error message that travels towards the GUI.
 */

const HEADER_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\bx-api-key\s*[:=]\s*[^\s,]+/gi,
  /\bx-api-key\s*\S+/gi,
  /client_secret[=-]\s*\S+/gi,
];

/** Redact secrets from arbitrary messages. `secrets` are treated as literal strings (not regex). */
export function sanitize(message: unknown, secrets: readonly string[] = []): string {
  let out = String(message ?? '');
  for (const p of HEADER_PATTERNS) {
    out = out.replace(p, '[REDACTED]');
  }
  for (const s of secrets) {
    if (typeof s === 'string' && s.length >= 4) {
      out = out.split(s).join('[REDACTED]');
    }
  }
  return out;
}

/** Hide the query string (and fragment) of a URL before it reaches logs — paid-news RSS URLs carry tokens. */
export function stripUrlQuery(raw: string): string {
  try {
    const u = new URL(raw);
    u.search = '';
    u.hash = '';
    return u.href;
  } catch {
    return '<invalid-url>';
  }
}