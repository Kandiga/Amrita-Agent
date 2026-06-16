import { describe, expect, it } from 'vitest';
import { isSecretLikeKey, looksLikeSecretValue, parseConfigValue } from '../src/config-cli.ts';

describe('config-cli guards', () => {
  it('flags secret-bearing key names', () => {
    for (const k of [
      'openai_api_key',
      'API_KEY',
      'githubToken',
      'password',
      'db.credential',
      'authBearer',
      'ACCESS_KEY_ID',
    ]) {
      expect(isSecretLikeKey(k)).toBe(true);
    }
  });

  it('allows ordinary non-secret keys', () => {
    for (const k of ['theme', 'verbose', 'maxItems', 'defaultProject', 'locale']) {
      expect(isSecretLikeKey(k)).toBe(false);
    }
  });

  it('detects obvious secret token shapes regardless of key name', () => {
    expect(looksLikeSecretValue('sk-livetoken123')).toBe(true);
    expect(looksLikeSecretValue('ghp_abc123')).toBe(true);
    expect(looksLikeSecretValue('github_pat_xyz')).toBe(true);
    expect(looksLikeSecretValue('xoxb-123-456')).toBe(true);
    expect(looksLikeSecretValue('Bearer abc')).toBe(true);
    // ordinary values pass through
    expect(looksLikeSecretValue('dark')).toBe(false);
    expect(looksLikeSecretValue('true')).toBe(false);
    expect(looksLikeSecretValue('42')).toBe(false);
  });

  it('coerces booleans and numbers, leaves strings alone', () => {
    expect(parseConfigValue('true')).toBe(true);
    expect(parseConfigValue('false')).toBe(false);
    expect(parseConfigValue('5')).toBe(5);
    expect(parseConfigValue('-3.5')).toBe(-3.5);
    expect(parseConfigValue('dark')).toBe('dark');
    expect(parseConfigValue('2026-06-16')).toBe('2026-06-16'); // not a bare number
  });
});
