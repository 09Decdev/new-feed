import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPrivateIp,
  validatePublicUrlStatic,
  validateLlmBaseUrlStatic,
  safeFetchDownload,
  SafeUrlError,
} from '../../safe-fetch';
import { stubGlobalFetch } from '../helpers/test-env';

// --- isPrivateIp: IPv4 -------------------------------------------------------

test('isPrivateIp flags IPv4 private ranges', () => {
  for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.0.1', '192.168.1.1', '100.64.0.1', '192.0.0.1', '198.18.0.1', '0.0.0.0', '224.0.0.1']) {
    assert.equal(isPrivateIp(ip), true, `${ip} should be private`);
  }
});

test('isPrivateIp passes IPv4 public addresses', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.0.1', '11.0.0.1']) {
    assert.equal(isPrivateIp(ip), false, `${ip} should be public`);
  }
});

// --- isPrivateIp: IPv6 -------------------------------------------------------

test('isPrivateIp flags IPv6 private ranges', () => {
  for (const ip of ['::1', '::', 'fc00::1', 'fd00::1', 'fe80::1', 'fec0::1', 'ff00::1', '2001:db8::1']) {
    assert.equal(isPrivateIp(ip), true, `${ip} should be private`);
  }
});

test('isPrivateIp flags IPv4-mapped IPv6 forms', () => {
  assert.equal(isPrivateIp('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateIp('::ffff:7f00:1'), true); // hex form of 127.0.0.1
  assert.equal(isPrivateIp('::ffff:8.8.8.8'), false); // mapped public
});

test('isPrivateIp rejects IPv6 zone ids (link-local scope)', () => {
  assert.equal(isPrivateIp('fe80::1%eth0'), true);
});

test('isPrivateIp returns false for non-IP literals', () => {
  assert.equal(isPrivateIp('example.com'), false);
  assert.equal(isPrivateIp('not-an-ip'), false);
});

// --- validatePublicUrlStatic ------------------------------------------------

test('validatePublicUrlStatic accepts public http(s)', () => {
  assert.equal(validatePublicUrlStatic('https://example.com/a').hostname, 'example.com');
  assert.equal(validatePublicUrlStatic('http://8.8.8.8/x').hostname, '8.8.8.8');
});

test('validatePublicUrlStatic rejects non-http(s) schemes', () => {
  assert.throws(() => validatePublicUrlStatic('file:///etc/passwd'), SafeUrlError);
  assert.throws(() => validatePublicUrlStatic('ftp://example.com'), SafeUrlError);
});

test('validatePublicUrlStatic rejects internal hostnames', () => {
  for (const u of [
    'https://localhost/x',
    'https://foo.local/x',
    'https://foo.internal/x',
    'https://foo.home.arpa/x',
    'https://metadata/x',
    'https://metadata.google.internal/x',
  ]) {
    assert.throws(() => validatePublicUrlStatic(u), SafeUrlError, u);
  }
});

test('validatePublicUrlStatic rejects private/metadata IPs', () => {
  for (const u of ['http://127.0.0.1/x', 'http://10.0.0.1/x', 'http://169.254.169.254/x', 'http://192.168.1.1/x']) {
    assert.throws(() => validatePublicUrlStatic(u), SafeUrlError, u);
  }
});

test('validatePublicUrlStatic rejects empty/invalid hostname', () => {
  // `new URL('http://')` throws ERR_INVALID_URL → caught → SafeUrlError
  assert.throws(() => validatePublicUrlStatic('http://'), SafeUrlError);
  assert.throws(() => validatePublicUrlStatic('https://'), SafeUrlError);
});

// --- validateLlmBaseUrlStatic -----------------------------------------------

test('validateLlmBaseUrlStatic blocks http to public host', () => {
  assert.throws(() => validateLlmBaseUrlStatic('http://evil.com'), SafeUrlError);
  assert.throws(() => validateLlmBaseUrlStatic('http://8.8.8.8'), SafeUrlError);
});

test('validateLlmBaseUrlStatic allows http to known dev hosts', () => {
  for (const u of ['http://127.0.0.1:8080', 'http://localhost:11434', 'http://10.0.0.5:8080', 'http://192.168.1.5:8080', 'http://172.16.0.5:8080']) {
    assert.equal(validateLlmBaseUrlStatic(u).hostname, new URL(u).hostname, u);
  }
});

test('validateLlmBaseUrlStatic rejects http to 172.32 (outside 16-31)', () => {
  assert.throws(() => validateLlmBaseUrlStatic('http://172.32.0.1'), SafeUrlError);
});

test('validateLlmBaseUrlStatic https applies full SSRF rules (blocks private https)', () => {
  assert.throws(() => validateLlmBaseUrlStatic('https://127.0.0.1'), SafeUrlError);
  assert.throws(() => validateLlmBaseUrlStatic('https://169.254.169.254'), SafeUrlError);
});

test('validateLlmBaseUrlStatic accepts https public endpoint', () => {
  assert.equal(validateLlmBaseUrlStatic('https://api.ai-box.vn').hostname, 'api.ai-box.vn');
});

test('validateLlmBaseUrlStatic rejects non-http(s)', () => {
  assert.throws(() => validateLlmBaseUrlStatic('file://x'), SafeUrlError);
});

// --- safeFetchDownload (stubbed fetch, IP-literal URLs → no DNS) ------------

test('safeFetchDownload returns a capped download on 200', async () => {
  const restore = stubGlobalFetch(async () => new Response('hello world', { status: 200 }));
  try {
    const r = await safeFetchDownload('https://8.8.8.8/x', { maxBytes: 1024 });
    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
    assert.equal(r.text, 'hello world');
  } finally {
    restore();
  }
});

test('safeFetchDownload returns non-ok status without throwing', async () => {
  const restore = stubGlobalFetch(async () => new Response('nope', { status: 404 }));
  try {
    const r = await safeFetchDownload('https://8.8.8.8/x');
    assert.equal(r.ok, false);
    assert.equal(r.status, 404);
  } finally {
    restore();
  }
});

test('safeFetchDownload blocks redirect to a private IP (re-validation per hop)', async () => {
  const restore = stubGlobalFetch(
    async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/evil' } }),
  );
  try {
    await assert.rejects(
      () => safeFetchDownload('https://8.8.8.8/start'),
      SafeUrlError,
      'must reject redirect target',
    );
  } finally {
    restore();
  }
});

test('safeFetchDownload enforces max-redirects (3)', async () => {
  const restore = stubGlobalFetch(
    async () => new Response(null, { status: 302, headers: { location: 'https://8.8.8.8/loop' } }),
  );
  try {
    await assert.rejects(() => safeFetchDownload('https://8.8.8.8/start'), /Quá nhiều redirect|redirect/i);
  } finally {
    restore();
  }
});

test('safeFetchDownload enforces size cap via content-length', async () => {
  const restore = stubGlobalFetch(
    async () => new Response('', { status: 200, headers: { 'content-length': '999999999' } }),
  );
  try {
    await assert.rejects(() => safeFetchDownload('https://8.8.8.8/x', { maxBytes: 2048 }), SafeUrlError);
  } finally {
    restore();
  }
});
