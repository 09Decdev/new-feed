import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installConsoleCapture, readLogs, setLogSecrets } from '../../log';

before(() => {
  installConsoleCapture();
});

describe('log ring buffer', () => {
  test('seq is monotonic across pushes', () => {
    const before = readLogs().lastSeq;
    console.log('np-log-marker-seq-A');
    console.log('np-log-marker-seq-B');
    const after = readLogs().lastSeq;
    assert.equal(after, before + 2);
  });

  test('secrets are redacted before entering the buffer', () => {
    setLogSecrets(['np-secret-AAAA']);
    try {
      console.log('the token is np-secret-AAAA here');
      const line = readLogs().lines.at(-1)!;
      assert.ok(line.message.includes('[REDACTED]'), line.message);
      assert.ok(!line.message.includes('np-secret-AAAA'), line.message);
    } finally {
      setLogSecrets([]);
    }
  });

  test('filter "all" is treated as no filter', () => {
    const all = readLogs({ filter: 'all' });
    const none = readLogs();
    assert.equal(all.lines.length, none.lines.length);
  });

  test('filter matches message substring (case-insensitive) and level', () => {
    const tag = 'np-log-filtertag-' + readLogs().lastSeq;
    console.log(tag);
    console.error(tag); // level 'error' also contains tag
    const filtered = readLogs({ filter: tag });
    assert.ok(filtered.lines.length >= 2, 'both lines matched');
    assert.ok(filtered.lines.every((l) => l.message.includes(tag) || l.level.includes(tag)));
  });

  test('filter with no match returns empty', () => {
    const filtered = readLogs({ filter: 'np-log-zzz-no-such-line-999' });
    assert.equal(filtered.lines.length, 0);
  });

  test('readLogs since<firstSeq returns reset=true (backfill)', () => {
    const r = readLogs({ since: 0 });
    assert.equal(r.reset, true);
    assert.ok(r.lines.length > 0);
  });

  test('readLogs since>lastSeq returns reset=true (stale client)', () => {
    const future = readLogs().lastSeq + 99999;
    const r = readLogs({ since: future });
    assert.equal(r.reset, true);
  });

  test('readLogs since within window returns only newer lines, reset=false', () => {
    const snapshot = readLogs().lastSeq;
    console.log('np-log-after-snapshot-1');
    console.log('np-log-after-snapshot-2');
    const r = readLogs({ since: snapshot });
    assert.equal(r.reset, false);
    assert.equal(r.lines.length, 2);
    assert.ok(r.lines.every((l) => l.seq > snapshot));
  });

  test('a pathological line is truncated at ~2000 chars (no surrogate split)', () => {
    const longLine = 'a'.repeat(3000);
    console.log(longLine);
    const line = readLogs().lines.at(-1)!;
    assert.ok(line.message.length < 3000, 'must be truncated');
    assert.ok(line.message.includes('truncated'), line.message);
  });

  test('truncation does not split a surrogate pair at the boundary', () => {
    // 1999 'a' + a 2-code-unit emoji + 500 more → cut would land inside the emoji.
    const tricky = 'a'.repeat(1999) + '😀' + 'b'.repeat(500);
    console.log(tricky);
    const line = readLogs().lines.at(-1)!;
    assert.ok(line.message.includes('😀'), 'emoji kept intact (no lone surrogate)');
  });
});
