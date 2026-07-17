import { describe, expect, it } from 'vitest';
import { openUrl, planOpen, platformOpenCommand, waitForReady } from '../src/lifecycle.ts';

/** Community onboarding P5 — the pure open-lifecycle core. */

describe('open lifecycle (pure)', () => {
  it('plans health URLs for the daemon and web from the ports', () => {
    const p = planOpen();
    expect(p.daemonHealthUrl).toBe('http://127.0.0.1:7460/health');
    expect(p.webHealthUrl).toBe('http://127.0.0.1:7461/health');
    expect(planOpen({ webPort: 9000 }).webHealthUrl).toBe('http://127.0.0.1:9000/health');
  });

  it('the open URL is plain — structurally no secret can ride it (ADR-0057)', () => {
    expect(openUrl(7461)).toBe('http://localhost:7461/');
    expect(openUrl(9000)).toBe('http://localhost:9000/');
  });

  it('waitForReady polls until ready, deterministically', async () => {
    let n = 0;
    const r = await waitForReady(async () => ++n >= 3, { delayMs: 0, sleep: async () => {} });
    expect(r).toEqual({ ready: true, attempts: 3 });
  });

  it('waitForReady gives up after the budget (never hangs)', async () => {
    const r = await waitForReady(async () => false, {
      tries: 5,
      delayMs: 0,
      sleep: async () => {},
    });
    expect(r).toEqual({ ready: false, attempts: 5 });
  });

  it('picks the platform open command; headless returns null (prints URL instead)', () => {
    expect(platformOpenCommand('linux')?.cmd).toBe('xdg-open');
    expect(platformOpenCommand('darwin')?.cmd).toBe('open');
    expect(platformOpenCommand('android')).toBeNull();
  });
});

describe('credential-strength fitness (security review 2026-07-17)', () => {
  it('the launcher never derives credential material from Math.random', async () => {
    // Regression guard: the stable AMRITA_AUTH_TOKEN gates the whole control
    // surface and MUST come from the daemon's CSPRNG helper (generateDevToken),
    // never a seeded PRNG. Source-level check keeps this un-reintroducible.
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../src/launcher.ts', import.meta.url), 'utf8');
    expect(src).not.toContain('Math.random');
    expect(src).toContain('generateDevToken');
  });

  it('no CLI source ever builds a #token= URL again (ADR-0057)', async () => {
    // The bearer must never ride a URL fragment into a browser: history, shared
    // links, and shoulder-surfing all defeat it. Auth is pairing-code → cookie.
    const { readFile } = await import('node:fs/promises');
    for (const file of ['../src/launcher.ts', '../src/lifecycle.ts', '../src/commands.ts']) {
      const src = await readFile(new URL(file, import.meta.url), 'utf8');
      expect(src, `${file} must not embed tokens in URLs`).not.toContain('#token=');
    }
  });
});
