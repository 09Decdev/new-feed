import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { load, hashKey, isPosted, markPosted, listHistory, type PostedEntry } from '../../dedup';

function tempFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-dedup-'));
  return path.join(dir, name);
}

test('hashKey is deterministic sha256 hex (64 chars)', () => {
  const a = hashKey('https://example.com/a');
  const b = hashKey('https://example.com/a');
  assert.equal(a, b);
  assert.equal(a.length, 64);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('load returns [] for missing file', () => {
  assert.deepEqual(load(path.join(os.tmpdir(), 'np-missing-' + process.pid + '.json')), []);
});

test('load returns [] for corrupt JSON', () => {
  const f = tempFile('corrupt.json');
  fs.writeFileSync(f, '{not valid json', 'utf8');
  assert.deepEqual(load(f), []);
});

test('markPosted records a new entry atomically', async () => {
  const f = tempFile('new.json');
  await markPosted(f, { key: 'k1', ts: 100, status: 'posted', title: 'T1' });
  const arr = load(f);
  assert.equal(arr.length, 1);
  assert.equal(arr[0].key, 'k1');
  assert.equal(arr[0].status, 'posted');
});

test('markPosted upgrades a legacy {key,ts} entry in place (no duplicate)', async () => {
  const f = tempFile('legacy.json');
  fs.writeFileSync(f, JSON.stringify([{ key: 'k1', ts: 100 }]), 'utf8');
  await markPosted(f, { key: 'k1', ts: 200, status: 'posted', title: 'Upgraded' });
  const arr = load(f);
  assert.equal(arr.length, 1, 'must not duplicate');
  assert.equal(arr[0].status, 'posted');
  assert.equal(arr[0].title, 'Upgraded');
  assert.equal(arr[0].ts, 200);
});

test('markPosted does not overwrite an already-recorded posted entry', async () => {
  const f = tempFile('dup.json');
  await markPosted(f, { key: 'k1', ts: 100, status: 'posted', title: 'First' });
  await markPosted(f, { key: 'k1', ts: 999, status: 'posted', title: 'Second' });
  const arr = load(f);
  assert.equal(arr.length, 1);
  assert.equal(arr[0].ts, 100, 'original preserved');
  assert.equal(arr[0].title, 'First');
});

test('markPosted caps the file at 1000 entries', async () => {
  const f = tempFile('cap.json');
  const seed: PostedEntry[] = [];
  for (let i = 0; i < 1001; i++) seed.push({ key: 'k' + i, ts: i, status: 'posted' });
  fs.writeFileSync(f, JSON.stringify(seed), 'utf8');
  // add one more beyond the cap
  await markPosted(f, { key: 'kNEW', ts: 5000, status: 'posted' });
  const arr = load(f);
  assert.equal(arr.length, 1000, 'must trim to 1000');
  assert.ok(arr.some((e) => e.key === 'kNEW'));
});

test('isPosted reflects recorded keys', async () => {
  const f = tempFile('check.json');
  await markPosted(f, { key: 'present', ts: 1, status: 'posted' });
  assert.equal(isPosted(f, 'present'), true);
  assert.equal(isPosted(f, 'absent'), false);
});

test('listHistory sorts ts DESC, filters status, limits', async () => {
  const f = tempFile('hist.json');
  await markPosted(f, { key: 'a', ts: 100, status: 'posted' });
  await markPosted(f, { key: 'b', ts: 300, status: 'failed' });
  await markPosted(f, { key: 'c', ts: 200, status: 'posted' });

  const all = listHistory(f);
  assert.deepEqual(all.map((e) => e.key), ['b', 'c', 'a'], 'desc by ts');

  const posted = listHistory(f, { status: 'posted' });
  assert.deepEqual(posted.map((e) => e.key), ['c', 'a']);

  const failed = listHistory(f, { status: 'failed' });
  assert.deepEqual(failed.map((e) => e.key), ['b']);
});

test('listHistory default limit 100 and hard cap 1000', () => {
  const f = tempFile('limit.json');
  const seed: PostedEntry[] = [];
  for (let i = 0; i < 150; i++) seed.push({ key: 'k' + i, ts: i, status: 'posted' });
  fs.writeFileSync(f, JSON.stringify(seed), 'utf8');
  assert.equal(listHistory(f).length, 100, 'default limit 100');
  assert.equal(listHistory(f, { limit: 1000 }).length, 150, 'cap not below real count');
});

test('listHistory limit 0 returns empty array', async () => {
  const f = tempFile('zero.json');
  await markPosted(f, { key: 'a', ts: 1, status: 'posted' });
  assert.deepEqual(listHistory(f, { limit: 0 }), []);
});
