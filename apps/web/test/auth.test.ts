import { describe, expect, it } from 'vitest';
import { type FetchLike, checkSession, logoutSession, pairWithCode } from '../src/auth.ts';

/** ADR-0057: the session model — the page never holds a credential. */

function fakeFetch(status: number, calls: Array<{ url: string; init?: unknown }>): FetchLike {
  return async (url, init) => {
    calls.push({ url, init });
    return { status };
  };
}

describe('cookie session probes', () => {
  it('checkSession asks GET /session and maps 204 → true, 401 → false', async () => {
    const calls: Array<{ url: string }> = [];
    expect(await checkSession(fakeFetch(204, calls))).toBe(true);
    expect(await checkSession(fakeFetch(401, []))).toBe(false);
    expect(calls[0]?.url).toBe('/session');
  });

  it('checkSession is false when fetch is unavailable or throws', async () => {
    expect(await checkSession(null)).toBe(false);
    const boom: FetchLike = async () => {
      throw new Error('down');
    };
    expect(await checkSession(boom)).toBe(false);
  });

  it('pairWithCode posts JSON to /pair and maps the status precisely', async () => {
    const calls: Array<{ url: string; init?: unknown }> = [];
    expect(await pairWithCode('ab2c-def3', fakeFetch(204, calls))).toBe('paired');
    const init = calls[0]?.init as {
      method: string;
      body: string;
      headers: Record<string, string>;
    };
    expect(calls[0]?.url).toBe('/pair');
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ code: 'ab2c-def3' });

    expect(await pairWithCode('x', fakeFetch(401, []))).toBe('rejected');
    expect(await pairWithCode('x', fakeFetch(429, []))).toBe('rate_limited');
    expect(await pairWithCode('   ', fakeFetch(204, []))).toBe('error'); // empty input never sent
  });

  it('logoutSession posts to /session/logout and swallows a dead server', async () => {
    const calls: Array<{ url: string }> = [];
    await logoutSession(fakeFetch(204, calls));
    expect(calls[0]?.url).toBe('/session/logout');
    const boom: FetchLike = async () => {
      throw new Error('down');
    };
    await expect(logoutSession(boom)).resolves.toBeUndefined();
  });
});
