/**
 * news-poster — bot đăng bài liên tục qua gateway, đăng nhập bằng Google.
 *
 * Modes:
 *   setup  – Google OAuth one-time consent → login-google → lưu session; in communityMemberId + quyền.
 *   run    – continuous loop via BotController (state machine + history).
 *   web    – embedded GUI server (server.ts); bot starts STOPPED, GUI drives start/stop.
 *   test   – one-shot test post (boot qua Google nếu chưa session).
 *   rss    – one-shot RSS post (boot qua Google nếu chưa session).
 *
 * CLI overrides: --mode=setup|run|test|rss, --content "<text>" (test), --rss <url>, --limit <n>, --dry-run.
 * Config via .env (loaded by dotenv-cli). See .env.example.
 */

import { fetchRssItems } from './rss';
import { exec } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { isAbsolute, resolve, dirname } from 'node:path';
import {
  getGoogleAuthUrl,
  waitForRedirectCode,
  exchangeCodeForTokens,
  newState,
} from './google-oauth';
import {
  buildDeviceInfo,
  loginWithGoogle,
  getAccessToken,
} from './auth.client';
import { loadSession, saveSession, Session } from './session';
import {
  listMyCommunities,
  getMyMemberPermission,
  getCommunityDetail,
  hasPostPermission,
} from './community.client';
import { sanitize } from './sanitize';
import {
  botController,
  ApiError,
  collectSecrets,
  runOneShotPosts,
  type OneShotPost,
} from './bot.controller';
import { startGuiServer } from './server';

interface Config {
  gatewayUrl: string;
  googleClientId: string;
  googleClientSecret: string;
  googleRedirectUri: string;
  googlePort: number;
  communityId: string;
  layoutType: string;
  rssUrl: string;
  rssLimit: number;
  intervalMs: number;
  dryRun: boolean;
  sessionFile: string;
  dedupFile: string;
  lockFile: string;
  device: ReturnType<typeof buildDeviceInfo>;
  rewriteWithAi: boolean;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[news-poster] Missing required env: ${name}`);
    process.exit(1);
  }
  return v;
}

function loadConfig(): Config {
  const port = parseInt(process.env.GOOGLE_OAUTH_PORT || '8787', 10);
  return {
    gatewayUrl: process.env.GATEWAY_URL || 'http://localhost:3005',
    googleClientId: requireEnv('GOOGLE_CLIENT_ID_WEB'),
    googleClientSecret: requireEnv('GOOGLE_CLIENT_SECRET_WEB'),
    googleRedirectUri:
      process.env.GOOGLE_OAUTH_REDIRECT_URI || `http://localhost:${port}/callback`,
    googlePort: port,
    communityId: process.env.COMMUNITY_ID || '',
    layoutType: process.env.LAYOUT_TYPE || 'CLASSIC',
    rssUrl: process.env.RSS_FEED_URL || 'https://vnexpress.net/rss/tin-moi-nhat.rss',
    rssLimit: parseInt(process.env.RSS_LIMIT_PER_CYCLE || '1', 10),
    intervalMs: parseInt(process.env.POST_INTERVAL_MS || '900000', 10),
    dryRun: (process.env.DRY_RUN || 'false').toLowerCase() === 'true',
    sessionFile: process.env.SESSION_FILE || '.session.json',
    dedupFile: process.env.DEDUP_FILE || 'posted.json',
    lockFile: process.env.LOOP_LOCK_FILE || 'loop.lock',
    device: buildDeviceInfo(process.env),
    rewriteWithAi: (process.env.REWRITE_WITH_AI ?? 'true').toLowerCase() === 'true',
    llmBaseUrl: process.env.LLM_BASE_URL || 'https://api.ai-box.vn',
    llmApiKey: process.env.LLM_API_KEY || '',
    llmModel: process.env.LLM_MODEL || 'deepseek-v4-flash[1m]',
  };
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (key.includes('=')) {
      const [k, ...rest] = key.split('=');
      out[k] = rest.join('=');
      continue;
    }
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = 'true';
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) {
      console.log(`[news-poster] Could not auto-open browser. Open manually:\n  ${url}`);
    }
  });
}

async function modeSetup(cfg: Config): Promise<void> {
  const state = newState();
  const url = getGoogleAuthUrl(cfg.googleClientId, cfg.googleRedirectUri, state);
  console.log('[news-poster] --- GOOGLE OAUTH SETUP ---');
  console.log(`1) Open this URL in your browser and authorize:\n\n  ${url}\n`);
  openBrowser(url);
  console.log(`2) Listening for redirect on ${cfg.googleRedirectUri} …`);
  const { code, state: st } = await waitForRedirectCode(cfg.googlePort, state);
  if (st !== state) throw new Error('OAuth state mismatch — aborting (possible CSRF).');

  const tokens = await exchangeCodeForTokens({
    code,
    clientId: cfg.googleClientId,
    clientSecret: cfg.googleClientSecret,
    redirectUri: cfg.googleRedirectUri,
  });
  if (!tokens.refresh_token) {
    throw new Error(
      'Google did not return a refresh_token. Re-run setup (consent may have been skipped).',
    );
  }
  console.log('[news-poster] Google tokens obtained. Exchanging id_token for platform session…');

  const session: Session = { googleRefreshToken: tokens.refresh_token };
  const platform = await loginWithGoogle(cfg.gatewayUrl, tokens.id_token, cfg.device);
  session.platformAccessToken = platform.accessToken;
  session.platformRefreshToken = platform.refreshToken;
  session.platformAccessExpiresAt = platform.accessExpiresAt;
  saveSession(cfg.sessionFile, session);
  console.log('[news-poster] Platform session saved.');

  try {
    const comm = await listMyCommunities(cfg.gatewayUrl, platform.accessToken);
    console.log(
      `[news-poster] Your communities (member): ${comm.length ? comm.join(', ') : '(none)'}`,
    );
    if (cfg.communityId) {
      const perm = await getMyMemberPermission(
        cfg.gatewayUrl,
        platform.accessToken,
        cfg.communityId,
      );
      console.log(
        `[news-poster] Permission in ${cfg.communityId}: role=${perm.role || 'none'} ` +
          `communityMemberId=${perm.id || 'N/A'} ` +
          `POST_CONTENT/OWNER=${hasPostPermission(perm)}`,
      );
      if (!hasPostPermission(perm)) {
        console.log(
          `[news-poster] ⚠ No POST_CONTENT in target community. Owner must grant it:\n` +
            `  POST /user-community/community-member-permission\n` +
            `  { communityMemberId: '${perm.id}', permissionName: ['POST_CONTENT'] }`,
        );
      }
    } else {
      console.log('[news-poster] Set COMMUNITY_ID to check permission for a specific community.');
    }
  } catch (e: any) {
    console.error(`[news-poster] (warn) could not fetch community info: ${e.message}`);
  }
  console.log('[news-poster] Setup complete. Run: npm start  (mode=run).');
}

async function modeRun(_cfg: Config): Promise<void> {
  const onSignal = () => {
    try {
      botController.stop();
    } catch {
      /* ignore second/unknown signal */
    }
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    await botController.start();
  } catch {
    // start() throws ApiError only on invalid state (never for a fresh CLI run).
  }
  if (botController.getStatus().state === 'ERROR') process.exit(1);
  await botController.waitForStopped();
  if (botController.getStatus().state === 'ERROR') process.exit(1);
}

/**
 * Web GUI mode (T5): the bot starts STOPPED — the GUI drives start/stop via
 * POST /api/start|stop. Binds the embedded server on GUI_HOST:GUI_PORT (config-store),
 * refuses to start (exit≠0) when GUI_HOST=0.0.0.0 without GUI_TOKEN.
 */
async function modeWeb(_cfg: Config): Promise<void> {
  let url: string;
  try {
    url = await startGuiServer();
  } catch (e: any) {
    const fatalSecrets = [
      process.env.LLM_API_KEY,
      process.env.GOOGLE_CLIENT_SECRET_WEB,
      process.env.GUI_TOKEN,
    ].filter(Boolean) as string[];
    console.error('[news-poster-gui] Không khởi động được GUI:', sanitize(e?.message ?? String(e), fatalSecrets));
    process.exit(1);
  }
  console.log(
    `[news-poster-gui] GUI: ${url} — bot đang STOPPED. Bấm Start trên GUI (hoặc mở thủ công).`,
  );
  openBrowser(url); // existing helper; on failure it logs the manual path
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  // Keep the process alive (the HTTP server pins the event loop); exit on signal.
  await new Promise<void>(() => {});
}

async function modeOneShot(
  cfg: Config,
  mode: 'test' | 'rss',
  args: Record<string, string>,
): Promise<void> {
  if (!cfg.communityId) {
    console.error('[news-poster] COMMUNITY_ID required');
    process.exit(1);
  }
  const session = loadSession(cfg.sessionFile);
  const accessToken = await getAccessToken(session, cfg.gatewayUrl, process.env, cfg.device);
  saveSession(cfg.sessionFile, session);

  type Post = {
    title: string;
    link: string;
    description: string;
    imageUrl?: string;
    content?: string;
  };
  let posts: Post[] = [];
  if (mode === 'test') {
    posts = [
      {
        title: 'test-post',
        link: '',
        description: '',
        content:
          args.content ||
          'Đây là bài viết demo từ news-poster (Google login) — kiểm tra luồng đăng bài qua gateway.',
      },
    ];
  } else {
    const feedUrl = args.rss || cfg.rssUrl;
    const limit = args.limit ? parseInt(args.limit, 10) : cfg.rssLimit;
    console.log(`[news-poster] Fetching RSS: ${feedUrl}`);
    const items = await fetchRssItems(feedUrl, limit);
    if (items.length === 0) {
      console.log('[news-poster] No RSS items found.');
      return;
    }
    posts = items.map((it) => ({
      title: it.title,
      link: it.link,
      description: it.description,
      imageUrl: it.imageUrl,
    }));
    console.log(`[news-poster] Found ${items.length} item(s).`);
  }

  const dryRun = cfg.dryRun || args['dry-run'] !== undefined;
  if (dryRun) console.log('[news-poster] --- DRY RUN (no posts created) ---');

  // MAJOR 6: one-shot mode runs under the same atomic loop lock as `run`, so it
  // can never race the running loop (or another CLI) on dedup/posted.json.
  // Minor (round-2): anchor the relative lock path to the .env directory — same rule
  // the run-loop lock uses — instead of process.cwd().
  const lockFile =
    isAbsolute(cfg.lockFile) ? cfg.lockFile : resolve(dirname(resolve('.env')), cfg.lockFile);
  const secrets = collectSecrets(
    {
      llmApiKey: cfg.llmApiKey,
      googleClientSecret: cfg.googleClientSecret,
      guiToken: process.env.GUI_TOKEN,
    },
    session,
  );

  let ok = 0;
  let failed = 0;
  try {
    if (dryRun) {
      // Dry-run is read-only (no posted.json writes) — no lock needed.
      await runOneShotPosts(posts, mode, cfg, session, accessToken, dryRun);
    } else {
      await botController.runWithLoopLock(lockFile, async () => {
        const r = await runOneShotPosts(posts, mode, cfg, session, accessToken, dryRun, secrets);
        ok = r.ok;
        failed = r.failed;
      });
    }
  } catch (e: any) {
    if (e instanceof ApiError && e.statusCode === 409) {
      console.error(`[news-poster] ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
  if (!dryRun) console.log(`[news-poster] Done. ok=${ok} failed=${failed}`);
}

async function modeCommunities(cfg: Config): Promise<void> {
  const session = loadSession(cfg.sessionFile);
  const token = await getAccessToken(session, cfg.gatewayUrl, process.env, cfg.device);
  saveSession(cfg.sessionFile, session);
  const ids = await listMyCommunities(cfg.gatewayUrl, token);
  console.log(`[news-poster] You are a member of ${ids.length} community(ies):`);
  for (const id of ids) {
    let name = '?';
    let role = '?';
    let canPost = false;
    try {
      const d = await getCommunityDetail(cfg.gatewayUrl, token, id);
      name = d.name ?? '?';
    } catch (e: any) {
      name = `(err: ${e.message})`;
    }
    try {
      const p = await getMyMemberPermission(cfg.gatewayUrl, token, id);
      role = p.role || 'MEMBER';
      canPost = hasPostPermission(p);
    } catch {
      /* not a member or permission fetch failed */
    }
    console.log(`  ${id}  |  ${name}  |  role=${role}  |  canPost=${canPost}`);
  }
}

function loadDotEnv(file = '.env'): void {
  try {
    if (!existsSync(file)) return;
    const content = readFileSync(file, 'utf8');
    for (const line of content.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2].trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    // ignore — env may be provided externally (e.g. dotenv-cli)
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const args = parseArgs(process.argv);
  const cfg = loadConfig();
  const mode = args.mode || 'run';
  switch (mode) {
    case 'setup':
      return modeSetup(cfg);
    case 'communities':
      return modeCommunities(cfg);
    case 'run':
      return modeRun(cfg);
    case 'web':
      return modeWeb(cfg);
    case 'test':
      return modeOneShot(cfg, 'test', args);
    case 'rss':
      return modeOneShot(cfg, 'rss', args);
    default:
      console.error(`[news-poster] Unknown mode: ${mode} (use setup|run|web|test|rss)`);
      process.exit(1);
  }
}

main().catch((e: any) => {
  // Minor (round-2): pass secrets to the sanitizer so a fatal message can't leak a key.
  const fatalSecrets = [process.env.LLM_API_KEY, process.env.GOOGLE_CLIENT_SECRET_WEB, process.env.GUI_TOKEN].filter(Boolean) as string[];
  console.error('[news-poster] Fatal:', sanitize(e?.message ?? String(e), fatalSecrets));
  process.exit(1);
});