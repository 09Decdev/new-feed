import { readFileSync, existsSync } from 'node:fs';
import { atomicWriteSync } from './config-store';

export interface Session {
  platformAccessToken?: string;
  platformRefreshToken?: string;
  platformAccessExpiresAt?: number; // ms epoch
  googleRefreshToken?: string;
}

export function loadSession(file: string): Session {
  try {
    if (!existsSync(file)) return {};
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e: any) {
    console.error(`[news-poster] Failed to load session ${file}: ${e.message}`);
    return {};
  }
}

export function saveSession(file: string, session: Session): void {
  try {
    atomicWriteSync(file, JSON.stringify(session, null, 2));
  } catch (e: any) {
    console.error(`[news-poster] Failed to save session ${file}: ${e.message}`);
  }
}
