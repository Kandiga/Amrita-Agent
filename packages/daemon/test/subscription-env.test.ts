import { afterEach, describe, expect, it } from 'vitest';
import { defaultCliExec } from '../src/provider.ts';
import { defaultProber } from '../src/runtimes.ts';

/**
 * Community onboarding — SECURITY floor (findings 5/6): the subscription CLI
 * child (`claude -p`/`codex exec`) and the auth probe (`claude auth status`)
 * must NEVER inherit a stray ANTHROPIC_API_KEY/OPENAI_API_KEY from the daemon
 * env, or a run silently bills the wrong account and a probe misreports an API
 * key as a subscription. Proven with a REAL child process (printenv).
 */

const SAVED = { a: process.env.ANTHROPIC_API_KEY, o: process.env.OPENAI_API_KEY };
afterEach(() => {
  const A = 'ANTHROPIC_API_KEY';
  const O = 'OPENAI_API_KEY';
  if (SAVED.a === undefined) delete process.env[A];
  else process.env[A] = SAVED.a;
  if (SAVED.o === undefined) delete process.env[O];
  else process.env[O] = SAVED.o;
});

describe('subscription child env is scrubbed (real process)', () => {
  it('defaultCliExec drops ANTHROPIC_API_KEY/OPENAI_API_KEY but keeps HOME', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-MUST-NOT-LEAK';
    process.env.OPENAI_API_KEY = 'sk-MUST-NOT-LEAK';
    const r = await defaultCliExec('/usr/bin/printenv', [], '', 5000, () => {});
    expect(r.stdout).not.toContain('MUST-NOT-LEAK');
    expect(r.stdout).not.toMatch(/ANTHROPIC_API_KEY|OPENAI_API_KEY/);
    expect(r.stdout).toMatch(/HOME=/); // the CLI can still find its own login
  });

  it('defaultProber runs the auth probe without any API key in the child env', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-MUST-NOT-LEAK';
    const res = await defaultProber('/usr/bin/printenv', [], 5000);
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      expect(res.stdout).not.toContain('MUST-NOT-LEAK');
      expect(res.stdout).not.toMatch(/ANTHROPIC_API_KEY/);
    }
  });
});
