import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';

const SCOPE = 'openid email profile';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface GoogleTokens {
  access_token: string;
  id_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
}

export function newState(): string {
  return randomBytes(16).toString('hex');
}

export function getGoogleAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

/** Start a local HTTP server, wait for Google to redirect with ?code=…&state=…, then resolve. */
export function waitForRedirectCode(
  port: number,
  expectedState: string,
  timeoutMs = 300000,
): Promise<{ code: string; state: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error(`Google OAuth redirect timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const server: Server = createServer((req, res) => {
      const url = new URL(req.url || '/', `http://localhost:${port}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state') || '';
      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          '<h1>Google OAuth thành công</h1><p>Bạn có thể đóng tab này và quay lại terminal.</p>',
        );
        clearTimeout(timer);
        server.close();
        resolve({ code, state });
      } else {
        const err = url.searchParams.get('error') || 'no_code';
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h1>OAuth lỗi</h1><p>${err}</p>`);
        clearTimeout(timer);
        server.close();
        reject(new Error(`Google OAuth returned error: ${err}`));
      }
    });

    server.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });

    // Bind all interfaces so the redirect is caught whether localhost resolves to IPv4 or IPv6.
    server.listen(port);
  });
}

export async function exchangeCodeForTokens(args: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<GoogleTokens> {
  const body = new URLSearchParams({
    code: args.code,
    client_id: args.clientId,
    client_secret: args.clientSecret,
    redirect_uri: args.redirectUri,
    grant_type: 'authorization_code',
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    throw new Error(`Google token exchange failed: HTTP ${res.status} — ${text}`);
  }
  if (!json?.id_token) {
    throw new Error(`Google token exchange: no id_token — ${text}`);
  }
  return json as GoogleTokens;
}

export async function refreshGoogleIdToken(args: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<{ idToken: string; expiresIn: number }> {
  const body = new URLSearchParams({
    refresh_token: args.refreshToken,
    client_id: args.clientId,
    client_secret: args.clientSecret,
    grant_type: 'refresh_token',
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    throw new Error(`Google refresh failed: HTTP ${res.status} — ${text}`);
  }
  if (!json?.id_token) {
    throw new Error(`Google refresh: no id_token — ${text}`);
  }
  return { idToken: json.id_token, expiresIn: json.expires_in ?? 3600 };
}
