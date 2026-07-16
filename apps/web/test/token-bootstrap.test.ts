import { describe, expect, it } from 'vitest';
import { bootstrapTokenFromLocation, loadToken, readTokenFromHash } from '../src/auth.ts';

/** Community onboarding (finding 4): `amrita open` hands the token via #token=,
 *  so the user never hand-copies it — and it never lingers in the URL. */

function memStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

describe('token bootstrap from #token=', () => {
  it('reads a token from the hash, URL-decoded', () => {
    expect(readTokenFromHash('#token=abc123')).toBe('abc123');
    expect(readTokenFromHash('#foo=1&token=a%2Bb')).toBe('a+b');
    expect(readTokenFromHash('#')).toBeUndefined();
    expect(readTokenFromHash('#token=')).toBeUndefined();
    expect(readTokenFromHash('')).toBeUndefined();
  });

  it('adopts the token, persists it, and CLEARS the hash (never lingers in the URL)', () => {
    const store = memStore();
    let hash = '#token=secret-bearer';
    const setHash = (h: string): void => {
      hash = h;
    };
    const adopted = bootstrapTokenFromLocation({ hash, replaceHash: setHash }, store);
    expect(adopted).toBe('secret-bearer');
    expect(loadToken(store)).toBe('secret-bearer'); // persisted
    expect(hash).toBe(''); // hash cleared — no token in history/bookmark
  });

  it('no #token= → no change, falls back to the stored token', () => {
    const store = memStore();
    store.setItem('amrita.auth-token', 'existing');
    const adopted = bootstrapTokenFromLocation(
      { hash: '#/some/route', replaceHash: () => {} },
      store,
    );
    expect(adopted).toBeUndefined();
    expect(loadToken(store)).toBe('existing');
  });
});
