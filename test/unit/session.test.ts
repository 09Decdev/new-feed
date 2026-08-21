import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadSession, saveSession, type Session } from '../../session';

function tempFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-sess-'));
  return path.join(dir, name);
}

test('loadSession returns {} for missing file', () => {
  assert.deepEqual(loadSession(path.join(os.tmpdir(), 'np-sess-missing-' + process.pid + '.json')), {});
});

test('loadSession returns {} for corrupt JSON', () => {
  const f = tempFile('bad.json');
  fs.writeFileSync(f, '{broken', 'utf8');
  assert.deepEqual(loadSession(f), {});
});

test('loadSession returns {} for non-object JSON (number/string)', () => {
  const fNum = tempFile('num.json');
  fs.writeFileSync(fNum, '123', 'utf8');
  assert.deepEqual(loadSession(fNum), {});
  const fStr = tempFile('str.json');
  fs.writeFileSync(fStr, '"hello"', 'utf8');
  assert.deepEqual(loadSession(fStr), {});
});

test('loadSession returns array JSON as-is (typeof object, truthy)', () => {
  // Arrays pass the `typeof === 'object'` guard — documents current behavior.
  const f = tempFile('arr.json');
  fs.writeFileSync(f, '[1,2,3]', 'utf8');
  const back = loadSession(f);
  assert.ok(Array.isArray(back));
  assert.deepEqual(back, [1, 2, 3]);
});

test('saveSession round-trips a session atomically', () => {
  const f = tempFile('round.json');
  const s: Session = {
    platformAccessToken: 'access-123',
    platformRefreshToken: 'refresh-456',
    platformAccessExpiresAt: 1700000000000,
    googleRefreshToken: 'google-rt-789',
  };
  saveSession(f, s);
  const back = loadSession(f);
  assert.equal(back.platformAccessToken, 'access-123');
  assert.equal(back.platformRefreshToken, 'refresh-456');
  assert.equal(back.platformAccessExpiresAt, 1700000000000);
  assert.equal(back.googleRefreshToken, 'google-rt-789');
});

test('saveSession overwrites (no merge of stale keys)', () => {
  const f = tempFile('overwrite.json');
  saveSession(f, { platformAccessToken: 'first', googleRefreshToken: 'rt' });
  saveSession(f, { platformAccessToken: 'second' });
  const back = loadSession(f);
  assert.equal(back.platformAccessToken, 'second');
  assert.equal(back.googleRefreshToken, undefined, 'stale key dropped on overwrite');
});
