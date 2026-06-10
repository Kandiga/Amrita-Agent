import { type LaneMandate, laneMandateSchema, newId } from '@amrita/protocol';
import { describe, expect, it } from 'vitest';
import {
  BudgetGuard,
  ClaudeCodeLaneRunner,
  DEFAULT_ENV_ALLOWLIST,
  FakeLaneRunner,
  LaneSafetyError,
  type ProcessRunner,
  type ProcessSpawnOptions,
  evaluateBudget,
  isForbiddenEnvName,
  scrubEnv,
} from '../src/index.ts';

function mandate(overrides: Partial<LaneMandate> = {}): LaneMandate {
  return laneMandateSchema.parse({
    laneId: newId(),
    goal: 'do the thing',
    contextPack: {},
    scope: {},
    ...overrides,
  });
}

describe('env scrub (deny-by-default)', () => {
  const base = {
    PATH: '/usr/bin',
    HOME: '/home/amrita',
    ANTHROPIC_API_KEY: 'sk-ant-must-not-leak',
    OPENAI_API_KEY: 'sk-must-not-leak',
    GITHUB_TOKEN: 'ghp_must_not_leak',
    SSH_AUTH_SOCK: '/tmp/ssh-agent',
    AWS_SECRET_ACCESS_KEY: 'aws-must-not-leak',
    MY_PASSWORD: 'hunter2',
    SESSION_COOKIE: 'abc',
  };

  it('forwards benign vars and drops every secret-shaped one', () => {
    const env = scrubEnv(base);
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/amrita');
    for (const forbidden of [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GITHUB_TOKEN',
      'SSH_AUTH_SOCK',
      'AWS_SECRET_ACCESS_KEY',
      'MY_PASSWORD',
      'SESSION_COOKIE',
    ]) {
      expect(env[forbidden]).toBeUndefined();
    }
    expect(JSON.stringify(env)).not.toMatch(/leak|hunter2/);
  });

  it('never forwards a forbidden var even if explicitly allowlisted', () => {
    const env = scrubEnv(base, ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN']);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it('forwards a benign allowlisted var when present', () => {
    const env = scrubEnv({ ...base, MY_FLAG: 'on' }, ['MY_FLAG']);
    expect(env.MY_FLAG).toBe('on');
  });

  it('recognises secret-shaped names and clears the default allowlist of them', () => {
    expect(isForbiddenEnvName('ANTHROPIC_API_KEY')).toBe(true);
    expect(isForbiddenEnvName('PATH')).toBe(false);
    expect(DEFAULT_ENV_ALLOWLIST.some(isForbiddenEnvName)).toBe(false);
  });
});

describe('budget accounting', () => {
  it('flags the first bound exceeded', () => {
    expect(evaluateBudget({ maxTokens: 100 }, { tokens: 101 })).toBe('maxTokens');
    expect(evaluateBudget({ maxUsd: 1 }, { usd: 2 })).toBe('maxUsd');
    expect(evaluateBudget({ maxMinutes: 1 }, { elapsedMs: 61_000 })).toBe('maxMinutes');
    expect(evaluateBudget({ maxTokens: 100 }, { tokens: 100 })).toBeNull();
    expect(evaluateBudget({}, { tokens: 9_999 })).toBeNull();
  });

  it('accumulates turns with an injected clock', () => {
    let t = 1_000;
    const guard = new BudgetGuard({ maxTurns: 2 }, () => t);
    guard.recordTurn({ inputTokens: 1, outputTokens: 1 });
    expect(guard.exceeded()).toBeNull();
    guard.recordTurn();
    guard.recordTurn();
    expect(guard.exceeded()).toBe('maxTurns');
    t = 1_000_000; // wall clock jump trips the time bound too
    expect(new BudgetGuard({ maxMinutes: 1 }, () => t).exceeded()).toBeNull(); // fresh guard: elapsed 0
  });
});

describe('FakeLaneRunner', () => {
  it('runs to a done report and emits progress', async () => {
    const notes: string[] = [];
    const runner = new FakeLaneRunner({
      progress: [
        { note: 'step one', pct: 50 },
        { note: 'step two', pct: 100 },
      ],
      summary: 'all good',
    });
    const m = mandate();
    const report = await runner.run(m, { onProgress: (n) => notes.push(n) });
    expect(report.exit).toBe('done');
    expect(report.laneId).toBe(m.laneId);
    expect(report.summary).toBe('all good');
    expect(notes).toEqual(['step one', 'step two']);
  });

  it('returns exit:"budget" when simulated spend exceeds the mandate budget', async () => {
    const runner = new FakeLaneRunner({ spend: { tokens: 5_000 } });
    const report = await runner.run(mandate({ budget: { maxTokens: 1_000 } }));
    expect(report.exit).toBe('budget');
    expect(report.summary).toContain('maxTokens');
  });

  it('returns exit:"aborted" when the signal is already aborted', async () => {
    const report = await new FakeLaneRunner({ progress: [{ note: 'x' }] }).run(mandate(), {
      signal: AbortSignal.abort(),
    });
    expect(report.exit).toBe('aborted');
  });
});

describe('ClaudeCodeLaneRunner', () => {
  it('refuses real execution by default', async () => {
    await expect(new ClaudeCodeLaneRunner().run(mandate())).rejects.toBeInstanceOf(LaneSafetyError);
  });

  it('runs through an injected process runner with a scrubbed env', async () => {
    let seenEnv: Record<string, string> = {};
    const fake: ProcessRunner = {
      run(opts: ProcessSpawnOptions) {
        seenEnv = opts.env;
        return Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify({ summary: 'did it', usage: { inputTokens: 5, outputTokens: 7 } }),
          stderr: '',
        });
      },
    };
    const runner = new ClaudeCodeLaneRunner({
      processRunner: fake,
      baseEnv: { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-ant-leak', GITHUB_TOKEN: 'ghp_leak' },
    });
    const report = await runner.run(mandate());
    expect(report.exit).toBe('done');
    expect(report.summary).toBe('did it');
    expect(report.usage).toMatchObject({ inputTokens: 5, outputTokens: 7 });
    expect(seenEnv.PATH).toBe('/bin');
    expect(seenEnv.ANTHROPIC_API_KEY).toBeUndefined();
    expect(seenEnv.GITHUB_TOKEN).toBeUndefined();
  });

  it('returns exit:"budget" when reported usage exceeds the mandate budget', async () => {
    const fake: ProcessRunner = {
      run() {
        return Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify({ usage: { inputTokens: 5_000, outputTokens: 5_000 } }),
          stderr: '',
        });
      },
    };
    const runner = new ClaudeCodeLaneRunner({ processRunner: fake, baseEnv: {} });
    const report = await runner.run(mandate({ budget: { maxTokens: 1_000 } }));
    expect(report.exit).toBe('budget');
  });

  it('returns exit:"partial" on a non-zero process exit', async () => {
    const fake: ProcessRunner = {
      run() {
        return Promise.resolve({ exitCode: 2, stdout: '', stderr: 'boom' });
      },
    };
    const runner = new ClaudeCodeLaneRunner({ processRunner: fake, baseEnv: {} });
    const report = await runner.run(mandate());
    expect(report.exit).toBe('partial');
  });
});
