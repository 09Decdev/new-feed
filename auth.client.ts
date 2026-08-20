import { refreshGoogleIdToken } from './google-oauth';
import type { Session } from './session';
import { sanitize } from './sanitize';

export interface PlatformTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number; // ms epoch
}

export interface DeviceInfo {
  installationId: string;
  deviceFingerprint: string;
  platform: string;
  deviceName?: string;
}

const DEFAULT_INSTALLATION_ID = '11111111-1111-4111-8111-111111111111';
const DEFAULT_FINGERPRINT = 'a'.repeat(64);
const FIVE_MIN = 5 * 60 * 1000;

export function buildDeviceInfo(env: NodeJS.ProcessEnv): DeviceInfo {
  return {
    installationId: (env.DEVICE_INSTALLATION_ID as string) || DEFAULT_INSTALLATION_ID,
    deviceFingerprint: (env.DEVICE_FINGERPRINT as string) || DEFAULT_FINGERPRINT,
    platform: 'web',
    deviceName: 'news-poster-bot',
  };
}

function decodeJwtExp(jwt: string): number | null {
  try {
    const part = jwt.split('.')[1];
    if (!part) return null;
    const padded = part + '='.repeat((4 - (part.length % 4)) % 4);
    const json = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    return typeof json?.exp === 'number' ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

function parseJson(text: string): any {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

/** POST /auth/login-google — exchange a Google id_token for platform tokens. */
export async function loginWithGoogle(
  gatewayUrl: string,
  idToken: string,
  deviceInfo: DeviceInfo,
): Promise<PlatformTokens> {
  const url = `${gatewayUrl.replace(/\/$/, '')}/auth/login-google`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken, deviceInfo }),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  const body = parseJson(text);
  if (!res.ok) {
    throw new Error(
      `login-google failed: HTTP ${res.status} — ${sanitize(typeof body === 'string' ? body : JSON.stringify(body))}`,
    );
  }
  // gateway auth responses are raw objects (not wrapped in {success,data})
  const data = body?.data ?? body;
  if (data?.require2fa) {
    throw new Error(
      'Account has 2FA enabled — login-google requires a 2FA step (not supported). Disable 2FA on the account.',
    );
  }
  if (data?.register) {
    throw new Error(
      'Google account not registered on platform (login-google returned register=true). Register once via the app or register-social.',
    );
  }
  if (!data?.accessToken || !data?.refreshToken) {
    throw new Error(`login-google: unexpected response — ${sanitize(JSON.stringify(body))}`);
  }
  const accessExpiresAt =
    decodeJwtExp(data.accessToken) ?? Date.now() + 55 * 60 * 1000;
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    accessExpiresAt,
  };
}

/** POST /auth/refresh-token — rotate the platform token pair. */
export async function refreshPlatformToken(
  gatewayUrl: string,
  refreshToken: string,
): Promise<PlatformTokens> {
  const url = `${gatewayUrl.replace(/\/$/, '')}/auth/refresh-token`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  const body = parseJson(text);
  if (!res.ok || !body?.accessToken) {
    throw new Error(
      `refresh-token failed: HTTP ${res.status} — ${typeof body === 'string' ? body : JSON.stringify(body)}`,
    );
  }
  const data = body.data ?? body;
  const accessExpiresAt =
    decodeJwtExp(data.accessToken) ?? Date.now() + 55 * 60 * 1000;
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    accessExpiresAt,
  };
}

/** Returns a valid platform access token, refreshing if <5min left. Mutates session. */
export async function ensurePlatformToken(
  session: Session,
  gatewayUrl: string,
): Promise<PlatformTokens> {
  const now = Date.now();
  if (
    session.platformAccessToken &&
    session.platformAccessExpiresAt &&
    session.platformAccessExpiresAt - now > FIVE_MIN
  ) {
    return {
      accessToken: session.platformAccessToken,
      refreshToken: session.platformRefreshToken!,
      accessExpiresAt: session.platformAccessExpiresAt,
    };
  }
  if (!session.platformRefreshToken) {
    throw new Error('No platform refresh token — re-bootstrap via Google (run setup).');
  }
  const refreshed = await refreshPlatformToken(gatewayUrl, session.platformRefreshToken);
  session.platformAccessToken = refreshed.accessToken;
  session.platformRefreshToken = refreshed.refreshToken;
  session.platformAccessExpiresAt = refreshed.accessExpiresAt;
  return refreshed;
}

/** Cold-start: mint a fresh Google id_token from the stored googleRefreshToken, then login-google. */
export async function bootstrapViaGoogle(
  session: Session,
  gatewayUrl: string,
  env: NodeJS.ProcessEnv,
  deviceInfo: DeviceInfo,
): Promise<PlatformTokens> {
  if (!session.googleRefreshToken) {
    throw new Error('No googleRefreshToken in session — run --mode=setup first.');
  }
  const { idToken } = await refreshGoogleIdToken({
    refreshToken: session.googleRefreshToken,
    clientId: env.GOOGLE_CLIENT_ID_WEB as string,
    clientSecret: env.GOOGLE_CLIENT_SECRET_WEB as string,
  });
  const tokens = await loginWithGoogle(gatewayUrl, idToken, deviceInfo);
  session.platformAccessToken = tokens.accessToken;
  session.platformRefreshToken = tokens.refreshToken;
  session.platformAccessExpiresAt = tokens.accessExpiresAt;
  return tokens;
}

/** Acquire a usable access token: bootstrap if no session, else refresh; falls back to Google bootstrap on refresh failure. */
export async function getAccessToken(
  session: Session,
  gatewayUrl: string,
  env: NodeJS.ProcessEnv,
  deviceInfo: DeviceInfo,
): Promise<string> {
  if (!session.platformAccessToken || !session.platformRefreshToken) {
    await bootstrapViaGoogle(session, gatewayUrl, env, deviceInfo);
    return session.platformAccessToken!;
  }
  try {
    const t = await ensurePlatformToken(session, gatewayUrl);
    return t.accessToken;
  } catch (e: any) {
    console.log(`[news-poster] Platform refresh failed (${e.message}); re-bootstrapping via Google…`);
    await bootstrapViaGoogle(session, gatewayUrl, env, deviceInfo);
    return session.platformAccessToken!;
  }
}
