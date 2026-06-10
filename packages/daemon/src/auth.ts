import { randomBytes, timingSafeEqual } from 'node:crypto';

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
