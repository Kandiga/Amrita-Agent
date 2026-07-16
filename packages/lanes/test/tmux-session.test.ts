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

/** Records every `sendKeys` so tests can assert WHAT was typed and in what ORDER. */
class RecordingTmux extends FakeTmuxController {
  sent: string[] = [];
  override async sendKeys(name: string, text: string, opts?: { enter?: boolean }): Promise<void> {
    this.sent.push(text);
    await super.sendKeys(name, text, opts);
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

    setTimeout(() => tmux.emit(`amrita-${m.laneId}`, '\nhello from claude'), 12);
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
    const tmux = new FakeTmuxController();
    const runner = mkRunner(tmux);
    const m = mandate('should NOT be re-typed');
    await tmux.newSession({ name: `amrita-${m.laneId}`, cwd: '/ws/L1', command: [] }); // already alive
    const notes: string[] = [];
    const finish = new AbortController();
    setTimeout(() => finish.abort(), 20);
    await runner.run(m, { onProgress: (n) => notes.push(n), finishSignal: finish.signal });
    expect(notes.some((n) => /re-attached/i.test(n))).toBe(true);
    // the goal is NOT re-sent on a resume
    expect(await tmux.capturePane(`amrita-${m.laneId}`)).not.toContain('should NOT be re-typed');
  });

  it('redactPane strips secret-shaped content', () => {
    expect(redactPane('key sk-ABCDEFGHIJKLMNOP1234')).toContain('‹redacted›');
    expect(redactPane('export API_KEY=supersecretvalue')).toContain('‹redacted›');
    expect(redactPane('ghp_ABCDEFGHIJKLMNOPQRST1234')).toContain('‹redacted›');
    expect(redactPane('nothing to hide here')).toBe('nothing to hide here');
  });

  it('classifyBootPane recognizes trust dialogs, logins, and ready screens', () => {
    expect(classifyBootPane('Do you trust the files in this folder?\n> Yes, proceed')).toBe(
      'prompt',
    );
    expect(classifyBootPane('Choose the text style that looks best')).toBe('prompt');
    expect(classifyBootPane('Select login method:\n1. Claude account')).toBe('login');
    expect(classifyBootPane('│ > \n? for shortcuts')).toBe('none');
    // only the TAIL counts — old scrollback must not pin the classification
    const history = `Do you trust the files in this folder?\n${'ok\n'.repeat(20)}ready`;
    expect(classifyBootPane(history)).toBe('none');
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

  it('a login screen: no keypress into it, but the goal is still sent by the defer cap', async () => {
    const tmux = new RecordingTmux();
    const runner = new TmuxSessionLaneRunner({
      agent: 'claude',
      tmux,
      allowedRoots: ['/ws'],
      captureIntervalMs: 5,
      launchDelayMs: 2,
      goalDelayMs: 10, // login appears (at 6ms) before this elapses
      goalDeferCapMs: 40,
      defaultMaxMinutes: 60,
    });
    const m = mandate('login-deferred goal');
    const name = `amrita-${m.laneId}`;
    const finish = new AbortController();

    setTimeout(() => tmux.emit(name, '\nSelect login method:\n1. Claude account'), 6);
    setTimeout(() => finish.abort(), 140); // well past the 40ms defer cap

    const report = await runner.run(m, { finishSignal: finish.signal });
    expect(report.exit).toBe('done');
    // The goal IS sent past the cap (never silently dropped)…
    expect(tmux.sent).toContain('login-deferred goal');
    // …but we NEVER pressed Enter into the login screen (only 'claude' + the goal).
    expect(tmux.sent.filter((t) => t === '')).toHaveLength(0);
  });
});
