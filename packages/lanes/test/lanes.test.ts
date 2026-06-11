import { type LaneMandate, laneMandateSchema, newId } from '@amrita/protocol';
import { describe, expect, it } from 'vitest';
import {
  BudgetGuard,
  ClaudeCodeLaneRunner,
  DEFAULT_ENV_ALLOWLIST,
  FakeLaneRunner,
  LaneSafetyError,
  type ProcessResult,
  type ProcessRunner,
  type ProcessSpawnOptions,
  ResearchLaneRunner,
  createNodeProcessRunner,
  evaluateBudget,
  isForbiddenEnvName,
  isWithinRoots,
  normalizeClaudeUsage,
  parseStreamJsonLine,
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

/** A capturing fake process runner returning a fixed result. */
function captureRunner(result: Partial<ProcessResult> = {}): {
  runner: ProcessRunner;
  calls: ProcessSpawnOptions[];
} {
  const calls: ProcessSpawnOptions[] = [];
  const runner: ProcessRunner = {
    run(opts) {
      calls.push(opts);
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', ...result });
    },
  };
  return { runner, calls };
}

/** A fake process runner that streams the given lines via onStdout then exits 0. */
function streamingRunner(lines: string[]): ProcessRunner {
  return {
    run(opts) {
      const stdout = lines.join('\n');
      opts.onStdout?.(`${stdout}\n`);
      return Promise.resolve({ exitCode: 0, stdout, stderr: '' });
    },
  };
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
    DB_PASSPHRASE: 'p',
    VAULT_ADDR: 'http://x',
    BEARER_HEADER: 'b',
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
      'DB_PASSPHRASE',
      'VAULT_ADDR',
      'BEARER_HEADER',
      'SESSION_COOKIE',
    ]) {
      expect(env[forbidden]).toBeUndefined();
    }
    expect(JSON.stringify(env)).not.toMatch(/leak|hunter2/);
  });

  it('never forwards a forbidden var even if explicitly allowlisted', () => {
    const env = scrubEnv(base, ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'VAULT_ADDR']);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.VAULT_ADDR).toBeUndefined();
  });

  it('forwards a benign allowlisted var when present', () => {
    const env = scrubEnv({ ...base, MY_FLAG: 'on' }, ['MY_FLAG']);
    expect(env.MY_FLAG).toBe('on');
  });

  it('recognises secret-shaped names and keeps the default allowlist clean of them', () => {
    expect(isForbiddenEnvName('ANTHROPIC_API_KEY')).toBe(true);
    expect(isForbiddenEnvName('DB_PASSPHRASE')).toBe(true);
    expect(isForbiddenEnvName('PATH')).toBe(false);
    expect(DEFAULT_ENV_ALLOWLIST.some(isForbiddenEnvName)).toBe(false);
  });
});

describe('budget accounting', () => {
  it('flags the first bound exceeded', () => {
    expect(evaluateBudget({ maxTurns: 2 }, { turns: 3 })).toBe('maxTurns');
    expect(evaluateBudget({ maxTokens: 100 }, { tokens: 101 })).toBe('maxTokens');
    expect(evaluateBudget({ maxUsd: 1 }, { usd: 2 })).toBe('maxUsd');
    expect(evaluateBudget({ maxMinutes: 1 }, { elapsedMs: 61_000 })).toBe('maxMinutes');
    expect(evaluateBudget({ maxTokens: 100 }, { tokens: 100 })).toBeNull();
  });

  it('accumulates turns with an injected clock', () => {
    let t = 1_000;
    const guard = new BudgetGuard({ maxTurns: 2 }, () => t);
    guard.recordTurn({ inputTokens: 1, outputTokens: 1 });
    expect(guard.exceeded()).toBeNull();
    guard.recordTurn();
    guard.recordTurn();
    expect(guard.exceeded()).toBe('maxTurns');
    t = 1_000_000;
  });
});

describe('stream-json parser', () => {
  it('tolerates blank and non-JSON lines', () => {
    expect(parseStreamJsonLine('')).toBeNull();
    expect(parseStreamJsonLine('not json at all')).toBeNull();
    expect(parseStreamJsonLine('{ truncated')).toBeNull();
    expect(parseStreamJsonLine('42')).toBeNull();
  });

  it('extracts assistant turns and a final result with usage', () => {
    const a = parseStreamJsonLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hi there' }] },
      }),
    );
    expect(a).toMatchObject({ turn: true });
    expect(a?.note).toContain('hi there');

    const r = parseStreamJsonLine(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'all done',
        usage: { input_tokens: 10, output_tokens: 20 },
        total_cost_usd: 0.01,
      }),
    );
    expect(r).toMatchObject({ isResult: true, summary: 'all done' });
    expect(r?.usage).toMatchObject({ inputTokens: 10, outputTokens: 20, usd: 0.01 });
  });

  it('normalizes snake_case usage', () => {
    expect(normalizeClaudeUsage({ input_tokens: 3, output_tokens: 4 }, 0.5)).toEqual({
      inputTokens: 3,
      outputTokens: 4,
      usd: 0.5,
    });
    expect(normalizeClaudeUsage(undefined)).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe('workspace confinement (isWithinRoots)', () => {
  it('accepts a path at or inside a root and rejects outside', () => {
    expect(isWithinRoots('/work/proj', ['/work/proj'])).toBe(true);
    expect(isWithinRoots('/work/proj/src/a.ts', ['/work/proj'])).toBe(true);
    expect(isWithinRoots('/work/other', ['/work/proj'])).toBe(false);
    expect(isWithinRoots('/etc/passwd', ['/work/proj', '/work/two'])).toBe(false);
  });
});

describe('FakeLaneRunner', () => {
  it('runs to a done report and emits progress', async () => {
    const notes: string[] = [];
    const runner = new FakeLaneRunner({
      progress: [{ note: 'one' }, { note: 'two' }],
      summary: 'all good',
    });
    const m = mandate();
    const report = await runner.run(m, { onProgress: (n) => notes.push(n) });
    expect(report.exit).toBe('done');
    expect(report.laneId).toBe(m.laneId);
    expect(report.summary).toBe('all good');
    expect(notes).toEqual(['one', 'two']);
  });

  it('returns exit:"budget" when simulated spend exceeds the mandate budget', async () => {
    const runner = new FakeLaneRunner({ spend: { tokens: 5_000 } });
    const report = await runner.run(mandate({ budget: { maxTokens: 1_000 } }));
    expect(report.exit).toBe('budget');
  });

  it('returns exit:"cancelled" when the signal is already aborted', async () => {
    const report = await new FakeLaneRunner({ progress: [{ note: 'x' }] }).run(mandate(), {
      signal: AbortSignal.abort(),
    });
    expect(report.exit).toBe('cancelled');
  });

  it('blocks until cancelled, then reports cancelled', async () => {
    const controller = new AbortController();
    const runner = new FakeLaneRunner({ block: true });
    const promise = runner.run(mandate(), { signal: controller.signal });
    controller.abort();
    expect((await promise).exit).toBe('cancelled');
  });
});

describe('ClaudeCodeLaneRunner', () => {
  it('refuses real execution by default', async () => {
    await expect(new ClaudeCodeLaneRunner().run(mandate())).rejects.toBeInstanceOf(LaneSafetyError);
  });

  it('runs through an injected runner with a scrubbed env (no secrets)', async () => {
    const { runner, calls } = captureRunner({
      stdout: JSON.stringify({ summary: 'did it', usage: { inputTokens: 5, outputTokens: 7 } }),
    });
    const lane = new ClaudeCodeLaneRunner({
      processRunner: runner,
      baseEnv: { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-ant-leak', GITHUB_TOKEN: 'ghp_leak' },
    });
    const report = await lane.run(mandate());
    expect(report.exit).toBe('done');
    expect(report.summary).toBe('did it');
    expect(calls[0]?.env.PATH).toBe('/bin');
    expect(calls[0]?.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(calls[0]?.env.GITHUB_TOKEN).toBeUndefined();
  });

  it('builds stream-json args with a single goal arg (no shell interpolation)', async () => {
    const { runner, calls } = captureRunner({ stdout: '{}' });
    const lane = new ClaudeCodeLaneRunner({
      processRunner: runner,
      outputFormat: 'stream-json',
      allowedTools: ['Read', 'Grep'],
    });
    const evil = 'fix it; rm -rf / && echo $SECRET';
    await lane.run(mandate({ goal: evil, budget: { maxTurns: 5 } }));
    const args = calls[0]?.args ?? [];
    expect(args).toEqual([
      '--print',
      evil, // the whole goal is ONE argv entry — never a shell string
      '--output-format',
      'stream-json',
      '--verbose',
      '--max-turns',
      '5',
      '--allowedTools',
      'Read,Grep',
    ]);
  });

  it('refuses a cwd outside the allowed workspace roots', async () => {
    const { runner, calls } = captureRunner();
    const lane = new ClaudeCodeLaneRunner({ processRunner: runner, allowedRoots: ['/work/proj'] });
    const report = await lane.run(mandate({ scope: { paths: ['/etc'], network: 'none' } }));
    expect(report.exit).toBe('aborted');
    expect(report.summary).toContain('confinement');
    expect(calls).toHaveLength(0); // never spawned
  });

  it('accepts a cwd inside an allowed root', async () => {
    const { runner, calls } = captureRunner({ stdout: '{}' });
    const lane = new ClaudeCodeLaneRunner({ processRunner: runner, allowedRoots: ['/work/proj'] });
    const report = await lane.run(
      mandate({ scope: { paths: ['/work/proj/sub'], network: 'none' } }),
    );
    expect(report.exit).toBe('done');
    expect(calls[0]?.cwd).toBe('/work/proj/sub');
  });

  it('parses stream-json progress and a final usage/summary', async () => {
    const notes: string[] = [];
    const lane = new ClaudeCodeLaneRunner({
      processRunner: streamingRunner([
        JSON.stringify({ type: 'system', subtype: 'init' }),
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'working' }] },
        }),
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          result: 'finished',
          usage: { input_tokens: 8, output_tokens: 9 },
        }),
      ]),
      outputFormat: 'stream-json',
    });
    const report = await lane.run(mandate(), { onProgress: (n) => notes.push(n) });
    expect(report.exit).toBe('done');
    expect(report.summary).toBe('finished');
    expect(report.usage).toMatchObject({ inputTokens: 8, outputTokens: 9 });
    expect(notes.some((n) => n.includes('working'))).toBe(true);
  });

  it('does not crash on malformed stream-json lines', async () => {
    const lane = new ClaudeCodeLaneRunner({
      processRunner: streamingRunner(['not json', '{ broken', '']),
      outputFormat: 'stream-json',
    });
    const report = await lane.run(mandate());
    expect(report.exit).toBe('done');
    expect(report.usage).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });

  it('aborts on a turn-budget overrun and reports exit:"budget"', async () => {
    const lane = new ClaudeCodeLaneRunner({
      processRunner: streamingRunner([
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 't1' }] } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 't2' }] } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 't3' }] } }),
      ]),
      outputFormat: 'stream-json',
    });
    const report = await lane.run(mandate({ budget: { maxTurns: 2 } }));
    expect(report.exit).toBe('budget');
    expect(report.summary).toContain('maxTurns');
  });

  it('maps a process timeout to exit:"budget"', async () => {
    const lane = new ClaudeCodeLaneRunner({
      processRunner: {
        run: () => Promise.resolve({ exitCode: -1, stdout: '', stderr: '', timedOut: true }),
      },
    });
    const report = await lane.run(mandate({ budget: { maxMinutes: 1 } }));
    expect(report.exit).toBe('budget');
  });

  it('reports exit:"cancelled" when the caller cancels mid-run', async () => {
    const controller = new AbortController();
    const blockingRunner: ProcessRunner = {
      run: (opts) =>
        new Promise((resolve) => {
          opts.signal?.addEventListener('abort', () =>
            resolve({ exitCode: -1, stdout: '', stderr: '', signal: 'SIGTERM' }),
          );
        }),
    };
    const lane = new ClaudeCodeLaneRunner({ processRunner: blockingRunner });
    const promise = lane.run(mandate(), { signal: controller.signal });
    controller.abort();
    expect((await promise).exit).toBe('cancelled');
  });

  it('returns exit:"partial" on a non-zero process exit', async () => {
    const { runner } = captureRunner({ exitCode: 2, stderr: 'boom' });
    const report = await new ClaudeCodeLaneRunner({ processRunner: runner }).run(mandate());
    expect(report.exit).toBe('partial');
  });
});

describe('createNodeProcessRunner (real spawn, no Claude)', () => {
  it('runs a real harmless process and captures stdout', async () => {
    const runner = createNodeProcessRunner();
    const res = await runner.run({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("hi")'],
      env: scrubEnv(process.env),
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('hi');
  });

  it('terminates a long process on timeout and marks timedOut', async () => {
    const runner = createNodeProcessRunner();
    const res = await runner.run({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      env: scrubEnv(process.env),
      timeoutMs: 300,
    });
    expect(res.timedOut).toBe(true);
  });

  it('refuses a cwd outside allowed roots before spawning', async () => {
    const runner = createNodeProcessRunner({ allowedRoots: ['/tmp/amrita-allowed'] });
    await expect(
      runner.run({ command: process.execPath, args: ['-e', ''], env: {}, cwd: '/etc' }),
    ).rejects.toThrow(/allowed/);
  });
});

describe('ResearchLaneRunner (ADR-0023)', () => {
  const mandate = laneMandateSchema.parse({
    laneId: newId(),
    goal: 'compare sqlite fts5 ranking options',
    contextPack: {},
    scope: {},
  });

  const FINDINGS = [
    { title: 'FTS5 docs', url: 'https://sqlite.org/fts5.html', snippet: 'bm25' },
    { title: 'Ranking deep-dive', url: 'https://example.com/fts-ranking' },
  ];

  it('without a provider: aborts with an honest needs-setup summary (no fake search)', async () => {
    const runner = new ResearchLaneRunner();
    const report = await runner.run(mandate);
    expect(report.exit).toBe('aborted');
    expect(report.summary).toContain('no search provider is configured');
    expect(report.followUps).toEqual([]);
  });

  it('with an injected provider: searches the goal and reports sources as follow-ups', async () => {
    const queries: string[] = [];
    const runner = new ResearchLaneRunner({
      provider: {
        id: 'fake',
        search: async (q) => {
          queries.push(q);
          return FINDINGS;
        },
      },
    });
    const notes: string[] = [];
    const report = await runner.run(mandate, { onProgress: (n) => notes.push(n) });
    expect(queries).toEqual([mandate.goal]);
    expect(report.exit).toBe('done');
    expect(report.summary).toContain('2 source(s) via fake');
    expect(report.followUps).toEqual([
      'FTS5 docs — https://sqlite.org/fts5.html',
      'Ranking deep-dive — https://example.com/fts-ranking',
    ]);
    expect(notes.some((n) => n.includes('searching via fake'))).toBe(true);
  });

  it('empty results are an honest partial, and provider failures abort value-free', async () => {
    const empty = new ResearchLaneRunner({ provider: { id: 'fake', search: async () => [] } });
    const emptyReport = await empty.run(mandate);
    expect(emptyReport.exit).toBe('partial');
    expect(emptyReport.summary).toContain('no sources found');

    const failing = new ResearchLaneRunner({
      provider: {
        id: 'fake',
        search: async () => {
          throw new Error('HTTP 500: secret-bearing body that must not leak');
        },
      },
    });
    const failReport = await failing.run(mandate);
    expect(failReport.exit).toBe('aborted');
    expect(failReport.summary).not.toContain('secret-bearing'); // name only, never the message
  });

  it('cooperative cancellation reports cancelled', async () => {
    const controller = new AbortController();
    const runner = new ResearchLaneRunner({
      provider: {
        id: 'fake',
        search: async () => {
          controller.abort();
          return FINDINGS;
        },
      },
    });
    const report = await runner.run(mandate, { signal: controller.signal });
    expect(report.exit).toBe('cancelled');
  });
});
