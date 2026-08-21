import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadConfig,
  toPublic,
  applyUpdates,
  atomicWrite,
  atomicWriteSync,
  readEnv,
  WRITE_ALLOWLIST_ENV,
} from '../../config-store';

const ENV_KEYS = [
  ...WRITE_ALLOWLIST_ENV,
  'LLM_API_KEY',
  'GOOGLE_CLIENT_SECRET_WEB',
  'GUI_TOKEN',
  'GUI_HOST',
  'GUI_PORT',
  'LOOP_LOCK_FILE',
  'SESSION_FILE',
  'DEDUP_FILE',
  'GATEWAY_URL',
  'GOOGLE_CLIENT_ID_WEB',
  'GOOGLE_OAUTH_REDIRECT_URI',
  'GOOGLE_OAUTH_PORT',
  'DEVICE_INSTALLATION_ID',
  'DEVICE_FINGERPRINT',
];
let snapshot: Record<string, string | undefined> = {};

before(() => {
  for (const k of ENV_KEYS) {
    snapshot[k] = process.env[k];
    delete process.env[k];
  }
});

// applyUpdates syncs written/deleted keys into process.env — clear between tests
// so an earlier write can't override a later test's file values via mergedValues.
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

after(() => {
  for (const k of ENV_KEYS) {
    if (snapshot[k] === undefined) delete process.env[k];
    else process.env[k] = snapshot[k]!;
  }
  snapshot = {};
});

function tempEnv(extra: string[] = []): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-cfg-'));
  const p = path.join(dir, '.env');
  const lines = [
    'GATEWAY_URL=http://gw.example.com',
    'GOOGLE_CLIENT_ID_WEB=cid',
    'GOOGLE_CLIENT_SECRET_WEB=cs-secret-val',
    'GOOGLE_OAUTH_REDIRECT_URI=http://localhost:8790/callback',
    'GOOGLE_OAUTH_PORT=8790',
    'COMMUNITY_ID=comm-1',
    'LAYOUT_TYPE=CLASSIC',
    'RSS_FEED_URL=https://example.com/feed.rss',
    'RSS_LIMIT_PER_CYCLE=2',
    'POST_INTERVAL_MS=120000',
    'DRY_RUN=false',
    'REWRITE_WITH_AI=false',
    'LLM_BASE_URL=https://api.ai-box.vn',
    'LLM_API_KEY=llm-secret-key-val',
    'LLM_MODEL=test-model',
    ...extra,
  ];
  fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8');
  return p;
}

// --- readEnv quoting ---------------------------------------------------------

test('readEnv unquotes double-quoted values and unescapes \" and \\', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-cfg-'));
  const p = path.join(dir, '.env');
  fs.writeFileSync(p, 'A="val with spaces"\nB=\'single\'\nC=plain"b\nD="a\\"b\\\\c"\n', 'utf8');
  const v = readEnv(p);
  assert.equal(v.A, 'val with spaces');
  assert.equal(v.B, 'single');
  assert.equal(v.C, 'plain"b');
  assert.equal(v.D, 'a"b\\c');
});

// --- loadConfig defaults + override semantics --------------------------------

test('loadConfig returns defaults for an empty .env', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-cfg-'));
  const p = path.join(dir, '.env');
  fs.writeFileSync(p, '', 'utf8');
  const cfg = loadConfig(p);
  assert.equal(cfg.gatewayUrl, 'http://localhost:3005');
  assert.equal(cfg.rssUrl, 'https://vnexpress.net/rss/tin-moi-nhat.rss');
  assert.equal(cfg.guiHost, '127.0.0.1');
  assert.equal(cfg.guiPort, 8899);
  assert.equal(cfg.communityId, '');
  assert.equal(cfg.rewriteWithAi, true);
  assert.equal(cfg.rssLimit, 1);
});

test('loadConfig reads file values', () => {
  const p = tempEnv();
  const cfg = loadConfig(p);
  assert.equal(cfg.communityId, 'comm-1');
  assert.equal(cfg.rssLimit, 2);
  assert.equal(cfg.intervalMs, 120000);
  assert.equal(cfg.dryRun, false);
  assert.equal(cfg.rewriteWithAi, false);
  assert.equal(cfg.llmApiKey, 'llm-secret-key-val');
});

test('loadConfig: process.env OVERRIDES file for known keys', () => {
  const p = tempEnv();
  process.env.COMMUNITY_ID = 'env-override';
  try {
    assert.equal(loadConfig(p).communityId, 'env-override');
  } finally {
    delete process.env.COMMUNITY_ID;
  }
});

test('loadConfig: empty-string env is treated as absent (no resurrect)', () => {
  const p = tempEnv();
  process.env.COMMUNITY_ID = '';
  try {
    assert.equal(loadConfig(p).communityId, 'comm-1', 'file value used when env is empty');
  } finally {
    delete process.env.COMMUNITY_ID;
  }
});

// --- toPublic masking --------------------------------------------------------

test('toPublic masks secrets as {set:bool} and never leaks values', () => {
  const p = tempEnv();
  const cfg = loadConfig(p);
  const pub = toPublic(cfg) as any;
  assert.deepEqual(pub.GOOGLE_CLIENT_SECRET_WEB, { set: true });
  assert.deepEqual(pub.LLM_API_KEY, { set: true });
  assert.deepEqual(pub.GUI_TOKEN, { set: false });
  const serialized = JSON.stringify(pub);
  assert.ok(!serialized.includes('cs-secret-val'), 'secret value leaked');
  assert.ok(!serialized.includes('llm-secret-key-val'), 'llm key leaked');
});

test('toPublic shows set:false when secrets are empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-cfg-'));
  const p = path.join(dir, '.env');
  fs.writeFileSync(p, 'COMMUNITY_ID=c\n', 'utf8');
  const pub = toPublic(loadConfig(p)) as any;
  assert.deepEqual(pub.GOOGLE_CLIENT_SECRET_WEB, { set: false });
  assert.deepEqual(pub.LLM_API_KEY, { set: false });
});

// --- applyUpdates: valid writes ---------------------------------------------

test('applyUpdates writes allowlist fields and syncs process.env', async () => {
  const p = tempEnv();
  const res = await applyUpdates(p, { COMMUNITY_ID: 'newcomm', RSS_LIMIT_PER_CYCLE: 5 });
  assert.deepEqual(res.written.sort(), ['COMMUNITY_ID', 'RSS_LIMIT_PER_CYCLE']);
  assert.equal(loadConfig(p).communityId, 'newcomm');
  assert.equal(process.env.COMMUNITY_ID, 'newcomm');
  assert.equal(process.env.RSS_LIMIT_PER_CYCLE, '5');
});

test('applyUpdates rejects unknown fields and leaves the file untouched', async () => {
  const p = tempEnv();
  await assert.rejects(() => applyUpdates(p, { HACKED: 'x' }), /Unknown config field/);
  assert.equal(loadConfig(p).communityId, 'comm-1', 'file unchanged');
  assert.equal(readEnv(p).HACKED, undefined);
});

test('applyUpdates rejects non-positive-integer numerics', async () => {
  const p = tempEnv();
  await assert.rejects(() => applyUpdates(p, { POST_INTERVAL_MS: -1 }), /positive integer/);
  await assert.rejects(() => applyUpdates(p, { POST_INTERVAL_MS: 1.5 }), /positive integer/);
  await assert.rejects(() => applyUpdates(p, { RSS_LIMIT_PER_CYCLE: 0 }), /positive integer/);
  assert.equal(loadConfig(p).intervalMs, 120000, 'file untouched on validation failure');
});

test('applyUpdates rejects bad booleans', async () => {
  const p = tempEnv();
  await assert.rejects(() => applyUpdates(p, { DRY_RUN: 'maybe' }), /boolean/);
  await assert.rejects(() => applyUpdates(p, { REWRITE_WITH_AI: 1 }), /boolean/);
});

test('applyUpdates rejects empty required strings', async () => {
  const p = tempEnv();
  await assert.rejects(() => applyUpdates(p, { COMMUNITY_ID: '' }), /must not be empty/);
  await assert.rejects(() => applyUpdates(p, { COMMUNITY_ID: '   ' }), /must not be empty/);
});

test('applyUpdates validates LLM_BASE_URL (SSRF guard on write path)', async () => {
  const p = tempEnv();
  await assert.rejects(() => applyUpdates(p, { LLM_BASE_URL: 'http://evil.com' }), /https/);
  await assert.rejects(() => applyUpdates(p, { LLM_BASE_URL: 'file://x' }), /https|http/);
  // http to loopback is allowed
  const res = await applyUpdates(p, { LLM_BASE_URL: 'http://127.0.0.1:8080' });
  assert.deepEqual(res.written, ['LLM_BASE_URL']);
});

// --- applyUpdates: secret tri-state via *_SET --------------------------------

test('applyUpdates _SET with a value writes the secret and syncs env', async () => {
  const p = tempEnv();
  const res = await applyUpdates(p, { LLM_API_KEY_SET: 'brand-new-key-val' });
  assert.deepEqual(res.written, ['LLM_API_KEY']);
  assert.equal(loadConfig(p).llmApiKey, 'brand-new-key-val');
  assert.equal(process.env.LLM_API_KEY, 'brand-new-key-val');
});

test('applyUpdates _SET="" deletes the secret and removes env', async () => {
  const p = tempEnv();
  process.env.LLM_API_KEY = 'stale';
  try {
    const res = await applyUpdates(p, { LLM_API_KEY_SET: '' });
    assert.deepEqual(res.deleted, ['LLM_API_KEY']);
    assert.equal(loadConfig(p).llmApiKey, '', 'secret cleared');
    assert.equal(process.env.LLM_API_KEY, undefined, 'env key removed');
    assert.equal(readEnv(p).LLM_API_KEY, undefined, 'file line removed');
  } finally {
    delete process.env.LLM_API_KEY;
  }
});

test('applyUpdates _SET absent (undefined) keeps the current secret', async () => {
  const p = tempEnv();
  const res = await applyUpdates(p, { LLM_API_KEY_SET: undefined, COMMUNITY_ID: 'other' });
  assert.deepEqual(res.written, ['COMMUNITY_ID']);
  assert.deepEqual(res.deleted, []);
  assert.equal(loadConfig(p).llmApiKey, 'llm-secret-key-val', 'secret preserved');
});

test('applyUpdates _SET with whitespace-only throws', async () => {
  const p = tempEnv();
  await assert.rejects(() => applyUpdates(p, { LLM_API_KEY_SET: '   ' }), /Invalid value/);
});

// --- round-trip: comments + foreign lines preserved -------------------------

test('applyUpdates preserves comments and foreign lines, updates in place', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-cfg-'));
  const p = path.join(dir, '.env');
  fs.writeFileSync(
    p,
    '# top comment\nFOREIGN=keepme\nCOMMUNITY_ID=old\nLLM_API_KEY=secretval1234\n',
    'utf8',
  );
  await applyUpdates(p, { COMMUNITY_ID: 'new' });
  const text = fs.readFileSync(p, 'utf8');
  assert.ok(text.includes('# top comment'), 'comment preserved');
  assert.ok(text.includes('FOREIGN=keepme'), 'foreign line preserved');
  assert.ok(text.includes('COMMUNITY_ID=new'), 'field updated in place');
  assert.equal(loadConfig(p).communityId, 'new');
});

test('applyUpdates neutralizes CR/LF in values (no .env line injection)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-cfg-'));
  const p = path.join(dir, '.env');
  fs.writeFileSync(p, 'COMMUNITY_ID=old\n', 'utf8');
  await applyUpdates(p, { LAYOUT_TYPE: 'a\nINJECTED=bad' });
  assert.equal(readEnv(p).INJECTED, undefined, 'no injected key became a line');
  assert.ok(readEnv(p).LAYOUT_TYPE.includes('a'), 'value still recorded');
});

// --- atomic write ------------------------------------------------------------

test('atomicWrite writes content readable back', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-cfg-'));
  const p = path.join(dir, 'atom.txt');
  await atomicWrite(p, 'line1\nline2\n');
  assert.equal(fs.readFileSync(p, 'utf8'), 'line1\nline2\n');
});

test('atomicWriteSync writes content readable back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-cfg-'));
  const p = path.join(dir, 'atom-sync.txt');
  atomicWriteSync(p, 'synced');
  assert.equal(fs.readFileSync(p, 'utf8'), 'synced');
});
