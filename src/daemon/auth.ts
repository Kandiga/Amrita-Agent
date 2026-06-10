import { createHash, randomBytes } from 'node:crypto';
import { getDb } from '../core/store/db.ts';
import { loadConfig } from '../shared/config.ts';
import { audit } from '../core/store/audit.ts';
import { now } from '../shared/util.ts';

/**
 * Magic-link auth: `amrita login-link` prints a one-time URL; visiting it
 * exchanges the link token for a long-lived session cookie. No passwords,
 * no tokens pasted into the browser. Only hashes are stored.
 */

const LINK_TTL = 15 * 60 * 1000;
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function cleanup(): void {
  getDb().prepare(`DELETE FROM auth_tokens WHERE expires_at < ?`).run(now());
}

export function createMagicLink(): string {
  cleanup();
  const token = randomBytes(24).toString('base64url');
  getDb()
    .prepare(`INSERT INTO auth_tokens (token_hash, kind, created_at, expires_at) VALUES (?, 'magic-link', ?, ?)`)
    .run(hash(token), now(), now() + LINK_TTL);
  return token;
}

export function loginUrl(token: string): string {
  const config = loadConfig();
  const base = config.daemon.publicUrl ?? `http://${config.daemon.host}:${config.daemon.port}`;
  return `${base.replace(/\/$/, '')}/auth/${token}`;
}

export function printLoginLink(): void {
  const token = createMagicLink();
  console.log(`One-time login link (valid 15 minutes):\n\n  ${loginUrl(token)}\n`);
}

/** Exchange a magic-link token for a session token. Returns null if invalid. */
export function redeemMagicLink(token: string): string | null {
  cleanup();
  const db = getDb();
  const row = db
    .prepare(`SELECT token_hash FROM auth_tokens WHERE token_hash = ? AND kind = 'magic-link' AND expires_at > ?`)
    .get(hash(token), now());
  if (!row) return null;
  db.prepare(`DELETE FROM auth_tokens WHERE token_hash = ?`).run(hash(token));
  const session = randomBytes(32).toString('base64url');
  db.prepare(`INSERT INTO auth_tokens (token_hash, kind, created_at, expires_at) VALUES (?, 'session', ?, ?)`)
    .run(hash(session), now(), now() + SESSION_TTL);
  audit('auth', { event: 'magic-link-redeemed' });
  return session;
}

export function isValidSession(sessionToken: string | null): boolean {
  if (!sessionToken) return false;
  const row = getDb()
    .prepare(`SELECT token_hash FROM auth_tokens WHERE token_hash = ? AND kind = 'session' AND expires_at > ?`)
    .get(hash(sessionToken), now());
  return Boolean(row);
}

export function cookieFromHeader(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === 'amrita_session') return rest.join('=');
  }
  return null;
}
