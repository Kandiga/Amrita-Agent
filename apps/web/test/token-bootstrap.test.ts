import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { purgeLegacyToken, readTokenFromHash } from '../src/auth.ts';

/**
 * ADR-0057 boundary: legacy browser credential channels are DEAD. A bearer must
 * never arrive via URL fragment nor persist in localStorage — auth is a typed
 * pairing code exchanged server-side for an HttpOnly cookie.
 */

function memStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    size: () => m.size,
  };
}

describe('legacy credential channels are rejected', () => {
  it('a #token= fragment is never adopted', () => {
    expect(readTokenFromHash('#token=abc123')).toBeUndefined();
    expect(readTokenFromHash('#foo=1&token=a%2Bb')).toBeUndefined();
    expect(readTokenFromHash('')).toBeUndefined();
  });

  it('a legacy localStorage bearer is actively purged on boot', () => {
    const store = memStore();
    store.setItem('amrita.auth-token', 'old-bearer');
    expect(purgeLegacyToken(store)).toBe(true); // found → the UI can hint "re-pair"
    expect(store.getItem('amrita.auth-token')).toBeNull();
    expect(purgeLegacyToken(store)).toBe(false); // second boot: nothing left
  });

  it('no web source stores, saves, or URL-embeds a bearer anymore', async () => {
    // Source-level fitness: the credential-handling surface must stay dead.
    const auth = await readFile(new URL('../src/auth.ts', import.meta.url), 'utf8');
    expect(auth).not.toContain('setItem(LEGACY_STORAGE_KEY');
    const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
    for (const banned of ['bootstrapTokenFromLocation', 'saveToken', 'loadToken(', '#token=']) {
      expect(app, `App.tsx must not use ${banned}`).not.toContain(banned);
    }
  });
});
