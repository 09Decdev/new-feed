/**
 * G3 — server contract tests. Boots the REAL GUI server on a temp .env + free
 * loopback port; asserts the full route matrix, security headers, cross-site /
 * host-header 403s, config write/validation, rss-preview SSRF gate, post/start/stop
 * edges, and a PII scan (no secret literal ever leaves the server).
 *
 * No brute-force 429 here (would lock 'loopback' for 30s and break sibling tests);
 * the 429 lockout is exercised in authz-secret.test.ts (own process). Every
 * protected request here carries the correct token → clearFailures each time.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeTempEnv,
  applyProcessOverrides,
  freePort,
  live,
  rawHttp,
  type TestEnv,
} from '../helpers/test-env';
import { markPosted, hashKey } from '../../dedup';

type ServerModule = typeof import('../../server');

const TOKEN = 'test-tok123';
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const SECRETS = ['test-tok123', 'w5-test-secret-value', 'llm-test-key-value'];

let env: TestEnv;
let server: ServerModule;
let url: string;
let port: number;
let restoreEnv: () => void;

function assertNoSecrets(body: string, label: string): void {
  for (const s of SECRETS) {
    assert.ok(!body.includes(s), `PII leak (${label}): body contains secret literal "${s}"`);
  }
}

before(async () => {
  port = await freePort();
  env = makeTempEnv({ COMMUNITY_ID: '' }, { port });
  // process.env overrides MUST be in place before require()ing server, so the
  // singleton BotController (constructed at module load) anchors lock/session/
  // dedup at the temp paths via mergedValues()'s process.env override.
  restoreEnv = applyProcessOverrides(env);
  server = require('../../server') as ServerModule;
  // Seed two dedup entries so /api/history is non-empty.
  await markPosted(env.dedupFile, {
    key: hashKey('https://example.com/a'),
    title: 'Bài mẫu A',
    link: 'https://example.com/a',
    status: 'posted',
    ts: 1_000_000,
  });
  await markPosted(env.dedupFile, {
    key: hashKey('https://example.com/b'),
    title: 'Bài mẫu B',
    link: 'https://example.com/b',
    status: 'failed',
    reason: 'FORBIDDEN',
    ts: 2_000_000,
  });
  url = await server.startGuiServer({ envFile: env.envPath });
});

after(async () => {
  await server.closeGuiServer();
  restoreEnv();
  env.cleanup();
});

// --- security headers present on every reply (incl. errors) -----------------

test('GET / serves index.html with full security header set', async () => {
  const r = await live(url, '/', { headers: AUTH });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /text\/html/);
  const csp = r.headers.get('content-security-policy') || '';
  assert.ok(csp.includes("script-src 'self'"), csp);
  assert.ok(csp.includes("object-src 'none'"), csp);
  assert.ok(csp.includes("frame-ancestors 'none'"), csp);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('GET /callback serves callback.html', async () => {
  const r = await live(url, '/callback', { headers: AUTH });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /text\/html/);
});

test('GET /favicon.ico → 204', async () => {
  const r = await live(url, '/favicon.ico', { headers: AUTH });
  assert.equal(r.status, 204);
});

test('GET /nope → 404 NOT_FOUND static message', async () => {
  const r = await live(url, '/nope', { headers: AUTH });
  assert.equal(r.status, 404);
  assert.equal(r.json.code, 'NOT_FOUND');
  assert.ok(r.text.includes('Không tìm thấy tài nguyên.'));
});

// --- route matrix (GET, correct token) ---------------------------------------

test('GET /api/status → 200 with bot state', async () => {
  const r = await live(url, '/api/status', { headers: AUTH });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.data.state, 'STOPPED');
  assert.equal(r.json.data.guiTokenSet, true);
  assertNoSecrets(r.text, 'status');
});

test('GET /api/logs → 200 {lines,firstSeq,lastSeq}', async () => {
  const r = await live(url, '/api/logs', { headers: AUTH });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.ok(Array.isArray(r.json.data.lines));
  assert.equal(typeof r.json.data.firstSeq, 'number');
  assert.equal(typeof r.json.data.lastSeq, 'number');
  assertNoSecrets(r.text, 'logs');
});

test('GET /api/history → 200 with seeded entries (DESC)', async () => {
  const r = await live(url, '/api/history', { headers: AUTH });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.count, 2);
  assert.equal(r.json.data.entries[0].title, 'Bài mẫu B'); // higher ts first
  assert.equal(r.json.data.entries[1].status, 'posted');
  assertNoSecrets(r.text, 'history');
});

test('GET /api/history?status=posted filters to one', async () => {
  const r = await live(url, '/api/history?status=posted', { headers: AUTH });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.count, 1);
  assert.equal(r.json.data.entries[0].title, 'Bài mẫu A');
});

test('GET /api/config → 200, secrets masked as {set:bool} (no leak)', async () => {
  const r = await live(url, '/api/config', { headers: AUTH });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.data.config.LLM_API_KEY, { set: true });
  assert.deepEqual(r.json.data.config.GOOGLE_CLIENT_SECRET_WEB, { set: true });
  assert.deepEqual(r.json.data.config.GUI_TOKEN, { set: true });
  assert.equal(r.json.data.guiTokenSet, true);
  assertNoSecrets(r.text, 'config-get');
});

test('GET /api/auth-status → 200, no token value leaked', async () => {
  const r = await live(url, '/api/auth-status', { headers: AUTH });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.guiTokenSet, true);
  assert.equal(r.json.data.hasSession, false);
  assert.equal(r.json.data.communityId, '');
  assertNoSecrets(r.text, 'auth-status');
});

test('GET /api/communities → 401 AUTH_FAILED (empty session, no network)', async () => {
  const r = await live(url, '/api/communities', { headers: AUTH });
  assert.equal(r.status, 401);
  assert.equal(r.json.code, 'AUTH_FAILED');
  assertNoSecrets(r.text, 'communities');
});

// --- token gate (single 401, immediately cleared by the next correct request) -

test('GET /api/status with NO token → 401 UNAUTHORIZED', async () => {
  const r = await live(url, '/api/status');
  assert.equal(r.status, 401);
  assert.equal(r.json.code, 'UNAUTHORIZED');
  assertNoSecrets(r.text, 'no-token');
});

// --- wrong method → 405 ------------------------------------------------------

test('POST /api/status → 405 METHOD_NOT_ALLOWED', async () => {
  const r = await live(url, '/api/status', { method: 'POST', headers: AUTH });
  assert.equal(r.status, 405);
  assert.equal(r.json.code, 'METHOD_NOT_ALLOWED');
});

test('DELETE /api/config → 405', async () => {
  const r = await live(url, '/api/config', { method: 'DELETE', headers: AUTH });
  assert.equal(r.status, 405);
  assert.equal(r.json.code, 'METHOD_NOT_ALLOWED');
});

// --- OPTIONS + setup/* + unknown api ----------------------------------------

test('OPTIONS /api/status → 405 (CORS not enabled)', async () => {
  const r = await live(url, '/api/status', { method: 'OPTIONS', headers: AUTH });
  assert.equal(r.status, 405);
  assert.ok(r.text.includes('CORS not enabled'));
});

test('GET /api/setup/google → 404 NOT_IMPLEMENTED', async () => {
  const r = await live(url, '/api/setup/google', { headers: AUTH });
  assert.equal(r.status, 404);
  assert.equal(r.json.code, 'NOT_IMPLEMENTED');
});

test('GET /api/ → 404 API_ROOT', async () => {
  const r = await live(url, '/api/', { headers: AUTH });
  assert.equal(r.status, 404);
  assert.equal(r.json.code, 'API_ROOT');
});

test('GET /api/does-not-exist → 404 NOT_FOUND', async () => {
  const r = await live(url, '/api/does-not-exist', { headers: AUTH });
  assert.equal(r.status, 404);
  assert.equal(r.json.code, 'NOT_FOUND');
});

// --- cross-site + host-header 403 (raw node:http — fetch forbids these hdrs) -

test('POST /api/start with Sec-Fetch-Site: cross-site → 403 FORBIDDEN', async () => {
  const r = await rawHttp(port, '/api/start', {
    method: 'POST',
    headers: { ...AUTH, 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(r.status, 403);
  assert.equal(JSON.parse(r.body).code, 'FORBIDDEN');
  assertNoSecrets(r.body, 'cross-site');
});

test('GET /api/status with foreign Host → 403 INVALID_HOST', async () => {
  const r = await rawHttp(port, '/api/status', {
    method: 'GET',
    headers: { ...AUTH, host: 'evil.example' },
  });
  assert.equal(r.status, 403);
  assert.equal(JSON.parse(r.body).code, 'INVALID_HOST');
});

// --- POST /api/config: write + validation -----------------------------------

// Runs BEFORE any write sets COMMUNITY_ID, so the temp env's initial empty value
// exercises the pre-body community gate (empty COMMUNITY_ID cannot be written
// via the GUI — normalizeFieldValue rejects it — so we rely on the fresh state).
test('POST /api/post {mode:test} with no community → 400 MISSING_COMMUNITY_ID (pre-body)', async () => {
  const r = await live(url, '/api/post', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'test' }),
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'MISSING_COMMUNITY_ID');
});

test('POST /api/config valid write → 200 written list, then GET reflects it', async () => {
  const r = await live(url, '/api/config', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ COMMUNITY_ID: 'comm-test-123', RSS_LIMIT_PER_CYCLE: '3' }),
  });
  assert.equal(r.status, 200);
  assert.ok(r.json.data.written.includes('COMMUNITY_ID'));
  assert.ok(r.json.data.written.includes('RSS_LIMIT_PER_CYCLE'));
  assertNoSecrets(r.text, 'config-write');
  const g = await live(url, '/api/config', { headers: AUTH });
  assert.equal(g.json.data.config.COMMUNITY_ID, 'comm-test-123');
  assert.equal(g.json.data.config.RSS_LIMIT_PER_CYCLE, 3);
});

test('POST /api/config unknown field → 400 VALIDATION_ERROR', async () => {
  const r = await live(url, '/api/config', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ UNKNOWN_FIELD: 'x' }),
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'VALIDATION_ERROR');
});

test('POST /api/config bad int → 400 VALIDATION_ERROR', async () => {
  const r = await live(url, '/api/config', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ RSS_LIMIT_PER_CYCLE: 'notanint' }),
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'VALIDATION_ERROR');
});

test('POST /api/config LLM_API_KEY_SET="" → 200 deleted list', async () => {
  const r = await live(url, '/api/config', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ LLM_API_KEY_SET: '' }),
  });
  assert.equal(r.status, 200);
  assert.ok(r.json.data.deleted.includes('LLM_API_KEY'));
});

// --- rss-preview SSRF gate ----------------------------------------------------

test('GET /api/rss-preview without url → 400 MISSING_PARAM', async () => {
  const r = await live(url, '/api/rss-preview', { headers: AUTH });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'MISSING_PARAM');
});

test('GET /api/rss-preview?url=http://127.0.0.1 (private) → 502 FETCH_RSS_FAILED', async () => {
  const r = await live(url, '/api/rss-preview?url=' + encodeURIComponent('http://127.0.0.1/feed.rss'), {
    headers: AUTH,
  });
  assert.equal(r.status, 502);
  assert.equal(r.json.code, 'FETCH_RSS_FAILED');
  assertNoSecrets(r.text, 'rss-private');
});

// --- POST /api/post edges ----------------------------------------------------

test('POST /api/config restores COMMUNITY_ID, then /api/post bad mode → 400 VALIDATION_ERROR', async () => {
  await live(url, '/api/config', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ COMMUNITY_ID: 'comm-test-123' }),
  });
  const r = await live(url, '/api/post', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'bad' }),
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'VALIDATION_ERROR');
});

test('POST /api/post non-json content-type → 400 INVALID_CONTENT_TYPE', async () => {
  await live(url, '/api/config', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ COMMUNITY_ID: 'comm-test-123' }),
  });
  const r = await live(url, '/api/post', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'text/plain' },
    body: 'not json',
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'INVALID_CONTENT_TYPE');
});

test('POST /api/post {mode:test,dryRun:true} → 200 dryRun preview (no network)', async () => {
  await live(url, '/api/config', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ COMMUNITY_ID: 'comm-test-123' }),
  });
  const r = await live(url, '/api/post', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'test', dryRun: true }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.dryRun, true);
  assert.equal(r.json.data.count, 1);
  assert.equal(r.json.data.previews[0].title, 'test-post');
  assertNoSecrets(r.text, 'post-dryrun');
});

// --- start/stop lifecycle ----------------------------------------------------

test('POST /api/stop while STOPPED → 400 BAD_REQUEST', async () => {
  const r = await live(url, '/api/stop', { method: 'POST', headers: AUTH });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'BAD_REQUEST');
});

test('POST /api/start (empty session) → 502 FORBIDDEN (bootstrap fails, no network)', async () => {
  const r = await live(url, '/api/start', { method: 'POST', headers: AUTH });
  assert.equal(r.status, 502);
  assert.equal(r.json.code, 'FORBIDDEN');
  assertNoSecrets(r.text, 'start-502');
});
