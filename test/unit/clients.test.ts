import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDeviceInfo,
  loginWithGoogle,
  refreshPlatformToken,
  ensurePlatformToken,
  bootstrapViaGoogle,
  getAccessToken,
} from '../../auth.client';
import { listMyCommunities, getMyMemberPermission, hasPostPermission } from '../../community.client';
import { createPost, describeError } from '../../content-service.client';
import { uploadImage } from '../../upload.client';
import { rewriteArticle } from '../../llm.client';
import { stubGlobalFetch, jsonResponse } from '../helpers/test-env';

function jwt(expSeconds: number): string {
  const h = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
  return `${h}.${p}.sig`;
}
const FUTURE_EXP = Math.floor(Date.now() / 1000) + 3600;

// ---------------------------------------------------------------------------
// auth.client
// ---------------------------------------------------------------------------

test('buildDeviceInfo uses env values when present, defaults otherwise', () => {
  const d1 = buildDeviceInfo({ DEVICE_INSTALLATION_ID: 'inst-x', DEVICE_FINGERPRINT: 'fp-y' } as any);
  assert.equal(d1.installationId, 'inst-x');
  assert.equal(d1.deviceFingerprint, 'fp-y');
  assert.equal(d1.platform, 'web');
  assert.equal(d1.deviceName, 'news-poster-bot');

  const d2 = buildDeviceInfo({} as any);
  assert.equal(d2.installationId, '11111111-1111-4111-8111-111111111111');
  assert.equal(d2.deviceFingerprint, 'a'.repeat(64));
});

test('loginWithGoogle: 200 raw object → tokens with jwt exp', async () => {
  const restore = stubGlobalFetch(async () =>
    jsonResponse({ accessToken: jwt(FUTURE_EXP), refreshToken: 'rt-1234' }),
  );
  try {
    const t = await loginWithGoogle('http://gw.example.com', 'idtoken', buildDeviceInfo({} as any));
    assert.equal(t.accessToken, jwt(FUTURE_EXP));
    assert.equal(t.refreshToken, 'rt-1234');
    assert.equal(t.accessExpiresAt, FUTURE_EXP * 1000);
  } finally {
    restore();
  }
});

test('loginWithGoogle: 200 wrapped {success,data} → unwrapped', async () => {
  const restore = stubGlobalFetch(async () =>
    jsonResponse({ success: true, data: { accessToken: jwt(FUTURE_EXP), refreshToken: 'rt' } }),
  );
  try {
    const t = await loginWithGoogle('http://gw', 'idt', buildDeviceInfo({} as any));
    assert.equal(t.refreshToken, 'rt');
  } finally {
    restore();
  }
});

test('loginWithGoogle: 2fa → throws', async () => {
  const restore = stubGlobalFetch(async () => jsonResponse({ require2fa: true }));
  try {
    await assert.rejects(() => loginWithGoogle('http://gw', 'idt', buildDeviceInfo({} as any)), /2FA/);
  } finally {
    restore();
  }
});

test('loginWithGoogle: register → throws', async () => {
  const restore = stubGlobalFetch(async () => jsonResponse({ register: true }));
  try {
    await assert.rejects(() => loginWithGoogle('http://gw', 'idt', buildDeviceInfo({} as any)), /not registered/);
  } finally {
    restore();
  }
});

test('loginWithGoogle: missing tokens → throws', async () => {
  const restore = stubGlobalFetch(async () => jsonResponse({ foo: 'bar' }));
  try {
    await assert.rejects(() => loginWithGoogle('http://gw', 'idt', buildDeviceInfo({} as any)), /unexpected response/);
  } finally {
    restore();
  }
});

test('loginWithGoogle: non-ok → throws with status', async () => {
  const restore = stubGlobalFetch(async () => jsonResponse({ error: 'bad' }, 401));
  try {
    await assert.rejects(() => loginWithGoogle('http://gw', 'idt', buildDeviceInfo({} as any)), /HTTP 401/);
  } finally {
    restore();
  }
});

test('refreshPlatformToken: 200 → tokens; !ok → throws', async () => {
  const ok = stubGlobalFetch(async () => jsonResponse({ accessToken: jwt(FUTURE_EXP), refreshToken: 'rt2' }));
  try {
    const t = await refreshPlatformToken('http://gw', 'oldrt');
    assert.equal(t.refreshToken, 'rt2');
  } finally {
    ok();
  }
  const bad = stubGlobalFetch(async () => jsonResponse({ error: 'x' }, 401));
  try {
    await assert.rejects(() => refreshPlatformToken('http://gw', 'oldrt'), /HTTP 401/);
  } finally {
    bad();
  }
});

test('ensurePlatformToken: valid token >5min left → returned directly (no fetch)', async () => {
  let called = 0;
  const restore = stubGlobalFetch(async () => {
    called++;
    return jsonResponse({});
  });
  try {
    const session: any = {
      platformAccessToken: 'valid',
      platformRefreshToken: 'rt',
      platformAccessExpiresAt: Date.now() + 60 * 60 * 1000,
    };
    const t = await ensurePlatformToken(session, 'http://gw');
    assert.equal(t.accessToken, 'valid');
    assert.equal(called, 0, 'must not refresh');
  } finally {
    restore();
  }
});

test('ensurePlatformToken: <5min left → refresh', async () => {
  const restore = stubGlobalFetch(async () => jsonResponse({ accessToken: jwt(FUTURE_EXP), refreshToken: 'rt3' }));
  try {
    const session: any = {
      platformAccessToken: 'expiring',
      platformRefreshToken: 'rt',
      platformAccessExpiresAt: Date.now() + 60 * 1000,
    };
    const t = await ensurePlatformToken(session, 'http://gw');
    assert.equal(t.accessToken, jwt(FUTURE_EXP));
    assert.equal(session.platformAccessToken, jwt(FUTURE_EXP), 'session mutated');
  } finally {
    restore();
  }
});

test('ensurePlatformToken: no refresh token → throws', async () => {
  const restore = stubGlobalFetch(async () => jsonResponse({}));
  try {
    const session: any = { platformAccessToken: 'x', platformAccessExpiresAt: 1 };
    await assert.rejects(() => ensurePlatformToken(session, 'http://gw'), /No platform refresh token/);
  } finally {
    restore();
  }
});

test('bootstrapViaGoogle: no googleRefreshToken → throws', async () => {
  const restore = stubGlobalFetch(async () => jsonResponse({}));
  try {
    await assert.rejects(
      () => bootstrapViaGoogle({}, 'http://gw', {} as any, buildDeviceInfo({} as any)),
      /No googleRefreshToken/,
    );
  } finally {
    restore();
  }
});

test('bootstrapViaGoogle: refreshes google id_token then login-google', async () => {
  const restore = stubGlobalFetch(async (url: string) => {
    if (String(url).includes('oauth2.googleapis.com/token')) {
      return jsonResponse({ id_token: 'idt-fresh', expires_in: 3600 });
    }
    return jsonResponse({ accessToken: jwt(FUTURE_EXP), refreshToken: 'rt-boot' });
  });
  try {
    const session: any = { googleRefreshToken: 'grt' };
    const t = await bootstrapViaGoogle(session, 'http://gw', { GOOGLE_CLIENT_ID_WEB: 'cid', GOOGLE_CLIENT_SECRET_WEB: 'cs' } as any, buildDeviceInfo({} as any));
    assert.equal(t.refreshToken, 'rt-boot');
    assert.equal(session.platformAccessToken, jwt(FUTURE_EXP));
  } finally {
    restore();
  }
});

test('getAccessToken: bootstraps when no platform tokens', async () => {
  const restore = stubGlobalFetch(async (url: string) => {
    if (String(url).includes('oauth2.googleapis.com/token')) return jsonResponse({ id_token: 'idt', expires_in: 3600 });
    return jsonResponse({ accessToken: jwt(FUTURE_EXP), refreshToken: 'rt' });
  });
  try {
    const session: any = { googleRefreshToken: 'grt' };
    const tok = await getAccessToken(session, 'http://gw', { GOOGLE_CLIENT_ID_WEB: 'cid', GOOGLE_CLIENT_SECRET_WEB: 'cs' } as any, buildDeviceInfo({} as any));
    assert.equal(tok, jwt(FUTURE_EXP));
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// community.client
// ---------------------------------------------------------------------------

test('listMyCommunities: unwraps {success,data} and raw array', async () => {
  const r1 = stubGlobalFetch(async () => jsonResponse({ success: true, data: ['c1', 'c2'] }));
  try {
    assert.deepEqual(await listMyCommunities('http://gw', 'tok'), ['c1', 'c2']);
  } finally {
    r1();
  }
  const r2 = stubGlobalFetch(async () => jsonResponse(['a', 'b']));
  try {
    assert.deepEqual(await listMyCommunities('http://gw', 'tok'), ['a', 'b']);
  } finally {
    r2();
  }
});

test('listMyCommunities: !ok → throws', async () => {
  const restore = stubGlobalFetch(async () => jsonResponse({ error: 'x' }, 500));
  try {
    await assert.rejects(() => listMyCommunities('http://gw', 'tok'), /HTTP 500/);
  } finally {
    restore();
  }
});

test('getMyMemberPermission: returns unwrapped permission', async () => {
  const restore = stubGlobalFetch(async () =>
    jsonResponse({ success: true, data: { id: 'mid', role: 'MEMBER', communityPermission: [{ permissionName: 'POST_CONTENT' }] } }),
  );
  try {
    const p = await getMyMemberPermission('http://gw', 'tok', 'cid');
    assert.equal(p.role, 'MEMBER');
    assert.equal(p.communityPermission?.[0].permissionName, 'POST_CONTENT');
  } finally {
    restore();
  }
});

test('hasPostPermission: OWNER → true; POST_CONTENT → true; member-no-perm → false; null → false', () => {
  assert.equal(hasPostPermission({ role: 'OWNER' }), true);
  assert.equal(hasPostPermission({ role: 'MEMBER', communityPermission: [{ permissionName: 'POST_CONTENT' }] }), true);
  assert.equal(hasPostPermission({ role: 'MEMBER', communityPermission: [] }), false);
  assert.equal(hasPostPermission(null), false);
  assert.equal(hasPostPermission(undefined), false);
});

// ---------------------------------------------------------------------------
// content-service.client
// ---------------------------------------------------------------------------

test('createPost: 201 → returns body', async () => {
  const restore = stubGlobalFetch(async () => jsonResponse({ data: { id: 'pid' } }, 201));
  try {
    const r = await createPost('http://gw', 'tok', { communityId: 'c', content: 'hi', layoutType: 'CLASSIC' });
    assert.equal(r.data.id, 'pid');
  } finally {
    restore();
  }
});

test('createPost: 400 profanity → throws with status + body', async () => {
  const restore = stubGlobalFetch(async () => jsonResponse({ error: 'INAPPROPRIATE_CONTENT', words: ['bad', 'words'] }, 400));
  try {
    await assert.rejects(
      async () => {
        try {
          await createPost('http://gw', 'tok', { communityId: 'c', content: 'x', layoutType: 'CLASSIC' });
        } catch (e: any) {
          assert.equal(e.status, 400);
          assert.equal(e.body.error, 'INAPPROPRIATE_CONTENT');
          throw e;
        }
      },
      /HTTP 400/,
    );
  } finally {
    restore();
  }
});

test('describeError: profanity forms', () => {
  assert.equal(describeError({ status: 400, body: { error: 'INAPPROPRIATE_CONTENT', words: ['bad'] } }), 'PROFANITY_REJECTED (words: bad)');
  assert.equal(describeError({ status: 400, body: { code: '40001' } }), 'PROFANITY_REJECTED (words: ?)');
  assert.equal(describeError({ status: 400, body: { words: ['x'] } }), 'PROFANITY_REJECTED (words: x)');
});

test('describeError: status mapping', () => {
  assert.equal(describeError({ status: 400, body: { error: 'OTHER', message: 'm' } }), 'BAD_REQUEST (OTHER)');
  assert.equal(describeError({ status: 401, body: {} }), 'UNAUTHORIZED (token invalid?)');
  assert.equal(describeError({ status: 403, body: {} }), 'FORBIDDEN (no post permission / not a member?)');
  assert.equal(describeError({ status: 500, body: {} }), 'SERVER_ERROR (500)');
});

test('describeError: unknown → message or UNKNOWN', () => {
  assert.equal(describeError({ message: 'something' }), 'something');
  assert.equal(describeError({}), 'UNKNOWN');
});

// ---------------------------------------------------------------------------
// upload.client
// ---------------------------------------------------------------------------

test('uploadImage: 200 {data:{id}} → fileId', async () => {
  const restore = stubGlobalFetch(async () => jsonResponse({ data: { id: 'fid' } }));
  try {
    const id = await uploadImage('http://gw', 'tok', { bytes: new Uint8Array([1, 2, 3]), filename: 'a.jpg', mimeType: 'image/jpeg' });
    assert.equal(id, 'fid');
  } finally {
    restore();
  }
});

test('uploadImage: 200 raw {id} → fileId', async () => {
  const restore = stubGlobalFetch(async () => jsonResponse({ id: 'fid2' }));
  try {
    const id = await uploadImage('http://gw', 'tok', { bytes: new Uint8Array([1]), filename: 'a.jpg', mimeType: 'image/jpeg' });
    assert.equal(id, 'fid2');
  } finally {
    restore();
  }
});

test('uploadImage: 200 no id → throws', async () => {
  const restore = stubGlobalFetch(async () => jsonResponse({ foo: 'bar' }));
  try {
    await assert.rejects(
      () => uploadImage('http://gw', 'tok', { bytes: new Uint8Array([1]), filename: 'a.jpg', mimeType: 'image/jpeg' }),
      /no id/,
    );
  } finally {
    restore();
  }
});

test('uploadImage: !ok → throws', async () => {
  const restore = stubGlobalFetch(async () => jsonResponse({ error: 'x' }, 413));
  try {
    await assert.rejects(
      () => uploadImage('http://gw', 'tok', { bytes: new Uint8Array([1]), filename: 'a.jpg', mimeType: 'image/jpeg' }),
      /HTTP 413/,
    );
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// llm.client
// ---------------------------------------------------------------------------

test('rewriteArticle: 200 text content → rewritten string', async () => {
  const restore = stubGlobalFetch(async () => jsonResponse({ content: [{ type: 'text', text: 'REWRITTEN' }] }));
  try {
    const out = await rewriteArticle({ baseUrl: 'https://8.8.8.8', apiKey: 'k', model: 'm', title: 'T', body: 'B' });
    assert.equal(out, 'REWRITTEN');
  } finally {
    restore();
  }
});

test('rewriteArticle: 3xx redirect → throws (no header forwarding)', async () => {
  const restore = stubGlobalFetch(async () => new Response(null, { status: 302, headers: { location: 'https://evil.com/x' } }));
  try {
    await assert.rejects(
      () => rewriteArticle({ baseUrl: 'https://8.8.8.8', apiKey: 'k', model: 'm', title: 'T', body: 'B' }),
      /redirect not allowed/i,
    );
  } finally {
    restore();
  }
});

test('rewriteArticle: 401 → throws', async () => {
  const restore = stubGlobalFetch(async () => new Response('unauthorized', { status: 401 }));
  try {
    await assert.rejects(
      () => rewriteArticle({ baseUrl: 'https://8.8.8.8', apiKey: 'k', model: 'm', title: 'T', body: 'B' }),
      /HTTP 401/,
    );
  } finally {
    restore();
  }
});

test('rewriteArticle: non-array content → throws', async () => {
  const restore = stubGlobalFetch(async () => jsonResponse({ content: 'not-an-array' }));
  try {
    await assert.rejects(
      () => rewriteArticle({ baseUrl: 'https://8.8.8.8', apiKey: 'k', model: 'm', title: 'T', body: 'B' }),
      /unexpected response/,
    );
  } finally {
    restore();
  }
});

test('rewriteArticle: invalid http base URL (public host) → SSRF reject', async () => {
  const restore = stubGlobalFetch(async () => jsonResponse({ content: [{ type: 'text', text: 'X' }] }));
  try {
    await assert.rejects(
      () => rewriteArticle({ baseUrl: 'http://evil.com', apiKey: 'k', model: 'm', title: 'T', body: 'B' }),
      /https/,
    );
  } finally {
    restore();
  }
});
