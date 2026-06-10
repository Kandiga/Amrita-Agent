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
    expect(r.out).toContain('schema v3');
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
    expect(json<{ schemaVersion: number }>(h).schemaVersion).toBe(3);
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
