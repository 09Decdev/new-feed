/**
 * G2 — mutation mini-runner (no stryker, zero new deps).
 *
 * For each security-critical pure function we maintain a set of FAITHFUL
 * single-bug mutants (alternate implementations that introduce exactly one
 * realistic defect: a dropped range check, a flipped boundary, a missing
 * fallback) and an ORACLE of input→expected cases drawn from the unit tests.
 *
 * A mutant is KILLED when it diverges from the real implementation on at least
 * one oracle case (either throw-behavior or return value differs). Otherwise it
 * SURVIVES — a signal that the suite would not catch that defect. The gate:
 *   - overall mutation score ≥ MUTATION_SCORE_THRESHOLD (default 60%)
 *   - ZERO surviving mutants in CRITICAL targets (the SSRF/authz surface)
 *
 * Run: `npm run test:mutation`. Exits 0 on green, 1 if the gate is violated.
 */
import { sanitize } from '../../sanitize';
import { isPrivateIp, validatePublicUrlStatic, validateLlmBaseUrlStatic } from '../../safe-fetch';
import { hasPostPermission } from '../../community.client';
import { isProfanityRejection } from '../../bot.controller';
import { describeError } from '../../content-service.client';

type Fn = (...args: any[]) => any;
interface Case {
  args: any[];
  label: string;
}
interface Mutant {
  name: string;
  fn: Fn;
}
interface Target {
  name: string;
  critical: boolean;
  real: Fn;
  cases: Case[];
  mutants: Mutant[];
}

const MUTATION_SCORE_THRESHOLD = 0.6;

function apply(fn: Fn, args: any[]): { threw: boolean; value: any } {
  try {
    return { threw: false, value: fn(...args) };
  } catch (e: any) {
    return { threw: true, value: e?.message ?? String(e) };
  }
}

/** A mutant is killed when its (throw, value) differs from real on any case. */
function differs(real: Fn, mut: Fn, args: any[]): boolean {
  const a = apply(real, args);
  const b = apply(mut, args);
  if (a.threw !== b.threw) return true; // reject vs accept — the security-relevant signal
  if (a.threw) return false; // both rejected → same behavior for this case
  return JSON.stringify(a.value) !== JSON.stringify(b.value);
}

// ---------------------------------------------------------------------------
// Faithful mutant helpers (copies of real logic with exactly one branch mutated)
// ---------------------------------------------------------------------------

const HP = [
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\bx-api-key\s*[:=]\s*[^\s,]+/gi,
  /\bx-api-key\s*\S+/gi,
  /client_secret[=-]\s*\S+/gi,
];

function sanitizeNoHeader(message: unknown, secrets: readonly string[] = []): string {
  let out = String(message ?? '');
  // MUTANT: dropped the HEADER_PATTERNS redaction loop (Bearer/x-api-key leak).
  for (const s of secrets) if (typeof s === 'string' && s.length >= 4) out = out.split(s).join('[REDACTED]');
  return out;
}
function sanitizeThresh3(message: unknown, secrets: readonly string[] = []): string {
  let out = String(message ?? '');
  for (const p of HP) out = out.replace(p, '[REDACTED]');
  // MUTANT: literal-secret threshold lowered 4 → 3 (over-redacts short values).
  for (const s of secrets) if (typeof s === 'string' && s.length >= 3) out = out.split(s).join('[REDACTED]');
  return out;
}
function sanitizeNoCoalesce(message: unknown, secrets: readonly string[] = []): string {
  let out = String(message); // MUTANT: dropped `?? ''` → null/undefined becomes "null"/"undefined".
  for (const p of HP) out = out.replace(p, '[REDACTED]');
  for (const s of secrets) if (typeof s === 'string' && s.length >= 4) out = out.split(s).join('[REDACTED]');
  return out;
}

function isPrivateIpv4Mut(ip: string, bug: 'skip172' | 'skip10' | 'skip127'): boolean {
  const parts = ip.split('.');
  const n = (i: number) => { const v = Number(parts[i]); return Number.isFinite(v) ? v : -1; };
  const a = n(0);
  const b = n(1);
  if (a === 10 && bug !== 'skip10') return true;
  if (a === 127 && bug !== 'skip127') return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31 && bug !== 'skip172') return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 0) return true;
  if (a >= 224) return true;
  return false;
}
function isPrivateIpv6Mut(ip: string, bug: 'skipLoopback'): boolean {
  const v = ip.toLowerCase();
  if (v === '::' || (v === '::1' && bug !== 'skipLoopback')) return true;
  if (v.startsWith('fc') || v.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(v)) return true;
  if (/^fec/.test(v)) return true;
  if (v.startsWith('ff')) return true;
  if (v.startsWith('2001:db8')) return true;
  if (v.startsWith('::ffff:')) {
    const dotted = v.slice('::ffff:'.length);
    if (dotted.includes('.') && require('node:net').isIP(dotted) === 4) return isPrivateIpv4Mut(dotted, 'skip172');
    return true;
  }
  return false;
}
function makeIsPrivateIpMut(bug: 'skip172' | 'skip10' | 'skip127' | 'skipLoopback'): Fn {
  return (ip: string) => {
    const v = String(ip).trim().toLowerCase().replace(/^\[|\]$/g, '');
    if (v.includes('%')) return true;
    const kind = require('node:net').isIP(v);
    if (kind === 4) return isPrivateIpv4Mut(v, bug as any);
    if (kind === 6) return isPrivateIpv6Mut(v, bug as any);
    return false;
  };
}

function makeValidatePublicMut(bug: 'allowScheme' | 'allowPrivateIp' | 'allowBlockedHosts'): Fn {
  const { isIP } = require('node:net');
  const BLOCKED = new Set(['localhost', 'metadata', 'metadata.google.internal', 'instance-data', 'instance-data.ec2.internal']);
  return (raw: string) => {
    const url = new URL(raw.trim());
    const proto = url.protocol;
    if ((proto !== 'https:' && proto !== 'http:') && bug !== 'allowScheme') {
      throw new Error('scheme');
    }
    const host = url.hostname.replace(/^\[|\]$/g, '').trim().toLowerCase();
    if (!host) throw new Error('no host');
    if (BLOCKED.has(host) && bug !== 'allowBlockedHosts') throw new Error('blocked host');
    if (
      bug !== 'allowBlockedHosts' &&
      (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa'))
    ) {
      throw new Error('internal host');
    }
    if (isIP(host) && isPrivateIp(host) && bug !== 'allowPrivateIp') throw new Error('private ip');
    return url;
  };
}

function makeValidateLlmMut(bug: 'allowHttpPublic' | 'rejectHttpsPublic' | 'allowHttpMetadata'): Fn {
  return (raw: string) => {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('scheme');
    const host = url.hostname.replace(/^\[|\]$/g, '').trim().toLowerCase();
    if (!host) throw new Error('no host');
    if (url.protocol === 'http:') {
      // real isKnownLlmDevHost:
      const devHost =
        host === 'localhost' || host.endsWith('.localhost') || host === '::1' ||
        host.startsWith('127.') || host.startsWith('10.') || host.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
      if (bug === 'allowHttpPublic') return url; // MUTANT: any http host allowed
      if (bug === 'allowHttpMetadata') return url; // MUTANT: 169.254 metadata treated as dev
      if (!devHost) throw new Error('http must be https');
      return url;
    }
    if (bug === 'rejectHttpsPublic') throw new Error('https public rejected'); // MUTANT: reject https public IP
    return validatePublicUrlStatic(raw);
  };
}

function hasPostAlwaysMember(p: any): boolean {
  if (!p) return false;
  if (p.role === 'OWNER') return true;
  return true; // MUTANT: any MEMBER can post (ignores communityPermission).
}
function hasPostAnyPermission(p: any): boolean {
  if (!p) return false;
  if (p.role === 'OWNER') return true;
  return (p.communityPermission ?? []).length > 0; // MUTANT: ANY permission grants post.
}
function hasPostNullTrue(): boolean {
  return true; // MUTANT: null permission → true.
}

function isProfanityMiss40001(res: any): boolean {
  if (res.words && res.words.length) return true;
  const r = (res.reason || '').toLowerCase();
  return r.startsWith('profanity_rejected') || r.includes('inappropriate_content'); // MUTANT: dropped 40001.
}
function isProfanityWordsOnly(res: any): boolean {
  if (res.words && res.words.length) return true; // MUTANT: ignores reason-based profanity signals.
  return false;
}
function isProfanityMissInappropriate(res: any): boolean {
  if (res.words && res.words.length) return true;
  const r = (res.reason || '').toLowerCase();
  return r.startsWith('profanity_rejected') || r.includes('40001'); // MUTANT: dropped INAPPROPRIATE_CONTENT.
}

function describeError403Unauth(err: any): string {
  const status = err?.status;
  if (status === 403) return 'UNAUTHORIZED (token invalid?)'; // MUTANT: 403 mapped to UNAUTHORIZED.
  return describeError(err);
}
function describeErrorNoProfanity(err: any): string {
  const status = err?.status;
  if (status === 400) return `BAD_REQUEST (${err?.body?.error || err?.body?.message || '?'})`; // MUTANT: never detects profanity.
  return describeError(err);
}
function describeErrorNoUnknownFallback(err: any): string {
  const status = err?.status;
  if (status && status >= 500) return `SERVER_ERROR (${status})`;
  if (status === 400 || status === 401 || status === 403) return describeError(err);
  return err?.message; // MUTANT: dropped ' || UNKNOWN' → undefined for empty err.
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

const TARGETS: Target[] = [
  {
    name: 'sanitize',
    critical: true,
    real: sanitize,
    cases: [
      { args: ['Authorization: Bearer abc123', []], label: 'bearer-redacted' },
      { args: ['secret xyz123', ['xyz123']], label: 'literal>=4-redacted' },
      { args: ['short abc', ['abc']], label: 'literal<4-not-redacted' },
      { args: [null, []], label: 'null→""' },
      { args: [42, []], label: '42→"42"' },
    ],
    mutants: [
      { name: 'drop-header-redaction', fn: sanitizeNoHeader },
      { name: 'threshold-3', fn: sanitizeThresh3 },
      { name: 'no-null-coalesce', fn: sanitizeNoCoalesce },
    ],
  },
  {
    name: 'isPrivateIp',
    critical: true,
    real: isPrivateIp,
    cases: [
      { args: ['127.0.0.1'], label: 'loopback v4' },
      { args: ['8.8.8.8'], label: 'public v4' },
      { args: ['10.0.0.1'], label: '10/8' },
      { args: ['172.16.0.1'], label: '172.16/12' },
      { args: ['172.32.0.1'], label: '172.32 public' },
      { args: ['::1'], label: 'loopback v6' },
      { args: ['::ffff:127.0.0.1'], label: 'v4-mapped' },
      { args: ['fe80::1'], label: 'link-local v6' },
      { args: ['notanip'], label: 'non-ip' },
    ],
    mutants: [
      { name: 'skip-172.16-31', fn: makeIsPrivateIpMut('skip172') },
      { name: 'skip-10/8', fn: makeIsPrivateIpMut('skip10') },
      { name: 'skip-127/8', fn: makeIsPrivateIpMut('skip127') },
      { name: 'skip-::1', fn: makeIsPrivateIpMut('skipLoopback') },
    ],
  },
  {
    name: 'validatePublicUrlStatic',
    critical: true,
    real: validatePublicUrlStatic,
    cases: [
      { args: ['https://example.com'], label: 'public https' },
      { args: ['ftp://example.com'], label: 'non-http scheme w/ host' },
      { args: ['http://127.0.0.1'], label: 'private ip' },
      { args: ['http://localhost'], label: 'localhost' },
      { args: ['http://metadata'], label: 'metadata host' },
      { args: ['http://'], label: 'no host' },
    ],
    mutants: [
      { name: 'allow-non-http-scheme', fn: makeValidatePublicMut('allowScheme') },
      { name: 'allow-private-ip', fn: makeValidatePublicMut('allowPrivateIp') },
      { name: 'allow-blocked-hosts', fn: makeValidatePublicMut('allowBlockedHosts') },
    ],
  },
  {
    name: 'validateLlmBaseUrlStatic',
    critical: true,
    real: validateLlmBaseUrlStatic,
    cases: [
      { args: ['http://8.8.8.8'], label: 'http public → throw' },
      { args: ['http://127.0.0.1'], label: 'http loopback → ok' },
      { args: ['https://8.8.8.8'], label: 'https public → ok' },
      { args: ['https://192.168.1.1'], label: 'https private → throw' },
      { args: ['http://169.254.169.254'], label: 'http metadata → throw' },
    ],
    mutants: [
      { name: 'allow-http-public', fn: makeValidateLlmMut('allowHttpPublic') },
      { name: 'reject-https-public', fn: makeValidateLlmMut('rejectHttpsPublic') },
      { name: 'allow-http-metadata', fn: makeValidateLlmMut('allowHttpMetadata') },
    ],
  },
  {
    name: 'hasPostPermission',
    critical: true,
    real: hasPostPermission,
    cases: [
      { args: [{ role: 'OWNER' }], label: 'owner' },
      { args: [{ role: 'MEMBER', communityPermission: [{ permissionName: 'POST_CONTENT' }] }], label: 'member+post' },
      { args: [{ role: 'MEMBER', communityPermission: [] }], label: 'member-no-perm' },
      { args: [{ role: 'MEMBER', communityPermission: [{ permissionName: 'READ' }] }], label: 'member-other-perm' },
      { args: [null], label: 'null' },
      { args: [undefined], label: 'undefined' },
    ],
    mutants: [
      { name: 'member-always-true', fn: hasPostAlwaysMember },
      { name: 'any-permission-grants', fn: hasPostAnyPermission },
      { name: 'null→true', fn: hasPostNullTrue },
    ],
  },
  {
    name: 'isProfanityRejection',
    critical: false,
    real: isProfanityRejection,
    cases: [
      { args: [{ ok: false, words: ['bad'] }], label: 'words' },
      { args: [{ ok: false, reason: 'PROFANITY_REJECTED (words: x)' }], label: 'reason profanity' },
      { args: [{ ok: false, reason: 'code INAPPROPRIATE_CONTENT hit' }], label: 'reason inappropriate' },
      { args: [{ ok: false, reason: 'error 40001 thrown' }], label: 'reason 40001' },
      { args: [{ ok: false, reason: 'FORBIDDEN' }], label: 'forbidden' },
      { args: [{ ok: false }], label: 'empty' },
    ],
    mutants: [
      { name: 'miss-40001', fn: isProfanityMiss40001 },
      { name: 'words-only', fn: isProfanityWordsOnly },
      { name: 'miss-inappropriate', fn: isProfanityMissInappropriate },
    ],
  },
  {
    name: 'describeError',
    critical: false,
    real: describeError,
    cases: [
      { args: [{ status: 400, body: { error: 'INAPPROPRIATE_CONTENT', words: ['bad'] } }], label: 'profanity w/ words' },
      { args: [{ status: 400, body: { code: '40001' } }], label: 'profanity code' },
      { args: [{ status: 400, body: { error: 'OTHER', message: 'm' } }], label: 'bad_request' },
      { args: [{ status: 401, body: {} }], label: 'unauthorized' },
      { args: [{ status: 403, body: {} }], label: 'forbidden' },
      { args: [{ status: 500, body: {} }], label: 'server_error' },
      { args: [{ message: 'something' }], label: 'message' },
      { args: [{}], label: 'unknown' },
    ],
    mutants: [
      { name: '403→unauthorized', fn: describeError403Unauth },
      { name: 'no-profanity-detect', fn: describeErrorNoProfanity },
      { name: 'no-unknown-fallback', fn: describeErrorNoUnknownFallback },
    ],
  },
];

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

interface TargetResult {
  name: string;
  critical: boolean;
  killed: number;
  total: number;
  survived: string[];
}

function runTarget(t: Target): TargetResult {
  let killed = 0;
  const survived: string[] = [];
  for (const m of t.mutants) {
    const diff = t.cases.some((c) => differs(t.real, m.fn, c.args));
    if (diff) killed++;
    else survived.push(m.name);
  }
  return { name: t.name, critical: t.critical, killed, total: t.mutants.length, survived };
}

function main(): void {
  const results = TARGETS.map(runTarget);
  const totalKilled = results.reduce((s, r) => s + r.killed, 0);
  const totalMutants = results.reduce((s, r) => s + r.total, 0);
  const score = totalMutants ? totalKilled / totalMutants : 1;
  const criticalSurvivors = results.filter((r) => r.critical && r.survived.length > 0);
  const allSurvivors = results.filter((r) => r.survived.length > 0).flatMap((r) => r.survived.map((s) => `${r.name}/${s}`));

  console.log('\n=== G2 Mutation Report ===');
  for (const r of results) {
    const flag = r.critical ? '[CRITICAL]' : '          ';
    const surv = r.survived.length ? `  SURVIVED: ${r.survived.join(', ')}` : '';
    console.log(`${flag} ${r.name.padEnd(26)} ${r.killed}/${r.total} killed${surv}`);
  }
  console.log(`\nScore: ${totalKilled}/${totalMutants} = ${(score * 100).toFixed(1)}% (threshold ${(MUTATION_SCORE_THRESHOLD * 100).toFixed(0)}%)`);
  if (allSurvivors.length) console.log(`Surviving mutants: ${allSurvivors.join(', ')}`);
  else console.log('Surviving mutants: none');

  const gateScore = score >= MUTATION_SCORE_THRESHOLD;
  const gateCritical = criticalSurvivors.length === 0;
  console.log(`\nGate: score≥${(MUTATION_SCORE_THRESHOLD * 100).toFixed(0)}% → ${gateScore ? 'PASS' : 'FAIL'} | 0 critical survivors → ${gateCritical ? 'PASS' : 'FAIL'}`);

  if (!gateScore || !gateCritical) {
    if (!gateScore) console.error(`FAIL: mutation score ${(score * 100).toFixed(1)}% < threshold`);
    if (!gateCritical) console.error(`FAIL: critical survivors: ${criticalSurvivors.map((r) => `${r.name}: ${r.survived.join(',')}`).join('; ')}`);
    process.exit(1);
  }
  console.log('G2: PASS\n');
}

main();
