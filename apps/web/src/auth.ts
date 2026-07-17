/**
 * Local control-surface token handling for the web UI. The token gates the
 * daemon's HTTP/WS surface (it is *not* a provider secret). It lives only in
 * memory and `localStorage`, is never logged, and is never rendered in full —
 * the UI shows a masked placeholder only.
 */

const STORAGE_KEY = 'amrita.auth-token';

/** The slice of the Web Storage API used here — injectable for tests. */
export interface TokenStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStore(): TokenStore | null {
  return typeof localStorage !== 'undefined' ? localStorage : null;
}

export function loadToken(store: TokenStore | null = defaultStore()): string | undefined {
  const raw = store?.getItem(STORAGE_KEY);
  return raw && raw.length > 0 ? raw : undefined;
}

export function saveToken(token: string, store: TokenStore | null = defaultStore()): void {
  if (token) store?.setItem(STORAGE_KEY, token);
  else clearToken(store);
}

export function clearToken(store: TokenStore | null = defaultStore()): void {
  store?.removeItem(STORAGE_KEY);
}

/**
 * A presence-only mask: a fixed run of bullets that reveals no token characters
 * and no exact length. Use for any on-screen indication that a token is set.
 */
export function maskToken(token: string): string {
  return token ? '•'.repeat(8) : '';
}

/**
 * Community onboarding (finding 4): `amrita open` hands the bearer to the browser
 * via a ONE-TIME `#token=<t>` fragment so the user never hand-copies it. Read it,
 * persist it, and return it; the caller strips the hash so the token never lingers
 * in the address bar, history, or a shared/bookmarked URL. Pure + injectable.
 */
export function readTokenFromHash(hash: string): string | undefined {
  const m = /(?:^#|&)token=([^&]+)/.exec(hash);
  if (!m?.[1]) return undefined;
  try {
    const t = decodeURIComponent(m[1]).trim();
    return t.length > 0 ? t : undefined;
  } catch {
    return undefined;
  }
}

/** Adopt a `#token=` bootstrap from the live location, then clear the hash. */
export function bootstrapTokenFromLocation(
  loc: { hash: string; replaceHash: (h: string) => void } | null,
  store: TokenStore | null = defaultStore(),
): string | undefined {
  if (!loc) return undefined;
  const token = readTokenFromHash(loc.hash);
  if (!token) return undefined;
  saveToken(token, store);
  loc.replaceHash(''); // never leave the token in the URL
  return token;
}
