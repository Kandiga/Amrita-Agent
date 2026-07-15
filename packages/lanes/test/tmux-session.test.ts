import { type LaneMandate, laneMandateSchema, newId } from '@amrita/protocol';
import { describe, expect, it } from 'vitest';
import { FakeTmuxController, TmuxSessionLaneRunner, redactPane } from '../src/index.ts';

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

const mkRunner = (tmux: FakeTmuxController, agent: 'claude' | 'codex' = 'claude') =>
  new TmuxSessionLaneRunner({
    agent,
    tmux,
    allowedRoots: ['/ws'],
    captureIntervalMs: 5,
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
});
