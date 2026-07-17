/**
 * Browser auth (ADR-0057): an HttpOnly cookie session born from a single-use
 * pairing code. The daemon bearer NEVER enters the browser — not via a URL
 * fragment, not via localStorage, not via JavaScript at all. This module is
 * therefore credential-free: it only asks the server "am I paired?" and
 * exchanges a typed code for a cookie the page can never read.
 */

/** The fetch surface used here — injectable for tests. */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    credentials?: 'same-origin';
  },
) => Promise<{ status: number }>;

function defaultFetch(): FetchLike | null {
  return typeof fetch !== 'undefined' ? (fetch as unknown as FetchLike) : null;
}

/** Is there a live session cookie? (GET /session → 204 yes, 401 no.) */
export async function checkSession(f: FetchLike | null = defaultFetch()): Promise<boolean> {
  if (!f) return false;
  try {
    const r = await f('/session', { credentials: 'same-origin' });
    return r.status === 204;
  } catch {
    return false;
  }
}

/** Exchange a typed pairing code for an HttpOnly session cookie. */
export async function pairWithCode(
  code: string,
  f: FetchLike | null = defaultFetch(),
): Promise<'paired' | 'rejected' | 'rate_limited' | 'error'> {
  if (!f || !code.trim()) return 'error';
  try {
    const r = await f('/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: code.trim() }),
      credentials: 'same-origin',
    });
    if (r.status === 204) return 'paired';
    if (r.status === 429) return 'rate_limited';
    return 'rejected';
  } catch {
    return 'error';
  }
}

/** Kill this browser's session (the server clears the cookie). */
export async function logoutSession(f: FetchLike | null = defaultFetch()): Promise<void> {
  if (!f) return;
  try {
    await f('/session/logout', { method: 'POST', credentials: 'same-origin' });
  } catch {
    /* logging out of a dead server is still logged out */
  }
}

/** The storage slice used ONLY to purge the legacy key — never to read auth. */
export interface TokenStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const LEGACY_STORAGE_KEY = 'amrita.auth-token';

function defaultStore(): TokenStore | null {
  return typeof localStorage !== 'undefined' ? localStorage : null;
}

/**
 * Pre-ADR-0057 builds persisted the daemon bearer in localStorage. Delete it on
 * every boot so no upgraded browser keeps a credential lying around. Returns
 * whether a legacy value was found (for the one-time "re-pair" hint).
 */
export function purgeLegacyToken(store: TokenStore | null = defaultStore()): boolean {
  if (!store) return false;
  const had = (store.getItem(LEGACY_STORAGE_KEY) ?? '').length > 0;
  store.removeItem(LEGACY_STORAGE_KEY);
  return had;
}

/**
 * Legacy `#token=` fragments are REJECTED by design — a credential must never
 * ride a URL (history, bookmarks, shared links). Kept as an executable
 * statement of the boundary; always returns undefined.
 */
export function readTokenFromHash(_hash: string): undefined {
  return undefined;
}
