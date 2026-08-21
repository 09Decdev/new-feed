import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newState,
  getGoogleAuthUrl,
  waitForRedirectCode,
  exchangeCodeForTokens,
  refreshGoogleIdToken,
} from '../../google-oauth';
import { stubGlobalFetch, jsonResponse, freePort, sleep } from '../helpers/test-env';

// --- newState ----------------------------------------------------------------

test('newState: 32 hex chars, distinct across calls', () => {
  const a = newState();
  const b = newState();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
});

// --- getGoogleAuthUrl --------------------------------------------------------

test('getGoogleAuthUrl contains all required OAuth params', () => {
  const url = getGoogleAuthUrl('cid-123', 'http://localhost:8790/callback', 'state-abc');
  const u = new URL(url);
  assert.equal(u.origin, 'https://accounts.google.com');
  assert.equal(u.pathname, '/o/oauth2/v2/auth');
  const p = u.searchParams;
  assert.equal(p.get('client_id'), 'cid-123');
  assert.equal(p.get('redirect_uri'), 'http://localhost:8790/callback');
  assert.equal(p.get('response_type'), 'code');
  assert.equal(p.get('scope'), 'openid email profile');
  assert.equal(p.get('access_type'), 'offline');
  assert.equal(p.get('prompt'), 'consent');
  assert.equal(p.get('state'), 'state-abc');
});

// --- waitForRedirectCode (real loopback server) ------------------------------

test('waitForRedirectCode: resolves {code,state} on /callback?code&state', async () => {
  const port = await freePort();
  const p = waitForRedirectCode(port, 'st123', 3000);
  await sleep(60);
  const httpRes = await fetch(`http://127.0.0.1:${port}/callback?code=ABC&state=st123`);
  assert.equal(httpRes.status, 200);
  const res = await p;
  assert.deepEqual(res, { code: 'ABC', state: 'st123' });
});

test('waitForRedirectCode: rejects on ?error=…', async () => {
  const port = await freePort();
  const p = waitForRedirectCode(port, 'st', 3000);
  // Attach the rejection handler BEFORE the server rejects, so it is never "unhandled".
  const assertion = assert.rejects(() => p, /access_denied/);
  await sleep(60);
  const httpRes = await fetch(`http://127.0.0.1:${port}/callback?error=access_denied`);
  assert.equal(httpRes.status, 400);
  await assertion;
});

test('waitForRedirectCode: rejects with no_code when no code/error', async () => {
  const port = await freePort();
  const p = waitForRedirectCode(port, 'st', 3000);
  const assertion = assert.rejects(() => p, /no_code/);
  await sleep(60);
  await fetch(`http://127.0.0.1:${port}/callback`);
  await assertion;
});

// --- exchangeCodeForTokens (stubbed fetch to TOKEN_URL) -----------------------

test('exchangeCodeForTokens: 200 with id_token → GoogleTokens', async () => {
  const restore = stubGlobalFetch(async () =>
    jsonResponse({ id_token: 'it', access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
  );
  try {
    const t = await exchangeCodeForTokens({ code: 'c', clientId: 'cid', clientSecret: 'cs', redirectUri: 'http://localhost:8790/callback' });
    assert.equal(t.id_token, 'it');
    assert.equal(t.refresh_token, 'rt');
    assert.equal(t.expires_in, 3600);
  } finally {
    restore();
  }
});

test('exchangeCodeForTokens: !ok → throws', async () => {
  const restore = stubGlobalFetch(async () => jsonResponse({ error: 'invalid_grant' }, 400));
  try {
    await assert.rejects(
      () => exchangeCodeForTokens({ code: 'c', clientId: 'cid', clientSecret: 'cs', redirectUri: 'http://localhost:8790/callback' }),
      /HTTP 400/,
    );
  } finally {
    restore();
  }
});

test('exchangeCodeForTokens: missing id_token → throws', async () => {
  const restore = stubGlobalFetch(async () => jsonResponse({ access_token: 'at' }));
  try {
    await assert.rejects(
      () => exchangeCodeForTokens({ code: 'c', clientId: 'cid', clientSecret: 'cs', redirectUri: 'http://localhost:8790/callback' }),
      /no id_token/,
    );
  } finally {
    restore();
  }
});

// --- refreshGoogleIdToken (stubbed fetch) ------------------------------------

test('refreshGoogleIdToken: 200 → {idToken, expiresIn}', async () => {
  const restore = stubGlobalFetch(async () => jsonResponse({ id_token: 'it2', expires_in: 3600 }));
  try {
    const r = await refreshGoogleIdToken({ refreshToken: 'rt', clientId: 'cid', clientSecret: 'cs' });
    assert.equal(r.idToken, 'it2');
    assert.equal(r.expiresIn, 3600);
  } finally {
    restore();
  }
});

test('refreshGoogleIdToken: !ok → throws', async () => {
  const restore = stubGlobalFetch(async () => jsonResponse({ error: 'x' }, 400));
  try {
    await assert.rejects(
      () => refreshGoogleIdToken({ refreshToken: 'rt', clientId: 'cid', clientSecret: 'cs' }),
      /HTTP 400/,
    );
  } finally {
    restore();
  }
});

test('refreshGoogleIdToken: missing id_token → throws', async () => {
  const restore = stubGlobalFetch(async () => jsonResponse({ access_token: 'at' }));
  try {
    await assert.rejects(
      () => refreshGoogleIdToken({ refreshToken: 'rt', clientId: 'cid', clientSecret: 'cs' }),
      /no id_token/,
    );
  } finally {
    restore();
  }
});
