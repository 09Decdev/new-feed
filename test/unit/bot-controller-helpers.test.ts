import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  truncate,
  sleep,
  abortableSleep,
  collectSecrets,
  isProfanityRejection,
  describeForUser,
  buildRewrittenContent,
} from '../../bot.controller';
import { stubGlobalFetch, jsonResponse } from '../helpers/test-env';

// --- truncate ---------------------------------------------------------------

test('truncate returns the string when <= n', () => {
  assert.equal(truncate('abc', 5), 'abc');
  assert.equal(truncate('exactly5', 8), 'exactly5');
});

test('truncate appends ellipsis when > n', () => {
  assert.equal(truncate('12345', 3), '12…');
  assert.equal(truncate('abcdefgh', 5), 'abcd…');
});

// --- sleep / abortableSleep -------------------------------------------------

test('sleep resolves after the delay', async () => {
  const t0 = Date.now();
  await sleep(30);
  assert.ok(Date.now() - t0 >= 25);
});

test('abortableSleep resolves immediately when signal already aborted', async () => {
  const ac = new AbortController();
  ac.abort();
  const t0 = Date.now();
  await abortableSleep(5000, ac.signal);
  assert.ok(Date.now() - t0 < 100, 'should not wait when pre-aborted');
});

test('abortableSleep resolves promptly when aborted mid-sleep', async () => {
  const ac = new AbortController();
  const t0 = Date.now();
  const p = abortableSleep(5000, ac.signal);
  setTimeout(() => ac.abort(), 15);
  await p;
  assert.ok(Date.now() - t0 < 200, 'should stop shortly after abort');
});

// --- collectSecrets ---------------------------------------------------------

test('collectSecrets gathers all >=4-char secrets from cfg + session', () => {
  const out = collectSecrets(
    { llmApiKey: 'key1234', googleClientSecret: 'cs1234', guiToken: 'tok1234' },
    { platformAccessToken: 'at1234', googleRefreshToken: 'gr1234', platformRefreshToken: 'pr1234' },
  );
  assert.equal(out.length, 6);
  assert.ok(out.includes('key1234'));
  assert.ok(out.includes('pr1234'));
});

test('collectSecrets ignores secrets shorter than 4 chars', () => {
  assert.deepEqual(collectSecrets({ llmApiKey: 'abc' }), []);
  assert.deepEqual(collectSecrets({ guiToken: 't' }), []);
});

test('collectSecrets ignores undefined/missing', () => {
  assert.deepEqual(collectSecrets({}, {}), []);
  assert.deepEqual(collectSecrets(), []);
});

// --- isProfanityRejection ---------------------------------------------------

test('isProfanityRejection is true when flagged words are present', () => {
  assert.equal(isProfanityRejection({ ok: false, words: ['bad', 'words'] }), true);
});

test('isProfanityRejection detects reason-code forms', () => {
  assert.equal(isProfanityRejection({ ok: false, reason: 'PROFANITY_REJECTED (words: x)' }), true);
  assert.equal(isProfanityRejection({ ok: false, reason: 'error INAPPROPRIATE_CONTENT done' }), true);
  assert.equal(isProfanityRejection({ ok: false, reason: 'code 40001 hit' }), true);
});

test('isProfanityRejection is false for other reasons', () => {
  assert.equal(isProfanityRejection({ ok: false, reason: 'FORBIDDEN' }), false);
  assert.equal(isProfanityRejection({ ok: false, reason: 'UNAUTHORIZED' }), false);
  assert.equal(isProfanityRejection({ ok: false }), false);
});

// --- describeForUser --------------------------------------------------------

test('describeForUser maps known prefixes and exact codes (not fallback)', () => {
  assert.equal(describeForUser(undefined), 'Không xác định được lỗi.');
  // Each must be a real mapping — never the `${DEFAULT} (reason)` fallback form.
  const prof = describeForUser('PROFANITY_REJECTED (words: x)');
  assert.ok(!prof.includes('Không đăng được bài') && prof.includes('vi phạm'), prof);

  const unauth = describeForUser('UNAUTHORIZED (token invalid?)');
  assert.ok(!unauth.includes('Không đăng được bài') && unauth.includes('hết hạn'), unauth);

  const forb = describeForUser('FORBIDDEN (x)');
  assert.ok(!forb.includes('Không đăng được bài') && forb.includes('quyền đăng bài'), forb);

  const srv = describeForUser('SERVER_ERROR (500)');
  assert.ok(!srv.includes('Không đăng được bài') && srv.includes('máy chủ'), srv);

  const missing = describeForUser('MISSING_COMMUNITY_ID');
  assert.ok(!missing.includes('Không đăng được bài') && missing.includes('COMMUNITY_ID'), missing);

  const boot = describeForUser('AUTH_BOOTSTRAP_FAILED');
  assert.ok(!boot.includes('Không đăng được bài') && boot.includes('Google'), boot);
});

test('describeForUser falls back to generic for unknown codes', () => {
  assert.equal(describeForUser('SOMETHING_NEW'), 'Không đăng được bài. (SOMETHING_NEW)');
});

// --- buildRewrittenContent --------------------------------------------------

const ITEM = { title: 'Tiêu đề bài', link: 'https://example.com/a', description: '<p>Mô tả ngắn</p>', pubDate: '' };

test('buildRewrittenContent: no scraped body → teaser', async () => {
  const out = await buildRewrittenContent({ rewriteWithAi: true, llmApiKey: 'k', llmBaseUrl: 'https://8.8.8.8', llmModel: 'm' }, ITEM, null);
  assert.ok(out.includes('Tiêu đề bài'));
  assert.ok(out.includes('Mô tả ngắn'));
  assert.ok(out.includes('Nguồn:'));
});

test('buildRewrittenContent: rewriteWithAi but no key → teaser', async () => {
  const out = await buildRewrittenContent({ rewriteWithAi: true, llmApiKey: '', llmBaseUrl: 'https://8.8.8.8', llmModel: 'm' }, ITEM, 'raw body');
  assert.ok(!out.includes('raw body'), 'must not use raw body when rewrite missing key');
  assert.ok(out.includes('Mô tả ngắn'));
});

test('buildRewrittenContent: rewrite off → raw scraped body', async () => {
  const out = await buildRewrittenContent({ rewriteWithAi: false, llmApiKey: '', llmBaseUrl: 'https://8.8.8.8', llmModel: 'm' }, ITEM, 'RAW BODY TEXT');
  assert.ok(out.includes('RAW BODY TEXT'));
});

test('buildRewrittenContent: successful rewrite uses rewritten body', async () => {
  const restore = stubGlobalFetch(async () =>
    jsonResponse({ content: [{ type: 'text', text: 'REWRITTEN ARTICLE BODY' }] }, 200),
  );
  try {
    const out = await buildRewrittenContent({ rewriteWithAi: true, llmApiKey: 'k', llmBaseUrl: 'https://8.8.8.8', llmModel: 'm' }, ITEM, 'original scraped body');
    assert.ok(out.includes('REWRITTEN ARTICLE BODY'));
    assert.ok(!out.includes('original scraped body'));
  } finally {
    restore();
  }
});

test('buildRewrittenContent: rewrite failure → teaser fallback', async () => {
  const restore = stubGlobalFetch(async () => new Response('nope', { status: 401 }));
  try {
    const out = await buildRewrittenContent({ rewriteWithAi: true, llmApiKey: 'k', llmBaseUrl: 'https://8.8.8.8', llmModel: 'm' }, ITEM, 'original scraped body');
    assert.ok(!out.includes('original scraped body'), 'raw body must not leak on rewrite failure');
    assert.ok(out.includes('Mô tả ngắn'));
  } finally {
    restore();
  }
});

test('buildRewrittenContent: invalid LLM_BASE_URL → teaser fallback (SSRF guard)', async () => {
  const restore = stubGlobalFetch(async () => jsonResponse({ content: [{ type: 'text', text: 'X' }] }, 200));
  try {
    const out = await buildRewrittenContent({ rewriteWithAi: true, llmApiKey: 'k', llmBaseUrl: 'http://evil.com', llmModel: 'm' }, ITEM, 'original scraped body');
    assert.ok(!out.includes('original scraped body'));
    assert.ok(out.includes('Mô tả ngắn'));
  } finally {
    restore();
  }
});
