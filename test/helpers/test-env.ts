/**
 * Wave 5 test helpers — temp .env / files, global.fetch stub, live-server HTTP helper.
 * Every test writes ONLY inside its own mkdtemp dir; never touches the repo `.env`.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import * as http from 'node:http';

export interface TestEnv {
  dir: string;
  envPath: string;
  dedupFile: string;
  sessionFile: string;
  lockFile: string;
  port: number;
  url: string;
  cleanup(): void;
}

/** Free an ephemeral port by binding :0, note it, close. */
export async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const p = (srv.address() as net.AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return p;
}

/** Create a temp dir with a complete `.env`; GUI_PORT defaults to 0 unless `port` given. */
export function makeTempEnv(
  overrides: Record<string, string> = {},
  opts?: { port?: number },
): TestEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'news-poster-w5-'));
  const port = opts?.port ?? 0;
  const envPath = path.join(dir, '.env');
  const dedupFile = path.join(dir, 'posted.json');
  const sessionFile = path.join(dir, '.session.json');
  const lockFile = path.join(dir, 'loop.lock');
  const lines: string[] = [
    `GATEWAY_URL=http://127.0.0.1:9`,
    `GOOGLE_CLIENT_ID_WEB=test-client-id`,
    `GOOGLE_CLIENT_SECRET_WEB=w5-test-secret-value`,
    `GOOGLE_OAUTH_REDIRECT_URI=http://localhost:8790/callback`,
    `GOOGLE_OAUTH_PORT=8790`,
    `COMMUNITY_ID=comm-test-123`,
    `LAYOUT_TYPE=CLASSIC`,
    `RSS_FEED_URL=https://example.com/feed.rss`,
    `RSS_LIMIT_PER_CYCLE=1`,
    `POST_INTERVAL_MS=60000`,
    `DRY_RUN=false`,
    `SESSION_FILE=${sessionFile}`,
    `DEDUP_FILE=${dedupFile}`,
    `LOOP_LOCK_FILE=${lockFile}`,
    `REWRITE_WITH_AI=false`,
    `LLM_BASE_URL=https://api.ai-box.vn`,
    `LLM_MODEL=test-model`,
    `LLM_API_KEY=llm-test-key-value`,
    `GUI_HOST=127.0.0.1`,
    `GUI_PORT=${port}`,
    `GUI_TOKEN=`,
  ];
  for (const [k, v] of Object.entries(overrides)) {
    const i = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (i >= 0) lines[i] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
  }
  fs.writeFileSync(envPath, lines.join('\n') + '\n', 'utf8');
  return {
    dir,
    envPath,
    dedupFile,
    sessionFile,
    lockFile,
    port,
    url: `http://127.0.0.1:${port}`,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * Install process.env overrides that config-store merges OVER the temp/.env file
 * (KNOWN_KEYS wins). Needed so the singleton BotController's config also points at
 * temp files. Returns a restorer. Must run BEFORE dynamic-importing server/bot.controller.
 */
export function applyProcessOverrides(
  env: TestEnv,
  extra: Record<string, string> = {},
): () => void {
  const prev: Record<string, string | undefined> = {};
  const setMap: Record<string, string> = {
    GUI_HOST: '127.0.0.1',
    GUI_PORT: String(env.port),
    GUI_TOKEN: 'test-tok123',
    LOOP_LOCK_FILE: env.lockFile,
    DEDUP_FILE: env.dedupFile,
    SESSION_FILE: env.sessionFile,
    REWRITE_WITH_AI: 'false',
    ...extra,
  };
  for (const [k, v] of Object.entries(setMap)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

/** Stub global.fetch with a handler; returns a restorer. Handler returns a real `Response`. */
export function stubGlobalFetch(
  fn: (url: string, init?: any) => Promise<Response>,
): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = fn as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

export const jsonResponse = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

export interface LiveResponse {
  status: number;
  headers: Headers;
  text: string;
  json: any;
}

/** Plain fetch wrapper against a live GUI server. */
export async function live(base: string, path: string, init?: any): Promise<LiveResponse> {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * Raw node:http request — needed because undici `fetch` forbids setting
 * `Sec-Fetch-Site`, `Host`, and `Origin`, which the contract tests must control
 * to assert the cross-site (403) and invalid-Host (403) gates.
 */
export function rawHttp(
  port: number,
  pathname: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: opts.method || 'GET',
        headers: opts.headers || {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}