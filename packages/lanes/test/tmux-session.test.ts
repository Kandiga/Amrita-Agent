import { type LaneMandate, laneMandateSchema, newId } from '@amrita/protocol';
import { describe, expect, it } from 'vitest';
import {
  FakeTmuxController,
  TmuxSessionLaneRunner,
  classifyBootPane,
  redactPane,
} from '../src/index.ts';

const mandate = (goal = 'build the widget'): LaneMandate =>
  laneMandateSchema.parse({
    laneId: newId(),
    goal,
    contextPack: { memory: [], files: [], decisions: [] },
    scope: { paths: ['/ws/L1'], network: 'none' },
    budget: {},
    approvals: 'auto-safe',
    deliverables: [],
  });

/** Records starts and every pane write so tests can assert exact ordering. */
class RecordingTmux extends FakeTmuxController {
  sent: string[] = [];
  started: Array<Parameters<FakeTmuxController['newSession']>[0]> = [];
  override async newSession(spec: Parameters<FakeTmuxController['newSession']>[0]): Promise<void> {
    this.started.push(spec);
    await super.newSession(spec);
  }
  override async sendKeys(name: string, text: string, opts?: { enter?: boolean }): Promise<void> {
    this.sent.push(text);
    await super.sendKeys(name, text, opts);
  }
  override async sendGoalOnce(name: string, text: string): Promise<boolean> {
    const sent = await super.sendGoalOnce(name, text);
    if (sent) this.sent.push(text);
    return sent;
  }
}

const mkRunner = (tmux: FakeTmuxController, agent: 'claude' | 'codex' = 'claude') =>
  new TmuxSessionLaneRunner({
    agent,
    tmux,
    allowedRoots: ['/ws'],
    captureIntervalMs: 5,
    launchDelayMs: 2,
    goalDelayMs: 0,
    defaultMaxMinutes: 60,
  });

describe('TmuxSessionLaneRunner (ADR-0049)', () => {
  it('opens a session, streams the pane, and finishes gracefully → done', async () => {
    const tmux = new FakeTmuxController();
    const runner = mkRunner(tmux);
    const m = mandate();
    const panes: string[] = [];
    const finish = new AbortController();

    setTimeout(() => tmux.emit(`amrita-${m.laneId}`, '\nhello from claude\n❯ '), 12);
    setTimeout(() => finish.abort(), 40);

    const report = await runner.run(m, {
      onPane: (t) => panes.push(t),
      finishSignal: finish.signal,
    });
    expect(report.exit).toBe('done');
    expect(panes.some((p) => p.includes('hello from claude'))).toBe(true);
    expect(panes.some((p) => p.includes('build the widget'))).toBe(true); // the goal was typed in
    expect(await tmux.hasSession(`amrita-${m.laneId}`)).toBe(false); // torn down
  });

  it('launches Codex with its interactive updater disabled', async () => {
    const tmux = new RecordingTmux();
    const runner = mkRunner(tmux, 'codex');
    const m = mandate('inspect the widget');
    const finish = new AbortController();
    setTimeout(() => tmux.emit(`amrita-${m.laneId}`, '\n› Improve documentation in @filename'), 12);
    setTimeout(() => finish.abort(), 40);

    await runner.run(m, { finishSignal: finish.signal });

    expect(tmux.started[0]).toMatchObject({
      agent: 'codex',
      command: ['codex', '-c', 'check_for_update_on_startup=false'],
    });
    expect(tmux.sent).toEqual(['inspect the widget']);
  });

  it('cancel → cancelled and the session is killed', async () => {
    const tmux = new FakeTmuxController();
    const runner = mkRunner(tmux);
    const m = mandate();
    const cancel = new AbortController();
    setTimeout(() => cancel.abort(), 20);
    const report = await runner.run(m, { signal: cancel.signal });
    expect(report.exit).toBe('cancelled');
  });

  it('is honest when tmux is not installed → aborted with a fix', async () => {
    const tmux = new FakeTmuxController();
    tmux.isAvailable = false;
    const report = await mkRunner(tmux).run(mandate());
    expect(report.exit).toBe('aborted');
    expect(report.summary).toMatch(/tmux is not installed/i);
  });

  it('refuses a workspace outside the allowed roots', async () => {
    const runner = mkRunner(new FakeTmuxController());
    const m = laneMandateSchema.parse({
      laneId: newId(),
      goal: 'x',
      contextPack: { memory: [], files: [], decisions: [] },
      scope: { paths: ['/etc'], network: 'none' },
      budget: {},
      approvals: 'auto-safe',
      deliverables: [],
    });
    const report = await runner.run(m);
    expect(report.exit).toBe('aborted');
    expect(report.summary).toMatch(/outside every allowed root/i);
  });

  it('re-attaches to an existing session instead of re-launching', async () => {
    const tmux = new RecordingTmux();
    const runner = mkRunner(tmux);
    const m = mandate('should NOT be re-typed');
    await tmux.newSession({
      name: `amrita-${m.laneId}`,
      cwd: '/ws/L1',
      agent: 'claude',
      command: ['claude'],
    }); // already alive
    const notes: string[] = [];
    const finish = new AbortController();
    setTimeout(() => finish.abort(), 20);
    await runner.run(m, {
      onProgress: (n) => notes.push(n),
      finishSignal: finish.signal,
      sessionGoalAlreadySent: true,
    });
    expect(notes.some((n) => /re-attached/i.test(n))).toBe(true);
    expect(tmux.started).toHaveLength(1); // the pre-existing session only
    expect(tmux.sent).toEqual([]); // neither launch text nor goal was typed
  });

  it('refuses and removes a pre-existing session outside the mandated workspace', async () => {
    const tmux = new RecordingTmux();
    const runner = mkRunner(tmux);
    const m = mandate('must stay isolated');
    const name = `amrita-${m.laneId}`;
    await tmux.newSession({
      name,
      cwd: '/ws/other-project',
      agent: 'claude',
      command: ['claude'],
    });

    const report = await runner.run(m);

    expect(report.exit).toBe('aborted');
    expect(report.summary).toMatch(/escaped its mandated workspace/i);
    expect(await tmux.hasSession(name)).toBe(false);
    expect(tmux.sent).toEqual([]);
  });

  it('resumes an authentication-blocked session and sends an unsent goal exactly once', async () => {
    const tmux = new RecordingTmux();
    const runner = mkRunner(tmux);
    const m = mandate('send after recovered login');
    const name = `amrita-${m.laneId}`;
    await tmux.newSession({ name, cwd: '/ws/L1', agent: 'claude', command: ['claude'] });
    tmux.emit(name, 'Select login method:\n1. Claude account');
    const finish = new AbortController();

    setTimeout(() => {
      const state = tmux as unknown as { sessions: Map<string, { pane: string }> };
      const session = state.sessions.get(name);
      if (session) session.pane = `${'.\n'.repeat(16)}READY\n│ > `;
    }, 30);
    setTimeout(() => finish.abort(), 80);

    await runner.run(m, {
      finishSignal: finish.signal,
      sessionGoalAlreadySent: false,
    });

    expect(tmux.sent).toEqual(['send after recovered login']);
  });

  it('uses the tmux-side marker as restart SSOT and never re-sends the goal', async () => {
    const tmux = new RecordingTmux();
    const runner = mkRunner(tmux);
    const m = mandate('at-most-once restart goal');
    const name = `amrita-${m.laneId}`;
    await tmux.newSession({ name, cwd: '/ws/L1', agent: 'claude', command: ['claude'] });
    await tmux.sendGoalOnce(name, m.goal);
    tmux.sent = [];
    const raw = tmux as unknown as {
      sessions: Map<string, { pane: string }>;
    };
    const session = raw.sessions.get(name);
    if (session) session.pane = 'READY\n❯ ';
    const finish = new AbortController();
    const notes: string[] = [];
    setTimeout(() => finish.abort(), 30);

    await runner.run(m, {
      finishSignal: finish.signal,
      sessionGoalAlreadySent: false,
      onProgress: (note) => notes.push(note),
    });

    expect(tmux.sent).toEqual([]);
    expect(notes).toContain('sent the goal to the session');
  });

  it('never sends a goal after the direct agent process has exited', async () => {
    const tmux = new RecordingTmux();
    const runner = mkRunner(tmux);
    const m = mandate('must not reach a shell');
    const name = `amrita-${m.laneId}`;
    setTimeout(() => {
      tmux.emit(name, '\n❯ ');
      tmux.markDead(name);
    }, 2);

    const report = await runner.run(m);

    expect(report.exit).toBe('partial');
    expect(tmux.sent).toEqual([]);
  });

  it('redactPane strips secret-shaped content', () => {
    const githubToken = `github_pat_${'A'.repeat(30)}`;
    const pane = [
      'key «redacted:sk-…»',
      'export API_KEY=supersecretvalue',
      '«redacted:ghp_…»',
      githubToken,
      'DATABASE_URL=postgresql://alice:database-password@db.internal/app',
      'open https://example.test/callback?access_token=url-secret-value&next=1',
      'Authorization: Bearer header.payload.signature',
      '{"api_key":"json-secret-value","safe":"visible"}',
      "'client_secret': 'yaml-secret-value'",
      '-----BEGIN PRIVATE KEY-----\nprivate-key-must-not-leak\n-----END PRIVATE KEY-----', // fixture: must-not-leak
    ].join('\n');

    const redacted = redactPane(pane);

    for (const secret of [
      'supersecretvalue',
      githubToken,
      'database-password',
      'url-secret-value',
      'header.payload.signature',
      'json-secret-value',
      'yaml-secret-value',
      'private-key-must-not-leak',
    ]) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain('‹redacted›');
    expect(redactPane('nothing to hide here')).toBe('nothing to hide here');
  });

  it('classifyBootPane recognizes trust dialogs, logins, blocked choices, and ready screens', () => {
    const blankRows = '\n'.repeat(40);
    expect(classifyBootPane('Do you trust the files in this folder?\n> Yes, proceed')).toBe(
      'prompt',
    );
    expect(
      classifyBootPane(
        `Do you trust the contents of this directory?\n1. Yes, continue\nPress enter to continue\n${blankRows}`,
      ),
    ).toBe('prompt');
    expect(classifyBootPane(`Sign in with ChatGPT\nUse an API key\n${blankRows}`)).toBe('login');
    expect(
      classifyBootPane(
        'Quick safety check: Is this a project you created or one you trust?\n❯ 1. Yes, I trust this folder',
      ),
    ).toBe('prompt');
    expect(classifyBootPane('Choose the text style that looks best')).toBe('prompt');
    expect(classifyBootPane('Select login method:\n1. Claude account')).toBe('login');
    expect(classifyBootPane('Sign in with ChatGPT\nUse an API key')).toBe('login');
    expect(classifyBootPane('Do you trust the files in this folder?\nSign in with ChatGPT')).toBe(
      'login',
    );
    expect(classifyBootPane('✨ Update available!\n› 1. Update now\n2. Skip')).toBe('blocked');
    expect(classifyBootPane('│ > \n? for shortcuts')).toBe('ready');
    expect(classifyBootPane('❯\u00a0\n── auto mode on')).toBe('ready');
    expect(classifyBootPane('› Improve documentation in @filename\nmodel default')).toBe('ready');
    expect(classifyBootPane('Starting agent…')).toBe('none');
    // only the TAIL counts — old scrollback must not pin the classification
    const history = `Do you trust the files in this folder?\n${'ok\n'.repeat(40)}❯ `;
    expect(classifyBootPane(history)).toBe('ready');
  });

  it('a folder-trust dialog is accepted with Enter — the goal is NEVER typed into it', async () => {
    const tmux = new RecordingTmux();
    const runner = new TmuxSessionLaneRunner({
      agent: 'claude',
      tmux,
      allowedRoots: ['/ws'],
      captureIntervalMs: 5,
      launchDelayMs: 2,
      goalDelayMs: 25, // long enough that the dialog (at 8ms) is seen first
      defaultMaxMinutes: 60,
    });
    const m = mandate('the real goal text');
    const name = `amrita-${m.laneId}`;
    const finish = new AbortController();

    // Dialog appears before goalDelay elapses; must NOT receive the goal text.
    setTimeout(
      () => tmux.emit(name, '\nDo you trust the files in this folder?\n> Yes, proceed'),
      8,
    );
    // The screen then moves on (replace the tail so classify → 'none').
    setTimeout(() => {
      const s = tmux as unknown as { sessions: Map<string, { pane: string }> };
      const sess = s.sessions.get(name);
      if (sess) sess.pane = `${'.\n'.repeat(16)}READY\n│ > `;
    }, 45);
    setTimeout(() => finish.abort(), 110);

    const report = await runner.run(m, { finishSignal: finish.signal });
    expect(report.exit).toBe('done');
    const goalIdx = tmux.sent.indexOf('the real goal text');
    const firstEnter = tmux.sent.indexOf(''); // the empty-string Enter that accepts the dialog
    expect(goalIdx).toBeGreaterThan(-1); // the goal WAS eventually sent
    expect(firstEnter).toBeGreaterThan(-1); // the dialog was accepted with Enter
    expect(firstEnter).toBeLessThan(goalIdx); // …and BEFORE the goal — never into the dialog
  });

  it('waits for an explicit ready prompt when a trust dialog appears late', async () => {
    const tmux = new RecordingTmux();
    const runner = new TmuxSessionLaneRunner({
      agent: 'claude',
      tmux,
      allowedRoots: ['/ws'],
      captureIntervalMs: 5,
      launchDelayMs: 2,
      goalDelayMs: 10,
      defaultMaxMinutes: 60,
    });
    const m = mandate('late-safe-goal');
    const name = `amrita-${m.laneId}`;
    const finish = new AbortController();

    setTimeout(
      () =>
        tmux.emit(name, '\nQuick safety check: Is this a project you created or one you trust?'),
      30,
    );
    setTimeout(() => {
      const state = tmux as unknown as { sessions: Map<string, { pane: string }> };
      const session = state.sessions.get(name);
      if (session) session.pane = `${'.\n'.repeat(16)}READY\n❯ `;
    }, 60);
    setTimeout(() => finish.abort(), 110);

    await runner.run(m, { finishSignal: finish.signal });
    expect(tmux.sent.at(-1)).toBe('late-safe-goal');
    expect(tmux.sent.slice(0, -1).length).toBeGreaterThan(0);
    expect(tmux.sent.slice(0, -1).every((entry) => entry === '')).toBe(true);
  });

  it('a non-clearing TUI (Codex): an ANSWERED trust dialog in scrollback must not wedge the goal', async () => {
    // Found live (2026-07-16): Codex answered its trust screen but never cleared it,
    // so the dialog stayed in scrollback. A classifier fed scrollback re-detects
    // 'prompt' forever and the goal is never sent. Classification must read the
    // VISIBLE screen only (capturePane lines=0).
    const tmux = new RecordingTmux();
    const runner = new TmuxSessionLaneRunner({
      agent: 'codex',
      tmux,
      allowedRoots: ['/ws'],
      captureIntervalMs: 5,
      launchDelayMs: 2,
      goalDelayMs: 10,
      defaultMaxMinutes: 60,
    });
    const m = mandate('codex goal after scrollback');
    const name = `amrita-${m.laneId}`;
    const finish = new AbortController();

    // The trust dialog appears…
    setTimeout(
      () =>
        tmux.emit(
          name,
          '\nDo you trust the contents of this directory?\n› 1. Yes, continue\n  2. No, quit\n  Press enter to continue',
        ),
      8,
    );
    // …the runner answers it, and the TUI only APPENDS its banner + ready prompt
    // (never clears). More than VISIBLE_ROWS of new output leaves the dialog in
    // scrollback only — exactly the live Codex screen.
    setTimeout(() => {
      tmux.emit(
        name,
        `\n${'banner line\n'.repeat(FakeTmuxController.VISIBLE_ROWS)}› Use /skills to list available skills`,
      );
    }, 45);
    setTimeout(() => finish.abort(), 170);

    const report = await runner.run(m, { finishSignal: finish.signal });
    expect(report.exit).toBe('done');
    // THE regression: the goal was submitted once the VISIBLE screen became ready.
    expect(tmux.sent.at(-1)).toBe('codex goal after scrollback');
    // Everything before it was only the safe Enter that accepted the trust dialog.
    expect(tmux.sent.slice(0, -1).every((entry) => entry === '')).toBe(true);
    expect(tmux.sent.slice(0, -1).length).toBeGreaterThan(0);
  });

  it('a persistent login screen receives no keypress and no goal, even after the goal delay', async () => {
    const tmux = new RecordingTmux();
    const runner = new TmuxSessionLaneRunner({
      agent: 'claude',
      tmux,
      allowedRoots: ['/ws'],
      captureIntervalMs: 5,
      launchDelayMs: 2,
      goalDelayMs: 10, // login appears (at 6ms) before this elapses
      defaultMaxMinutes: 60,
    });
    const m = mandate('must-not-enter-login');
    const name = `amrita-${m.laneId}`;
    const finish = new AbortController();
    const notes: string[] = [];

    setTimeout(() => tmux.emit(name, '\nSelect login method:\n1. Claude account'), 6);
    setTimeout(() => finish.abort(), 140); // well past the old 40ms defer cap

    const report = await runner.run(m, {
      finishSignal: finish.signal,
      onProgress: (note) => notes.push(note),
    });
    expect(report.exit).toBe('done');
    expect(tmux.sent).toEqual([]);
    expect(notes.filter((note) => /authentication/i.test(note))).toHaveLength(1);
  });
});
