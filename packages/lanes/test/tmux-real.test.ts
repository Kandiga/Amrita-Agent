import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createNodeTmuxController } from '../src/index.ts';

/**
 * REAL-tmux regression (found live, 2026-07-16): `display-message -p` SANITIZES
 * control characters — a TAB becomes `_` — when the client runs without a locale
 * (`LANG`/`LC_*` unset), which is exactly the systemd/production environment. A
 * tab-delimited `sessionState` format therefore parses to `agent=null/cwd=null`
 * in production while passing from any interactive shell, and every interactive
 * lane aborts with a false "identity mismatch". The controller must parse its
 * state with a printable delimiter that survives sanitization.
 *
 * Runs only where tmux exists (this repo's host runs the real daemon).
 */
const controller = createNodeTmuxController();
const tmuxAvailable = await controller.available();

// The daemon inherits systemd's minimal env: no LANG, no LC_*, no TERM. scrubEnv
// forwards from process.env at spawn time, so stripping them here reproduces the
// production client environment for every tmux call in this suite.
const LOCALE_KEYS = ['LANG', 'LC_ALL', 'LC_CTYPE', 'TERM'] as const;
const saved = new Map<string, string | undefined>();
for (const k of LOCALE_KEYS) {
  saved.set(k, process.env[k]);
  delete process.env[k];
}
afterAll(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe.skipIf(!tmuxAvailable)('createNodeTmuxController on real tmux, production env', () => {
  it('sessionState survives display-message control-char sanitization (no LANG/TERM)', async () => {
    const name = 'amrita-test-localeparse';
    const dir = mkdtempSync(join(tmpdir(), 'amrita-real-'));
    try {
      await controller.newSession({ name, cwd: dir, agent: 'claude', command: ['sleep', '10'] });
      const state = await controller.sessionState(name);
      expect(state.exists).toBe(true);
      expect(state.dead).toBe(false);
      expect(state.agent).toBe('claude'); // tab-delimited parsing returned null here
      expect(state.cwd).toBe(dir); // …and null here
      expect(state.goalSent).toBe(false);

      // The at-most-once goal queue must also behave under the production env.
      expect(await controller.sendGoalOnce(name, 'real-goal-marker-check')).toBe(true);
      expect(await controller.sendGoalOnce(name, 'real-goal-marker-check')).toBe(false);
      expect((await controller.sessionState(name)).goalSent).toBe(true);
    } finally {
      await controller.killSession(name).catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
    expect(await controller.hasSession(name)).toBe(false);
  });

  it('missing cwd is rejected with the exact reason and no orphan session', async () => {
    const name = 'amrita-test-missingcwd';
    await expect(
      controller.newSession({
        name,
        cwd: '/root/amrita-workspaces/definitely-missing-regression-dir',
        agent: 'claude',
        command: ['sleep', '5'],
      }),
    ).rejects.toThrow(/tmux session cwd is not a directory/);
    expect(await controller.hasSession(name)).toBe(false);
  });
});
