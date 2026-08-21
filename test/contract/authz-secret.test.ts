/**
 * G10 — authorization contract tests: bearer token gate + per-IP brute-force
 * backoff. Runs in its OWN test process (node:test isolates files), so locking
 * 'loopback' for 30s here cannot break sibling contract tests.
 *
 * FAIL_THRESHOLD=3, HEALTHY_LOCKOUTS_MS=[30s,1m,2m]. The lock is checked BEFORE
 * the token, so once locked even a correct token gets 429 — this is asserted.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempEnv, applyProcessOverrides, freePort, live, type TestEnv } from '../helpers/test-env';

type ServerModule = typeof import('../../server');

const TOKEN = 'test-tok123';
const WRONG = 'wrong-token-zzz';
let env: TestEnv;
let server: ServerModule;
let url: string;
let restoreEnv: () => void;

before(async () => {
  const port = await freePort();
  env = makeTempEnv({}, { port });
  restoreEnv = applyProcessOverrides(env);
  server = require('../../server') as ServerModule;
  url = await server.startGuiServer({ envFile: env.envPath });
});

after(async () => {
  await server.closeGuiServer();
  restoreEnv();
  env.cleanup();
});

// --- protected route: token required (run BEFORE any lock accumulates) ------

test('GET /api/status with NO Authorization → 401 UNAUTHORIZED', async () => {
  const r = await live(url, '/api/status');
  assert.equal(r.status, 401);
  assert.equal(r.json.code, 'UNAUTHORIZED');
});

// --- /api/auth/verify: bearer-exempt login helper ----------------------------

test('POST /api/auth/verify correct token (Bearer) → 200 authenticated', async () => {
  // also clears any single failure left by the no-token test above
  const r = await live(url, '/api/auth/verify', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.authenticated, true);
  assert.equal(r.json.data.guiTokenSet, true);
});

test('POST /api/auth/verify with no token → 400 MISSING_TOKEN (no failure bump)', async () => {
  const r = await live(url, '/api/auth/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'MISSING_TOKEN');
});

test('POST /api/auth/verify wrong token via JSON body → 401 (failure #1)', async () => {
  const r = await live(url, '/api/auth/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: WRONG }),
  });
  assert.equal(r.status, 401);
  assert.equal(r.json.code, 'UNAUTHORIZED');
  assert.equal(r.json.retryable, true);
});

test('POST /api/auth/verify wrong token via Bearer → 401 (failure #2)', async () => {
  const r = await live(url, '/api/auth/verify', {
    method: 'POST',
    headers: { Authorization: `Bearer ${WRONG}`, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(r.status, 401);
  assert.equal(r.json.code, 'UNAUTHORIZED');
});

test('POST /api/auth/verify 3rd wrong token → 429 RATE_LIMITED (locked)', async () => {
  const r = await live(url, '/api/auth/verify', {
    method: 'POST',
    headers: { Authorization: `Bearer ${WRONG}`, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(r.status, 429);
  assert.equal(r.json.code, 'RATE_LIMITED');
  assert.ok(typeof r.json.lockedUntil === 'number' && r.json.lockedUntil > Date.now());
});

test('POST /api/auth/verify CORRECT token while locked → 429 (lock checked before token)', async () => {
  const r = await live(url, '/api/auth/verify', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(r.status, 429);
  assert.equal(r.json.code, 'RATE_LIMITED');
});

test('GET /api/status CORRECT token while locked → 429 (gate blocks even valid token)', async () => {
  const r = await live(url, '/api/status', { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(r.status, 429);
  assert.equal(r.json.code, 'RATE_LIMITED');
});
