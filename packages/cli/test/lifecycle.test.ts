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

  it('builds a #token= URL only when a token is given', () => {
    expect(openUrl(7461)).toBe('http://localhost:7461/');
    expect(openUrl(7461, 'a+b')).toBe('http://localhost:7461/#token=a%2Bb');
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
