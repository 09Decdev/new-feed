import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitize, stripUrlQuery } from '../../sanitize';

test('sanitize redacts Bearer tokens', () => {
  const out = sanitize('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ==');
  assert.ok(out.includes('[REDACTED]'), out);
  assert.ok(!out.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ=='), out);
});

test('sanitize redacts x-api-key header forms', () => {
  const a = sanitize('x-api-key: sk-live-1234567890');
  assert.ok(a.includes('[REDACTED]'), a);
  assert.ok(!a.includes('sk-live-1234567890'), a);
  const b = sanitize('x-api-key=abcdef123456');
  assert.ok(b.includes('[REDACTED]'), b);
});

test('sanitize redacts client_secret', () => {
  const out = sanitize('client_secret=supersecretvalue');
  assert.ok(out.includes('[REDACTED]'), out);
  assert.ok(!out.includes('supersecretvalue'), out);
});

test('sanitize redacts literal secrets >= 4 chars', () => {
  const out = sanitize('the key is topsecretval yes', ['topsecretval']);
  assert.ok(out.includes('[REDACTED]'), out);
  assert.ok(!out.includes('topsecretval'), out);
});

test('sanitize ignores secrets shorter than 4 chars', () => {
  // 'abc' is 3 chars → not redacted (would match too many substrings)
  assert.equal(sanitize('abc abc', ['abc']), 'abc abc');
});

test('sanitize coerces non-string message (nullish → empty)', () => {
  // `message ?? ''` coalesces null/undefined to '' before String()
  assert.equal(sanitize(null), '');
  assert.equal(sanitize(undefined), '');
  assert.equal(sanitize(42), '42');
  assert.equal(sanitize(0), '0');
});

test('stripUrlQuery keeps path, drops query and fragment', () => {
  assert.equal(
    stripUrlQuery('https://example.com/a/b?token=secret#frag'),
    'https://example.com/a/b',
  );
  assert.equal(stripUrlQuery('https://example.com'), 'https://example.com/');
});

test('stripUrlQuery returns sentinel for invalid url', () => {
  assert.equal(stripUrlQuery('not a url at all'), '<invalid-url>');
});
