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
function cli(args: string[]): Captured {
  let out = '';
  let err = '';
  const code = run([...args, '--db', dbPath], {
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
  it('health works on a temp DB', () => {
    const r = cli(['health']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('amritad');
    expect(r.out).toContain('schema v2');
  });

  it('project ensure + list', () => {
    expect(cli(['project', 'ensure', 'crm', '--name', 'Secure CRM']).code).toBe(0);
    expect(cli(['project', 'ensure', 'crm']).out).toContain('crm'); // idempotent
    const list = cli(['project', 'list']);
    expect(list.code).toBe(0);
    expect(list.out).toContain('crm');
  });

  it('conversation create + tree', () => {
    cli(['project', 'ensure', 'crm']);
    const conv = json<{ id: string }>(
      cli(['conversation', 'create', '--project', 'crm', '--json']),
    );
    const tree = cli(['conversation', 'tree', conv.id]);
    expect(tree.code).toBe(0);
    expect(tree.out).toContain(conv.id);
  });

  it('user message records and is reflected in health counts', () => {
    cli(['project', 'ensure', 'crm']);
    const conv = json<{ id: string }>(
      cli(['conversation', 'create', '--project', 'crm', '--json']),
    );
    const msg = cli(['message', 'user', conv.id, 'hello amrita']);
    expect(msg.code).toBe(0);
    expect(msg.out).toContain('recorded message');
    const h = json<{ counts: { messages: number; events: number } }>(cli(['health', '--json']));
    expect(h.counts.messages).toBeGreaterThanOrEqual(1);
    expect(h.counts.events).toBeGreaterThanOrEqual(1);
  });

  it('task create / list / complete', () => {
    cli(['project', 'ensure', 'crm']);
    const t = json<{ taskId: string }>(
      cli(['task', 'create', '--project', 'crm', '--title', 'fix bug', '--json']),
    );
    expect(cli(['task', 'list', '--project', 'crm']).out).toContain('fix bug');
    expect(cli(['task', 'complete', t.taskId]).out).toContain('completed');
    const list = json<{ status: string }[]>(cli(['task', 'list', '--project', 'crm', '--json']));
    expect(list[0]?.status).toBe('done');
  });

  it('decision record', () => {
    cli(['project', 'ensure', 'crm']);
    const d = cli(['decision', 'record', '--project', 'crm', '--text', 'use SQLite + WAL']);
    expect(d.code).toBe(0);
    expect(d.out).toContain('decision');
  });

  it('memory put + search via FTS', () => {
    cli(['project', 'ensure', 'crm']);
    cli([
      'memory',
      'put',
      '--scope',
      'project',
      '--project',
      'crm',
      '--content',
      'RTL bidi export',
    ]);
    const hits = json<{ content: string }[]>(cli(['memory', 'search', 'bidi', '--json']));
    expect(hits).toHaveLength(1);
    expect(hits[0]?.content).toContain('RTL');
    // user-scope memory needs no project
    expect(cli(['memory', 'put', '--scope', 'user', '--content', 'global pref']).code).toBe(0);
  });

  it('account connect / bind-secret / status never print a secret value', () => {
    const acc = json<{ accountId: string }>(
      cli(['account', 'connect', '--provider', 'anthropic', '--label', 'work', '--json']),
    );
    const bind = cli(['account', 'bind-secret', acc.accountId, 'ANTHROPIC_API_KEY']);
    expect(bind.code).toBe(0);
    expect(bind.out).toContain('ANTHROPIC_API_KEY'); // an env NAME, safe
    const status = cli(['account', 'status', acc.accountId]);
    expect(status.out).toBe('status: healthy');
    // nothing across these printed a secret-shaped value
    expect(`${acc.accountId}${bind.out}${status.out}`).not.toMatch(/sk-[a-z]/i);
  });

  it('rejects a bad env-name with a non-zero exit and safe error', () => {
    const acc = json<{ accountId: string }>(
      cli(['account', 'connect', '--provider', 'openai', '--json']),
    );
    const bad = cli(['account', 'bind-secret', acc.accountId, 'not-an-env-name']);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('env-var');
    expect(bad.err).not.toMatch(/\bat \//); // no stack trace
  });

  it('--json emits structured output and errors', () => {
    const h = cli(['health', '--json']);
    expect(json<{ schemaVersion: number }>(h).schemaVersion).toBe(2);
    const bad = cli(['bogus', 'command', '--json']);
    expect(bad.code).toBe(2);
    expect(JSON.parse(bad.err).error.code).toBe('unknown_command');
  });

  it('chat runs a mock turn and prints the assistant reply', () => {
    cli(['project', 'ensure', 'crm']);
    const r = cli(['chat', 'fix the PDF export bug', '--project', 'crm']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('[mock:');
    expect(r.out).toContain('PDF export');
    expect(r.out).toContain('tok'); // metadata line
    const j = json<{ provider: string; text: string }>(
      cli(['chat', 'hello', '--project', 'crm', '--json']),
    );
    expect(j.provider).toBe('mock');
    expect(j.text).toContain('hello');
  });

  it('provider list shows mock available and scaffolds unavailable (no secrets)', () => {
    const r = cli(['provider', 'list']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('mock\tavailable');
    expect(r.out).toContain('anthropic');
    expect(r.out).toContain('unavailable');
    expect(r.out).not.toMatch(/sk-[a-z]/i);
  });

  it('chat with an unavailable provider fails non-zero, safely', () => {
    cli(['project', 'ensure', 'crm']);
    const r = cli(['chat', 'hi', '--project', 'crm', '--provider', 'anthropic']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('not implemented');
    expect(r.err).not.toMatch(/sk-[a-z]/i);
  });

  it('usage errors exit non-zero', () => {
    expect(cli(['task', 'create', '--project', 'crm']).code).toBe(2); // missing --title
    // missing --db entirely
    let err = '';
    const code = run(['health'], {
      out: () => {},
      err: (l) => {
        err += l;
      },
    });
    expect(code).toBe(2);
    expect(err).toContain('--db');
  });
});
