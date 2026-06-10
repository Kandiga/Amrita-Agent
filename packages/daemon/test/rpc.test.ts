import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AmritaKernel } from '../src/kernel.ts';
import { METHOD_NAMES, dispatch, isErrorResponse } from '../src/rpc.ts';
import { createStdioServer } from '../src/stdio.ts';

let kernel: AmritaKernel;

beforeEach(() => {
  kernel = AmritaKernel.open({ dbPath: ':memory:' });
});
afterEach(() => {
  kernel.close();
});

async function call(method: string, params?: unknown): Promise<unknown> {
  const r = await dispatch(kernel, { id: 1, method, params });
  if (isErrorResponse(r)) throw new Error(`${method}: ${r.error.code} ${r.error.message}`);
  return r.result;
}

describe('rpc dispatch', () => {
  it('ping and health', async () => {
    expect(await call('ping')).toEqual({ pong: true });
    const h = (await call('health')) as { ok: boolean; schemaVersion: number };
    expect(h.ok).toBe(true);
    expect(h.schemaVersion).toBe(3);
  });

  it('rejects an unknown method', async () => {
    const r = await dispatch(kernel, { id: 1, method: 'nope' });
    expect(isErrorResponse(r) && r.error.code).toBe('unknown_method');
  });

  it('rejects a malformed request', async () => {
    const r1 = await dispatch(kernel, 42); // not an object
    expect(isErrorResponse(r1) && r1.error.code).toBe('invalid_request');
    const r2 = await dispatch(kernel, { params: {} }); // no method
    expect(isErrorResponse(r2) && r2.error.code).toBe('invalid_request');
  });

  it('rejects invalid params with structured details (no values echoed)', async () => {
    const r = await dispatch(kernel, { id: 9, method: 'project.ensure', params: {} });
    expect(isErrorResponse(r)).toBe(true);
    if (isErrorResponse(r)) {
      expect(r.id).toBe(9);
      expect(r.error.code).toBe('invalid_params');
      expect(Array.isArray(r.error.details)).toBe(true);
      const details = r.error.details as { path: string; message: string }[];
      expect(details.some((d) => d.path === 'slug')).toBe(true);
    }
  });

  it('runs the project → conversation → message → events flow', async () => {
    const project = (await call('project.ensure', { slug: 'demo', name: 'Demo' })) as {
      id: string;
    };
    const conv = (await call('conversation.create', { projectId: project.id })) as { id: string };
    const rec = (await call('message.user.record', {
      projectId: project.id,
      conversationId: conv.id,
      text: 'hello',
    })) as { messageId: string };
    const events = (await call('events.list', { conversationId: conv.id })) as unknown[];
    expect(events).toHaveLength(1);
    expect(rec.messageId).toBeTypeOf('string');
  });

  it('runs tasks / decisions / memory / settings over RPC', async () => {
    const p = (await call('project.ensure', { slug: 'd', name: 'D' })) as { id: string };
    const c = (await call('conversation.create', { projectId: p.id })) as { id: string };
    const ctx = { projectId: p.id, conversationId: c.id };

    const t = (await call('tasks.create', { ...ctx, title: 'fix bug' })) as { taskId: string };
    await call('tasks.complete', { ...ctx, taskId: t.taskId });
    expect(((await call('tasks.list', { status: 'done' })) as unknown[]).length).toBe(1);

    const d = (await call('decisions.record', { ...ctx, text: 'use WAL' })) as {
      decisionId: string;
    };
    expect(((await call('decisions.list', { projectId: p.id })) as { id: string }[])[0]?.id).toBe(
      d.decisionId,
    );

    await call('memory.put', { ...ctx, scope: 'project', content: 'pagination notes' });
    expect(((await call('memory.search', { query: 'pagination' })) as unknown[]).length).toBe(1);

    await call('settings.update', { ...ctx, key: 'theme', value: 'dark' });
    expect(await call('settings.get', { key: 'theme' })).toEqual({ value: 'dark' });
  });

  it('account responses never include a secret value; bad env-name → invalid_params', async () => {
    const p = (await call('project.ensure', { slug: 'a', name: 'A' })) as { id: string };
    const c = (await call('conversation.create', { projectId: p.id })) as { id: string };
    const acc = (await call('accounts.connect', {
      projectId: p.id,
      conversationId: c.id,
      provider: 'anthropic',
      authMode: 'api_key',
    })) as { accountId: string };
    await call('accounts.bindSecretRef', {
      accountId: acc.accountId,
      envName: 'ANTHROPIC_API_KEY',
    });

    const accounts = (await call('accounts.list')) as { secretRef: string | null }[];
    expect(accounts[0]?.secretRef).toBe('ANTHROPIC_API_KEY'); // env NAME, not a value
    expect(JSON.stringify(accounts)).not.toMatch(/sk-|password|secret_value/i);
    expect(await call('accounts.configStatus', { accountId: acc.accountId })).toEqual({
      status: 'healthy',
    });

    const bad = await dispatch(kernel, {
      id: 1,
      method: 'accounts.bindSecretRef',
      params: { accountId: acc.accountId, envName: 'not-an-env-name' },
    });
    expect(isErrorResponse(bad) && bad.error.code).toBe('invalid_params');
  });

  it('exposes a stable, documented method list', () => {
    expect(METHOD_NAMES).toContain('ping');
    expect(METHOD_NAMES).toContain('memory.search');
    expect(METHOD_NAMES).toContain('accounts.bindSecretRef');
  });
});

describe('stdio transport', () => {
  it('answers JSON-lines in-process, tolerating blank/invalid lines', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let out = '';
    output.on('data', (c: Buffer) => {
      out += c.toString();
    });
    const done = new Promise<void>((resolve) => {
      createStdioServer(kernel, { input, output, onClose: () => resolve() });
    });
    input.write('{"id":1,"method":"ping"}\n');
    input.write('\n'); // blank ignored
    input.write('not json\n'); // → invalid_request, loop survives
    input.end();
    await done;

    const lines = out
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ id: 1, result: { pong: true } });
    expect(lines[1].error.code).toBe('invalid_request');
  });

  it('the amritad executable answers over stdio and exits cleanly', () => {
    const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'bin', 'amritad.ts');
    const out = execFileSync(process.execPath, [bin, '--db', ':memory:'], {
      input: '{"id":7,"method":"ping"}\n',
      encoding: 'utf8',
    });
    const first = JSON.parse(out.trim().split('\n')[0] ?? '{}');
    expect(first).toEqual({ id: 7, result: { pong: true } });
  });
});
