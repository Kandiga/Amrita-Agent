import { describe, expect, it } from 'vitest';
import { type TokenStore, clearToken, loadToken, maskToken, saveToken } from '../src/auth.ts';

function fakeStore(): TokenStore {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

describe('web auth token store', () => {
  it('round-trips a token and clears it', () => {
    const store = fakeStore();
    expect(loadToken(store)).toBeUndefined();
    saveToken('tok-xyz', store);
    expect(loadToken(store)).toBe('tok-xyz');
    clearToken(store);
    expect(loadToken(store)).toBeUndefined();
  });

  it('treats saving an empty token as a clear', () => {
    const store = fakeStore();
    saveToken('tok', store);
    saveToken('', store);
    expect(loadToken(store)).toBeUndefined();
  });

  it('masks a token without revealing its characters or length', () => {
    expect(maskToken('super-secret-token')).toBe('••••••••');
    expect(maskToken('super-secret-token')).not.toMatch(/[a-z]/i);
    expect(maskToken('')).toBe('');
  });
});
