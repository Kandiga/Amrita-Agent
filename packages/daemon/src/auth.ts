import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * Local control-surface auth for the HTTP/WS server. A single bearer token
 * gates the mutating/sensitive routes (`POST /rpc`, `GET /events`, `WS
 * /events/ws`); `GET /health` stays public. The token is **local session
 * config**, never a provider secret — it is read from `AMRITA_AUTH_TOKEN` or
 * generated ephemerally at startup, printed once, and never persisted to disk
 * or written into events/DB/logs.
 *
 * Browsers cannot set request headers on a `WebSocket` handshake, so the WS
 * route also accepts the token as a `?token=` query parameter (see
 * docs/specs/runtime.md → "Auth guard").
 */

/** Generate an ephemeral, URL-safe dev token (192 bits). */
export function generateDevToken(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Constant-time token comparison. Returns `true` when `expected` is empty
 * (auth disabled). Never throws — a length mismatch yields `false` after a
 * dummy compare so the path stays timing-flat.
 */
export function tokensMatch(expected: string, provided: string | null | undefined): boolean {
  if (!expected) return true; // auth disabled
  if (!provided) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) {
    timingSafeEqual(a, a); // keep the comparison cost shape; result is still false
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Extract a bearer token from an `Authorization` header value, if present. */
export function bearerFromHeader(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

/**
 * The token a request presents: an `Authorization: Bearer …` header first, then
 * a `?token=` query parameter (the browser-WebSocket fallback).
 */
export function requestToken(
  headerValue: string | undefined,
  queryToken: string | null | undefined,
): string | undefined {
  return bearerFromHeader(headerValue) ?? queryToken ?? undefined;
}

// ── ADR-0057: browser pairing + HttpOnly cookie sessions ────────────────────
//
// The daemon bearer never reaches a browser. Instead the CLI mints a pairing
// code (CSPRNG, single-use, short TTL) the user types into the UI; consuming
// it births an in-memory session delivered as an HttpOnly SameSite cookie.
// Nothing here is persisted — a restart just means one re-pair (ADR-0024).

/** Human-typeable alphabet: no 0/O, 1/I/L ambiguity. */
const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
export const PAIRING_TTL_MS = 120_000;
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = 'amrita_session';

/** Canonical form for lookup: uppercase, alphanumerics only ("ab2-c" → "AB2C"). */
function normalizePairingCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Single-use, expiring pairing codes (ADR-0057). ~39 bits from a CSPRNG — with
 * a 120s TTL, one-shot consumption, and the HTTP rate limit, brute force is not
 * a realistic path. Display form is XXXX-XXXX; consume() accepts sloppy input.
 */
export class PairingRegistry {
  private readonly codes = new Map<string, number>();
  // No TS parameter properties here: amritad runs .ts under node's type-strip,
  // which only erases types — parameter properties are real codegen.
  private readonly ttlMs: number;
  constructor(ttlMs: number = PAIRING_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  mint(now: number): { code: string; expiresAt: number } {
    let raw = '';
    for (let i = 0; i < 8; i++) raw += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)];
    const expiresAt = now + this.ttlMs;
    this.codes.set(raw, expiresAt);
    return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt };
  }

  /** Atomic single-use: a hit is deleted before returning true. */
  consume(input: string, now: number): boolean {
    this.prune(now);
    const key = normalizePairingCode(input);
    const expiresAt = this.codes.get(key);
    if (expiresAt === undefined) return false;
    this.codes.delete(key);
    return expiresAt > now;
  }

  pendingCount(now: number): number {
    this.prune(now);
    return this.codes.size;
  }

  private prune(now: number): void {
    for (const [code, expiresAt] of this.codes) if (expiresAt <= now) this.codes.delete(code);
  }
}

/**
 * In-memory browser sessions (ADR-0057): 192-bit CSPRNG ids, sliding expiry.
 * Deliberately not persisted — no secret-shaped rows ever enter the store.
 */
export class SessionRegistry {
  private readonly lastSeen = new Map<string, number>();
  private readonly ttlMs: number;
  constructor(ttlMs: number = SESSION_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  create(now: number): string {
    const id = randomBytes(24).toString('base64url');
    this.lastSeen.set(id, now);
    return id;
  }

  /** Valid → touch (sliding) and return true; expired/unknown → false. */
  validate(id: string | undefined, now: number): boolean {
    if (!id) return false;
    const seen = this.lastSeen.get(id);
    if (seen === undefined) return false;
    if (now - seen > this.ttlMs) {
      this.lastSeen.delete(id);
      return false;
    }
    this.lastSeen.set(id, now);
    return true;
  }

  revoke(id: string | undefined): void {
    if (id) this.lastSeen.delete(id);
  }

  count(now: number): number {
    for (const [id, seen] of this.lastSeen) if (now - seen > this.ttlMs) this.lastSeen.delete(id);
    return this.lastSeen.size;
  }
}

/**
 * ADR-0057 finding 2 (secure-cookie contract). Behind TLS the session cookie
 * MUST carry `Secure`, and we upgrade to the `__Host-` prefix — a browser only
 * accepts a `__Host-` cookie that is Secure, Path=/, and has no Domain (all
 * satisfied here), which pins it to this exact host and blocks a
 * subdomain/path-scoped cookie-fixation attack.
 *
 * The mode is SERVER/SUPERVISOR-owned via `AMRITA_WEB_TLS`, NEVER derived from a
 * client-controlled `X-Forwarded-Proto`: a stranger must not be able to flip the
 * cookie's security by forging a header. Fail-closed default is local HTTP
 * (no Secure) so a plain `amrita open` on http://localhost keeps working; a TLS
 * deployment declares `AMRITA_WEB_TLS=1`.
 */
export const SESSION_COOKIE_SECURE = `__Host-${SESSION_COOKIE}`;

export interface CookieMode {
  readonly secure: boolean;
}

/** Resolve the cookie security mode from server env only (never a request header). */
export function resolveCookieMode(env: NodeJS.ProcessEnv = process.env): CookieMode {
  const v = (env.AMRITA_WEB_TLS ?? '').trim().toLowerCase();
  return { secure: v === '1' || v === 'true' || v === 'yes' || v === 'on' };
}

/** The cookie name for the active mode (`__Host-` prefix under TLS). */
export function sessionCookieName(mode: CookieMode): string {
  return mode.secure ? SESSION_COOKIE_SECURE : SESSION_COOKIE;
}

/** Set-Cookie value for a freshly paired session. HttpOnly: JS can never read it. */
export function sessionSetCookie(
  id: string,
  mode: CookieMode,
  maxAgeMs: number = SESSION_TTL_MS,
): string {
  const maxAge = Math.max(1, Math.floor(maxAgeMs / 1000));
  const base = `${sessionCookieName(mode)}=${id}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Strict`;
  return mode.secure ? `${base}; Secure` : base;
}

/** Set-Cookie value that clears the session cookie (logout). */
export function clearSessionCookie(mode: CookieMode): string {
  const base = `${sessionCookieName(mode)}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict`;
  return mode.secure ? `${base}; Secure` : base;
}

/**
 * Extract the session id from a request's Cookie header, if present. Reads BOTH
 * the plain and the `__Host-` name — only one mode is active per server, so at
 * most one is ever set by us; accepting either keeps the reader mode-agnostic.
 */
export function sessionFromCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === SESSION_COOKIE || name === SESSION_COOKIE_SECURE) {
      const value = part.slice(eq + 1).trim();
      if (value.length > 0) return value;
    }
  }
  return undefined;
}

export interface ResolvedAuth {
  token: string;
  source: 'env' | 'generated';
}

/**
 * Resolve the effective auth token for a daemon run: `AMRITA_AUTH_TOKEN` if set,
 * otherwise a freshly generated ephemeral token. The caller prints a generated
 * token once (never an env-provided one).
 */
export function resolveAuthToken(
  env: string | undefined,
  generate: () => string = generateDevToken,
): ResolvedAuth {
  const fromEnv = env?.trim();
  if (fromEnv) return { token: fromEnv, source: 'env' };
  return { token: generate(), source: 'generated' };
}
