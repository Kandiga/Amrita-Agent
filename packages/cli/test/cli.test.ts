import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/run.ts';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'amrita-cli-'));
  dbPath = join(dir, 'amrita.db');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Captured {
  code: number;
  out: string;
  err: string;
}
async function cli(args: string[]): Promise<Captured> {
  let out = '';
  let err = '';
  const code = await run([...args, '--db', dbPath], {
    out: (l) => {
      out += `${l}\n`;
    },
    err: (l) => {
      err += `${l}\n`;
    },
  });
  return { code, out: out.trim(), err: err.trim() };
}
function json<T>(c: Captured): T {
  return JSON.parse(c.out) as T;
}

describe('amrita CLI', () => {
  it('health works on a temp DB', async () => {
    const r = await cli(['health']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('amritad');
    expect(r.out).toContain('schema v4');
  });

  it('doctor renders grouped sections with marks and a numbered fix footer', async () => {
    const r = await cli(['doctor']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('◆ store');
    expect(r.out).toContain('◆ providers');
    expect(r.out).toContain('✓ mock provider');
    expect(r.out).toContain('! anthropic provider');
    expect(r.out).toContain('Run these to fix:');
    expect(r.out).toMatch(/ {2}1\. /);
    expect(r.out).toContain('doctor: ok with warnings');
    // --json returns the structured report
    const j = json<{ ok: boolean; sections: { title: string }[] }>(await cli(['doctor', '--json']));
    expect(j.ok).toBe(true);
    expect(j.sections.map((s) => s.title)).toContain('channels');
  });

  it('project ensure + list', async () => {
    expect((await cli(['project', 'ensure', 'crm', '--name', 'Secure CRM'])).code).toBe(0);
    expect((await cli(['project', 'ensure', 'crm'])).out).toContain('crm'); // idempotent
    const list = await cli(['project', 'list']);
    expect(list.code).toBe(0);
    expect(list.out).toContain('crm');
  });

  it('conversation create + tree', async () => {
    await cli(['project', 'ensure', 'crm']);
    const conv = json<{ id: string }>(
      await cli(['conversation', 'create', '--project', 'crm', '--json']),
    );
    const tree = await cli(['conversation', 'tree', conv.id]);
    expect(tree.code).toBe(0);
    expect(tree.out).toContain(conv.id);
  });

  it('user message records and is reflected in health counts', async () => {
    await cli(['project', 'ensure', 'crm']);
    const conv = json<{ id: string }>(
      await cli(['conversation', 'create', '--project', 'crm', '--json']),
    );
    const msg = await cli(['message', 'user', conv.id, 'hello amrita']);
    expect(msg.code).toBe(0);
    expect(msg.out).toContain('recorded message');
    const h = json<{ counts: { messages: number; events: number } }>(
      await cli(['health', '--json']),
    );
    expect(h.counts.messages).toBeGreaterThanOrEqual(1);
    expect(h.counts.events).toBeGreaterThanOrEqual(1);
  });

  it('task create / list / complete', async () => {
    await cli(['project', 'ensure', 'crm']);
    const t = json<{ taskId: string }>(
      await cli(['task', 'create', '--project', 'crm', '--title', 'fix bug', '--json']),
    );
    expect((await cli(['task', 'list', '--project', 'crm'])).out).toContain('fix bug');
    expect((await cli(['task', 'complete', t.taskId])).out).toContain('completed');
    const list = json<{ status: string }[]>(
      await cli(['task', 'list', '--project', 'crm', '--json']),
    );
    expect(list[0]?.status).toBe('done');
  });

  it('companion: brief set/get, question + risk lifecycles, milestones, timeline', async () => {
    await cli(['project', 'ensure', 'crm']);
    // brief: honest empty, then set + get
    expect((await cli(['brief', 'get', '--project', 'crm'])).out).toContain('no brief yet');
    expect(
      (
        await cli([
          'brief',
          'set',
          '--project',
          'crm',
          '--goal',
          'ship the CRM',
          '--criteria',
          'login works;export works',
          '--scope',
          'web app',
          '--no-scope',
          'mobile',
        ])
      ).code,
    ).toBe(0);
    const brief = await cli(['brief', 'get', '--project', 'crm']);
    expect(brief.out).toContain('goal: ship the CRM');
    expect(brief.out).toContain('login works · export works');
    expect(brief.out).toContain('out of scope: mobile');

    // question: open → resolve requires evidence → resolve with note
    const q = json<{ questionId: string }>(
      await cli(['question', 'open', 'which auth provider?', '--project', 'crm', '--json']),
    );
    const noEvidence = await cli(['question', 'resolve', q.questionId, '--project', 'crm']);
    expect(noEvidence.code).toBe(2); // usage error: a note or decision is required
    expect(
      (
        await cli([
          'question',
          'resolve',
          q.questionId,
          '--project',
          'crm',
          '--note',
          'magic links',
        ])
      ).code,
    ).toBe(0);
    expect((await cli(['question', 'list', '--project', 'crm'])).out).toContain('[resolved]');

    // risk: open with severity → drop with reason
    const r = json<{ riskId: string }>(
      await cli(['risk', 'open', 'data loss', '--project', 'crm', '--severity', 'high', '--json']),
    );
    expect((await cli(['risk', 'list', '--project', 'crm'])).out).toContain('(high) data loss');
    await cli(['risk', 'drop', r.riskId, '--project', 'crm', '--reason', 'mitigated by WAL']);
    expect((await cli(['risk', 'list', '--project', 'crm'])).out).toContain('[dropped]');

    // milestone: create → complete
    const m = json<{ milestoneId: string }>(
      await cli([
        'milestone',
        'create',
        '--project',
        'crm',
        '--title',
        'Alpha',
        '--target',
        '2026-07-01',
        '--json',
      ]),
    );
    expect((await cli(['milestone', 'list', '--project', 'crm'])).out).toContain(
      '[planned] Alpha (→ 2026-07-01)',
    );
    await cli(['milestone', 'complete', m.milestoneId, '--project', 'crm']);
    expect((await cli(['milestone', 'list', '--project', 'crm'])).out).toContain('[done] Alpha');

    // timeline: newest first, derived from the log
    const timeline = await cli(['timeline', '--project', 'crm', '--limit', '5']);
    expect(timeline.code).toBe(0);
    expect(timeline.out.split('\n')[0]).toContain('milestone.completed');
    expect(timeline.out).toContain('milestone.created');
  });

  it('decision record', async () => {
    await cli(['project', 'ensure', 'crm']);
    const d = await cli(['decision', 'record', '--project', 'crm', '--text', 'use SQLite + WAL']);
    expect(d.code).toBe(0);
    expect(d.out).toContain('decision');
  });

  it('memory put + search via FTS', async () => {
    await cli(['project', 'ensure', 'crm']);
    await cli([
      'memory',
      'put',
      '--scope',
      'project',
      '--project',
      'crm',
      '--content',
      'RTL bidi export',
    ]);
    const hits = json<{ content: string }[]>(await cli(['memory', 'search', 'bidi', '--json']));
    expect(hits).toHaveLength(1);
    expect(hits[0]?.content).toContain('RTL');
    expect((await cli(['memory', 'put', '--scope', 'user', '--content', 'global pref'])).code).toBe(
      0,
    );
  });

  it('account connect / bind-secret / status never print a secret value', async () => {
    const acc = json<{ accountId: string }>(
      await cli(['account', 'connect', '--provider', 'anthropic', '--label', 'work', '--json']),
    );
    const bind = await cli(['account', 'bind-secret', acc.accountId, 'ANTHROPIC_API_KEY']);
    expect(bind.code).toBe(0);
    expect(bind.out).toContain('ANTHROPIC_API_KEY'); // an env NAME, safe
    const status = await cli(['account', 'status', acc.accountId]);
    expect(status.out).toBe('status: healthy');
    expect(`${acc.accountId}${bind.out}${status.out}`).not.toMatch(/sk-[a-z]/i);
  });

  it('rejects a bad env-name with a non-zero exit and safe error', async () => {
    const acc = json<{ accountId: string }>(
      await cli(['account', 'connect', '--provider', 'openai', '--json']),
    );
    const bad = await cli(['account', 'bind-secret', acc.accountId, 'not-an-env-name']);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('env-var');
    expect(bad.err).not.toMatch(/\bat \//); // no stack trace
  });

  it('--json emits structured output and errors', async () => {
    const h = await cli(['health', '--json']);
    expect(json<{ schemaVersion: number }>(h).schemaVersion).toBe(4);
    const bad = await cli(['bogus', 'command', '--json']);
    expect(bad.code).toBe(2);
    expect(JSON.parse(bad.err).error.code).toBe('unknown_command');
  });

  it('chat runs a mock turn and prints the assistant reply', async () => {
    await cli(['project', 'ensure', 'crm']);
    const r = await cli(['chat', 'fix the PDF export bug', '--project', 'crm']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('[mock:');
    expect(r.out).toContain('PDF export');
    expect(r.out).toContain('tok'); // metadata line
    const j = json<{ provider: string; text: string }>(
      await cli(['chat', 'hello', '--project', 'crm', '--json']),
    );
    expect(j.provider).toBe('mock');
    expect(j.text).toContain('hello');
  });

  it('provider list shows mock available and real providers unconfigured (no secrets)', async () => {
    const r = await cli(['provider', 'list']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('mock\tavailable');
    expect(r.out).toContain('anthropic');
    expect(r.out).toContain('unavailable');
    expect(r.out).not.toMatch(/sk-[a-z]/i);
  });

  it('role set / list / clear binds providers to roles, chat --role uses them', async () => {
    await cli(['project', 'ensure', 'crm']);
    // unbound: everything resolves via auto (mock — nothing real configured)
    const before = await cli(['role', 'list']);
    expect(before.code).toBe(0);
    expect(before.out).toMatch(/main\t→ mock\t\[auto\]/);

    expect((await cli(['role', 'set', 'main', 'mock'])).code).toBe(0);
    const after = await cli(['role', 'list']);
    expect(after.out).toMatch(/main\t→ mock\t\[binding\]/);

    // a role turn works end-to-end (mock binding)
    const turn = json<{ provider: string; role: string }>(
      await cli(['chat', 'route me', '--project', 'crm', '--role', 'main', '--json']),
    );
    expect(turn.provider).toBe('mock');
    expect(turn.role).toBe('main');

    expect((await cli(['role', 'clear', 'main'])).out).toContain('main → auto');
    expect((await cli(['role', 'list'])).out).toMatch(/main\t→ mock\t\[auto\]/);

    // guard rails: unknown provider / bad role are usage errors
    expect((await cli(['role', 'set', 'main', 'nope'])).code).toBe(2);
    expect((await cli(['role', 'set', 'galactic', 'mock'])).code).toBe(2);
  });

  it('chat with an unconfigured real provider fails non-zero, safely', async () => {
    await cli(['project', 'ensure', 'crm']);
    const r = await cli(['chat', 'hi', '--project', 'crm', '--provider', 'anthropic']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('no configured account');
    expect(r.err).not.toMatch(/sk-[a-z]/i);
  });

  it('channel list + pairing create/list', async () => {
    await cli(['project', 'ensure', 'crm']);
    const list = await cli(['channel', 'list']);
    expect(list.code).toBe(0);
    expect(list.out).toContain('telegram');
    // honest readiness: web is served by the daemon, telegram needs setup
    expect(list.out).toMatch(/web\tready/);
    expect(list.out).toMatch(/telegram\tneeds_setup/);
    const channels = json<{ id: string; ready: boolean }[]>(
      await cli(['channel', 'list', '--json']),
    );
    expect(channels.find((c) => c.id === 'web')?.ready).toBe(true);
    expect(channels.find((c) => c.id === 'telegram')?.ready).toBe(false);
    const pair = json<{ code: string }>(
      await cli(['channel', 'pair', '--project', 'crm', '--channel', 'telegram', '--json']),
    );
    expect(pair.code).toBeTypeOf('string');
    const pairings = await cli(['channel', 'pairings', '--channel', 'telegram']);
    expect(pairings.out).toContain(pair.code);
    expect(pairings.out).toContain('unclaimed');
    expect(`${pair.code}${pairings.out}`).not.toMatch(/sk-[a-z]/i);
  });

  it('lane start --dry-run records a mandate and lane list shows it', async () => {
    await cli(['project', 'ensure', 'crm']);
    const started = json<{ laneId: string; status: string; dryRun: boolean }>(
      await cli([
        'lane',
        'start',
        '--project',
        'crm',
        '--goal',
        'tidy the repo',
        '--dry-run',
        '--json',
      ]),
    );
    expect(started.dryRun).toBe(true);
    expect(started.status).toBe('spawned');
    const list = await cli(['lane', 'list', '--project', 'crm']);
    expect(list.code).toBe(0);
    expect(list.out).toContain('spawned');
    expect(list.out).toContain('tidy the repo');
    expect(list.out).toContain(started.laneId);
  });

  it('lane start without --dry-run ends safely as aborted (no real exec)', async () => {
    await cli(['project', 'ensure', 'crm']);
    const r = json<{ status: string; error?: string }>(
      await cli(['lane', 'start', '--project', 'crm', '--goal', 'do real work', '--json']),
    );
    expect(r.status).toBe('aborted');
    expect(r.error).toMatch(/disabled/);
  });

  it('lane start --real without daemon opt-in aborts with a clear message', async () => {
    await cli(['project', 'ensure', 'crm']);
    const r = json<{ status: string; error?: string }>(
      await cli(['lane', 'start', '--project', 'crm', '--goal', 'real work', '--real', '--json']),
    );
    expect(r.status).toBe('aborted');
    expect(r.error).toMatch(/disabled/);
  });

  it('health shows lane real-execution disabled by default', async () => {
    const h = json<{ lanes: { realExecution: boolean } }>(await cli(['health', '--json']));
    expect(h.lanes.realExecution).toBe(false);
    expect((await cli(['health'])).out).toContain('lanes real-execution disabled');
  });

  it('lane get and lane cancel work on a dry-run lane', async () => {
    await cli(['project', 'ensure', 'crm']);
    const started = json<{ laneId: string }>(
      await cli(['lane', 'start', '--project', 'crm', '--goal', 'tidy', '--dry-run', '--json']),
    );
    const got = await cli(['lane', 'get', started.laneId]);
    expect(got.code).toBe(0);
    expect(got.out).toContain(started.laneId);
    expect(got.out).toContain('spawned');
    // a dry-run lane never ran, so cancel reports it was not active
    const cancel = await cli(['lane', 'cancel', started.laneId]);
    expect(cancel.code).toBe(0);
    expect(cancel.out).toContain('not active');
  });

  it('usage errors exit non-zero', async () => {
    expect((await cli(['task', 'create', '--project', 'crm'])).code).toBe(2); // missing --title
    // missing --db entirely
    let err = '';
    const code = await run(['health'], {
      out: () => {},
      err: (l) => {
        err += l;
      },
    });
    expect(code).toBe(2);
    expect(err).toContain('--db');
  });
});
