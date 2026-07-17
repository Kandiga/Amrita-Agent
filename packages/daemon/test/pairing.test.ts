import { describe, expect, it } from 'vitest';
import {
  PairingRegistry,
  SESSION_COOKIE,
  SESSION_COOKIE_SECURE,
  SessionRegistry,
  clearSessionCookie,
  resolveCookieMode,
  sessionCookieName,
  sessionFromCookie,
  sessionSetCookie,
} from '../src/auth.ts';

const env = (o: Record<string, string>): NodeJS.ProcessEnv => o as NodeJS.ProcessEnv;

/** ADR-0057: pairing codes + cookie sessions — the browser never sees the bearer. */

describe('PairingRegistry', () => {
  it('mints a typeable XXXX-XXXX code and consumes it exactly once', () => {
    const reg = new PairingRegistry(120_000);
    const { code, expiresAt } = reg.mint(1_000);
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(expiresAt).toBe(121_000);
    expect(reg.consume(code, 2_000)).toBe(true);
    expect(reg.consume(code, 2_001)).toBe(false); // single-use — replay dies
  });

  it('accepts sloppy input (case, spaces, dash)', () => {
    const reg = new PairingRegistry();
    const { code } = reg.mint(0);
    const sloppy = ` ${code.toLowerCase().replace('-', ' ')} `;
    expect(reg.consume(sloppy, 1)).toBe(true);
  });

  it('an expired code is dead even if presented, and pruned from memory', () => {
    const reg = new PairingRegistry(1_000);
    const { code } = reg.mint(0);
    expect(reg.consume(code, 1_001)).toBe(false);
    expect(reg.pendingCount(1_001)).toBe(0);
  });

  it('never accepts an unknown code', () => {
    const reg = new PairingRegistry();
    reg.mint(0);
    expect(reg.consume('AAAA-AAAA', 1)).toBe(false);
  });

  it('two mints are independent and each single-use', () => {
    const reg = new PairingRegistry();
    const a = reg.mint(0);
    const b = reg.mint(0);
    expect(a.code).not.toBe(b.code);
    expect(reg.consume(a.code, 1)).toBe(true);
    expect(reg.consume(b.code, 1)).toBe(true);
    expect(reg.pendingCount(1)).toBe(0);
  });
});

describe('SessionRegistry', () => {
  it('creates 192-bit ids and validates with sliding expiry', () => {
    const reg = new SessionRegistry(10_000);
    const id = reg.create(0);
    expect(id).toMatch(/^[A-Za-z0-9_-]{32}$/); // 24 bytes base64url
    expect(reg.validate(id, 9_000)).toBe(true); // touched at 9s
    expect(reg.validate(id, 18_000)).toBe(true); // slid — 9s later, still < ttl
    expect(reg.validate(id, 40_000)).toBe(false); // 22s idle > ttl → dead
    expect(reg.validate(id, 40_001)).toBe(false); // and stays dead
  });

  it('rejects unknown/empty ids and revoke kills a live session', () => {
    const reg = new SessionRegistry();
    expect(reg.validate(undefined, 0)).toBe(false);
    expect(reg.validate('nope', 0)).toBe(false);
    const id = reg.create(0);
    reg.revoke(id);
    expect(reg.validate(id, 1)).toBe(false);
    expect(reg.count(1)).toBe(0);
  });
});

describe('cookie mode is server-owned, never client X-Forwarded-Proto (Boni finding 2)', () => {
  it('resolveCookieMode reads AMRITA_WEB_TLS only; XFP is ignored', () => {
    expect(resolveCookieMode(env({})).secure).toBe(false); // fail-closed default (local HTTP)
    expect(resolveCookieMode(env({ AMRITA_WEB_TLS: '1' })).secure).toBe(true);
    expect(resolveCookieMode(env({ AMRITA_WEB_TLS: 'true' })).secure).toBe(true);
    // A client-forgeable proxy header must NOT flip the mode to secure or insecure:
    expect(resolveCookieMode(env({ 'x-forwarded-proto': 'https' })).secure).toBe(false);
    expect(
      resolveCookieMode(env({ AMRITA_WEB_TLS: '1', 'x-forwarded-proto': 'http' })).secure,
    ).toBe(true);
  });
});

describe('session cookie helpers — local-HTTP mode', () => {
  const mode = { secure: false };
  it('sets an HttpOnly SameSite=Strict cookie WITHOUT Secure and can clear it', () => {
    const set = sessionSetCookie('abc123', mode, 60_000);
    expect(set).toBe(`${SESSION_COOKIE}=abc123; Max-Age=60; Path=/; HttpOnly; SameSite=Strict`);
    expect(set).not.toContain('Secure');
    expect(sessionCookieName(mode)).toBe(SESSION_COOKIE);
    const cleared = clearSessionCookie(mode);
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('HttpOnly');
    expect(cleared).not.toContain('Secure');
  });
});

describe('session cookie helpers — TLS mode (Boni finding 2)', () => {
  const mode = { secure: true };
  it('emits Secure and the __Host- prefix (Path=/ and no Domain satisfy the prefix rules)', () => {
    const set = sessionSetCookie('abc123', mode, 60_000);
    expect(set).toBe(
      `${SESSION_COOKIE_SECURE}=abc123; Max-Age=60; Path=/; HttpOnly; SameSite=Strict; Secure`,
    );
    expect(sessionCookieName(mode)).toBe(SESSION_COOKIE_SECURE);
    expect(SESSION_COOKIE_SECURE.startsWith('__Host-')).toBe(true);
    const cleared = clearSessionCookie(mode);
    expect(cleared).toContain('__Host-');
    expect(cleared).toContain('Secure');
    expect(cleared).toContain('Max-Age=0');
  });
});

describe('sessionFromCookie reads either mode’s name', () => {
  it('parses the plain and the __Host- session id out of a Cookie header', () => {
    expect(sessionFromCookie(`x=1; ${SESSION_COOKIE}=tok-9; y=2`)).toBe('tok-9');
    expect(sessionFromCookie(`${SESSION_COOKIE_SECURE}=host-tok`)).toBe('host-tok');
    expect(sessionFromCookie(`${SESSION_COOKIE}=solo`)).toBe('solo');
    expect(sessionFromCookie(`${SESSION_COOKIE}=`)).toBeUndefined();
    expect(sessionFromCookie('other=1')).toBeUndefined();
    expect(sessionFromCookie(undefined)).toBeUndefined();
  });
});
