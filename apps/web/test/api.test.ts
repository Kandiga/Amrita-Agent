import { describe, expect, it } from 'vitest';
import { RpcClient, RpcError } from '../src/api.ts';

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

describe('RpcClient', () => {
  it('posts json-rpc calls through the injected fetch', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = new RpcClient({
      baseUrl: 'http://amrita.local',
      fetchImpl: (async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({ result: { ok: true } });
      }) as typeof fetch,
    });

    await expect(client.call('health')).resolves.toEqual({ ok: true });
    expect(calls[0]?.url).toBe('http://amrita.local/rpc');
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ method: 'health' });
  });

  it('throws structured value-free rpc errors', async () => {
    const client = new RpcClient({
      fetchImpl: (async () =>
        jsonResponse({
          error: { code: 'provider_unavailable', message: 'Provider unavailable' },
        })) as typeof fetch,
    });

    await expect(client.call('chat.turn')).rejects.toMatchObject({ code: 'provider_unavailable' });
    try {
      await client.call('chat.turn');
    } catch (e) {
      expect(e).toBeInstanceOf(RpcError);
      expect(String(e)).not.toMatch(/sk-|secret|token/i);
    }
  });

  it('loads replay events by conversation id and since sequence', async () => {
    const client = new RpcClient({
      baseUrl: '/api',
      fetchImpl: (async (url) => {
        expect(String(url)).toContain('/api/events?conversationId=c1&sinceSeq=7');
        return jsonResponse({
          events: [
            { id: 'e1', seq: 8, ts: 'now', type: 'message.user', payload: { text: 'hello' } },
          ],
        });
      }) as typeof fetch,
    });

    await expect(client.events('c1', 7)).resolves.toHaveLength(1);
  });

  it('sends an Authorization header only once a token is set', async () => {
    const headers: Array<Record<string, string>> = [];
    const client = new RpcClient({
      fetchImpl: (async (_url, init) => {
        headers.push((init?.headers ?? {}) as Record<string, string>);
        return jsonResponse({ result: {} });
      }) as typeof fetch,
    });
    await client.call('health'); // no token yet
    expect(client.hasAuthToken()).toBe(false);
    client.setAuthToken('tok-123');
    await client.call('health'); // token set
    expect(headers[0]?.authorization).toBeUndefined();
    expect(headers[1]?.authorization).toBe('Bearer tok-123');
  });

  it('throws a value-free unauthorized error on 401', async () => {
    const client = new RpcClient({
      fetchImpl: (async () => ({
        ok: false,
        status: 401,
        json: async () => ({ error: { code: 'unauthorized', message: 'no' } }),
      })) as unknown as typeof fetch,
    });
    await expect(client.call('health')).rejects.toMatchObject({ code: 'unauthorized' });
    try {
      await client.call('health');
    } catch (e) {
      expect(String(e)).not.toMatch(/tok-|Bearer/);
    }
  });
});
