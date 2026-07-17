import { describe, expect, it } from 'vitest';
import {
  cookieOriginAllowed,
  isTrustedBrowserOrigin,
  resolveBrowserTrust,
} from '../src/browser-origin.ts';

/**
 * ADR-0057 hardening (Boni finding 1): cookie authentication is a BROWSER
 * credential, so it is honored only for a request that demonstrably comes from
 * the trusted dashboard origin. The Origin header is browser-set and unforgeable
 * by page JavaScript — a same-site page on another localhost port is a DIFFERENT
 * origin and must be rejected. Bearer clients (CLI) never carry Origin and are
 * unaffected. This is the single authority; the pure core is tested here.
 */

const env = (o: Record<string, string>): NodeJS.ProcessEnv => o as NodeJS.ProcessEnv;

describe('resolveBrowserTrust', () => {
  it('defaults to ONLY the standard local dashboard port — not any localhost port', () => {
    const trust = resolveBrowserTrust({ env: env({}) });
    expect(isTrustedBrowserOrigin('http://localhost:7461', trust)).toBe(true);
    expect(isTrustedBrowserOrigin('http://127.0.0.1:7461', trust)).toBe(true);
    // The whole point: a page on a DIFFERENT localhost port is hostile.
    expect(isTrustedBrowserOrigin('http://localhost:9999', trust)).toBe(false);
    expect(isTrustedBrowserOrigin('http://127.0.0.1:3002', trust)).toBe(false);
    expect(isTrustedBrowserOrigin('https://evil.example', trust)).toBe(false);
  });

  it('AMRITA_WEB_ORIGINS declares the dashboard origin(s) exactly', () => {
    const trust = resolveBrowserTrust({
      env: env({ AMRITA_WEB_ORIGINS: 'http://127.0.0.1:7474, https://amrita.example' }),
    });
    expect(isTrustedBrowserOrigin('http://127.0.0.1:7474', trust)).toBe(true);
    expect(isTrustedBrowserOrigin('https://amrita.example', trust)).toBe(true);
    // declaring a web origin REPLACES the default port — 7461 is no longer implied
    expect(isTrustedBrowserOrigin('http://localhost:7461', trust)).toBe(false);
  });

  it('AMRITA_ALLOWED_ORIGINS (CORS allowlist) folds into the trusted set', () => {
    const trust = resolveBrowserTrust({
      env: env({ AMRITA_ALLOWED_ORIGINS: 'https://cinema.example' }),
    });
    expect(isTrustedBrowserOrigin('https://cinema.example', trust)).toBe(true);
    // an explicit allowlist replaces the loopback default (matches CORS semantics)
    expect(isTrustedBrowserOrigin('http://localhost:7461', trust)).toBe(false);
  });

  it("the daemon's own bound origin is trusted for direct dev access", () => {
    const trust = resolveBrowserTrust({ env: env({}), selfPort: 7460 });
    expect(isTrustedBrowserOrigin('http://localhost:7460', trust)).toBe(true);
    expect(isTrustedBrowserOrigin('http://127.0.0.1:7460', trust)).toBe(true);
  });

  it('an empty/undefined origin is never "trusted" on its own', () => {
    const trust = resolveBrowserTrust({ env: env({}) });
    expect(isTrustedBrowserOrigin(undefined, trust)).toBe(false);
    expect(isTrustedBrowserOrigin('', trust)).toBe(false);
  });
});

describe('cookieOriginAllowed — the gate applied to cookie-authenticated actions', () => {
  const trust = resolveBrowserTrust({ env: env({ AMRITA_WEB_ORIGINS: 'http://127.0.0.1:7474' }) });

  it('a mutation (or WS) REQUIRES a present, trusted origin', () => {
    expect(cookieOriginAllowed('http://127.0.0.1:7474', 'POST', trust)).toBe(true);
    expect(cookieOriginAllowed('http://localhost:9999', 'POST', trust)).toBe(false); // hostile
    expect(cookieOriginAllowed(undefined, 'POST', trust)).toBe(false); // no Origin → reject
    expect(cookieOriginAllowed('http://127.0.0.1:7474', 'WS', trust)).toBe(true);
    expect(cookieOriginAllowed('http://localhost:9999', 'WS', trust)).toBe(false);
    expect(cookieOriginAllowed(undefined, 'WS', trust)).toBe(false);
  });

  it('a read (GET) tolerates a MISSING origin but still rejects a hostile one', () => {
    expect(cookieOriginAllowed(undefined, 'GET', trust)).toBe(true); // same-origin GET may omit
    expect(cookieOriginAllowed('http://127.0.0.1:7474', 'GET', trust)).toBe(true);
    expect(cookieOriginAllowed('http://localhost:9999', 'GET', trust)).toBe(false);
  });
});
