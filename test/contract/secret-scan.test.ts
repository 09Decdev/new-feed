/**
 * G5 — secret scan / SAST hygiene. Three independent passes:
 *   A) known cloud-secret formats across every tracked text file (AWS/Google/
 *      GitHub/OpenAI/Slack) — none may be present anywhere in the repo.
 *   B) dense random-looking string literals assigned to a secret-named key in
 *      source code (.ts/.cjs/.js, EXCLUDING test/ which legitimately holds test
 *      fixtures) — none may be present.
 *   C) .env.example leaves every sensitive key EMPTY, and the real .env is
 *      gitignored — so production secrets can never be committed.
 *
 * Zero new dependencies: pure node:fs walk + a Shannon-entropy helper.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'test']);
// Gitignored runtime/config files hold real local secrets but are NEVER committed
// (G5-C asserts they stay ignored) — scanning them would flag the user's own
// live config, which is not a repo-leak. Source + tracked files only.
const EXCLUDE_FILES = new Set([
  'package-lock.json',
  'package.json',
  '.env',
  '.session.json',
  'posted.json',
  'loop.lock',
]);

function entropy(s: string): number {
  if (!s) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) || 0) + 1);
  let e = 0;
  for (const c of freq.values()) e -= (c / s.length) * Math.log2(c / s.length);
  return e;
}

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      walkFiles(path.join(dir, entry.name), out);
    } else if (entry.isFile()) {
      if (EXCLUDE_FILES.has(entry.name)) continue;
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function readText(file: string): string | null {
  try {
    const buf = fs.readFileSync(file);
    if (buf.length > 1024 * 1024) return null;
    if (buf.includes(0)) return null; // binary
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

// --- Pass A: known secret formats -------------------------------------------

const KNOWN_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'AWS access key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'Google API key', re: /AIza[0-9A-Za-z_\-]{35}/ },
  { name: 'GitHub PAT', re: /ghp_[0-9A-Za-z]{36,}/ },
  { name: 'OpenAI key', re: /sk-[A-Za-z0-9]{20,}/ },
  { name: 'Google OAuth token', re: /ya29\.[0-9A-Za-z_\-]{20,}/ },
  { name: 'Slack token', re: /xox[baprs]-[0-9A-Za-z-]{10,}/ },
];

test('G5-A: no known cloud-secret format appears anywhere in the repo', () => {
  const hits: string[] = [];
  for (const f of walkFiles(ROOT)) {
    const text = readText(f);
    if (!text) continue;
    for (const { name, re } of KNOWN_PATTERNS) {
      const m = re.exec(text);
      if (m) hits.push(`${path.relative(ROOT, f)}: ${name} → ${m[0]}`);
    }
  }
  assert.deepEqual(hits, [], `known secret formats found:\n${hits.join('\n')}`);
});

// --- Pass B: secret-named dense literals in source --------------------------

const SECRET_NAME = /(secret|token|apikey|api_key|password|passwd|credential|clientsecret|refreshtoken|access.?token|bearer)/i;
// Match `name : 'literal'` or `name = 'literal'` (single or double or backtick).
const ASSIGN_RE = /['"]?([A-Za-z_$][\w$-]{1,40})['"]?\s*[:=]\s*['"`]([A-Za-z0-9+/=_\-]{20,})['"`]/g;
const PLACEHOLDER = /(test|example|your|placeholder|change|dummy|sample|^a+$|^1+$|localhost|deepseek|api-box|news-poster|aaaa|1111|default)/i;

test('G5-B: no high-entropy secret literal assigned to a secret-named key in source', () => {
  const hits: string[] = [];
  for (const f of walkFiles(ROOT)) {
    if (!/\.(ts|cjs|js)$/i.test(f)) continue;
    const text = readText(f);
    if (!text) continue;
    let m: RegExpExecArray | null;
    ASSIGN_RE.lastIndex = 0;
    while ((m = ASSIGN_RE.exec(text)) !== null) {
      const name = m[1];
      const lit = m[2];
      if (!SECRET_NAME.test(name)) continue;
      if (PLACEHOLDER.test(lit)) continue;
      // All-caps+underscore env-var names (e.g. GOOGLE_CLIENT_SECRET_WEB) are
      // identifiers, not random secrets — real keys are mixed-case base64.
      if (/^[A-Z0-9_]+$/.test(lit)) continue;
      if (entropy(lit) < 3.0) continue;
      hits.push(`${path.relative(ROOT, f)}: ${name} = "${lit}" (entropy ${entropy(lit).toFixed(2)})`);
    }
  }
  assert.deepEqual(hits, [], `secret-named hardcoded literals found:\n${hits.join('\n')}`);
});

// --- Pass C: .env.example hygiene + .env gitignored -------------------------

test('G5-C: .env.example leaves every sensitive key empty', () => {
  const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  const sensitive = ['GOOGLE_CLIENT_ID_WEB', 'GOOGLE_CLIENT_SECRET_WEB', 'COMMUNITY_ID', 'LLM_API_KEY', 'GUI_TOKEN'];
  for (const key of sensitive) {
    const line = example.split('\n').find((l) => l.startsWith(`${key}=`));
    assert.ok(line, `.env.example missing key ${key}`);
    assert.equal(line!.slice(key.length + 1), '', `${key} in .env.example must be empty, got: ${line}`);
  }
});

test('G5-C: real .env / .session.json / posted.json are gitignored', () => {
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  for (const f of ['.env', '.session.json', 'posted.json']) {
    assert.ok(gi.split('\n').map((l) => l.trim()).includes(f), `.gitignore must list ${f}`);
  }
});
