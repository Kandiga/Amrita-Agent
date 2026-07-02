import { describe, expect, it } from 'vitest';
import {
  CINEMA_BRIDGE_TOKEN_ENV,
  DEFAULT_CINEMA_BRIDGE_URL,
  cinemaBridgeUrl,
  probeCinemaBridge,
  runCinemaVerb,
} from '../src/cinema.ts';
import { ProviderError } from '../src/provider.ts';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('cinema verb proxy (ADR-0028 Phase 2)', () => {
  it('refuses without the bridge bearer — missing_env_value, value-free', async () => {
    await expect(runCinemaVerb('chat', {}, { env: {} as NodeJS.ProcessEnv })).rejects.toThrowError(
      ProviderError,
    );
    await expect(runCinemaVerb('chat', {}, { env: {} as NodeJS.ProcessEnv })).rejects.toMatchObject(
      { code: 'missing_env_value' },
    );
  });

  it('forwards the body to the bridge channel with a bearer and returns the JSON verbatim', async () => {
    const calls: { url: string; auth: string | null; body: unknown }[] = [];
    const env = { [CINEMA_BRIDGE_TOKEN_ENV]: 'test-bearer' } as NodeJS.ProcessEnv;
    const reply = { reply: 'שלום', suggestedActions: [{ type: 'mark_qa' }] };
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        auth: (init?.headers as Record<string, string>).authorization ?? null,
        body: JSON.parse(String(init?.body ?? '{}')),
      });
      return jsonResponse(reply);
    }) as typeof fetch;

    const out = await runCinemaVerb(
      'chat',
      { messages: [{ role: 'user', text: 'היי' }] },
      { env, fetchImpl },
    );
    expect(out).toEqual(reply); // shape-identical passthrough — the acceptance rule
    expect(calls[0]?.url).toBe(`${DEFAULT_CINEMA_BRIDGE_URL}/run/reasoning.cinemaChat`);
    expect(calls[0]?.auth).toBe('Bearer test-bearer');
    expect(calls[0]?.body).toEqual({ messages: [{ role: 'user', text: 'היי' }] });
  });

  it('maps a down bridge to provider_unavailable (honest, no stack/secret)', async () => {
    const env = { [CINEMA_BRIDGE_TOKEN_ENV]: 'test-bearer' } as NodeJS.ProcessEnv;
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(runCinemaVerb('chat', {}, { env, fetchImpl })).rejects.toMatchObject({
      code: 'provider_unavailable',
    });
  });

  it('maps a rejected bearer to provider_error naming only the env VAR', async () => {
    const env = { [CINEMA_BRIDGE_TOKEN_ENV]: 'wrong' } as NodeJS.ProcessEnv;
    const fetchImpl = (async () => new Response('nope', { status: 401 })) as typeof fetch;
    const p = runCinemaVerb('assetAnalysis', {}, { env, fetchImpl });
    await expect(p).rejects.toMatchObject({ code: 'provider_error' });
    await expect(runCinemaVerb('assetAnalysis', {}, { env, fetchImpl })).rejects.toSatisfy(
      (e: unknown) => !String((e as Error).message).includes('wrong'),
    );
  });

  it('probe reports reachable/unreachable without throwing', async () => {
    const up = await probeCinemaBridge({
      fetchImpl: (async () => jsonResponse({ ok: true })) as typeof fetch,
    });
    expect(up.reachable).toBe(true);
    const down = await probeCinemaBridge({
      fetchImpl: (async () => {
        throw new Error('nope');
      }) as typeof fetch,
    });
    expect(down.reachable).toBe(false);
  });

  it('bridge URL env override trims trailing slashes', () => {
    expect(
      cinemaBridgeUrl({ AMRITA_CINEMA_BRIDGE_URL: 'http://10.0.0.5:9000///' } as NodeJS.ProcessEnv),
    ).toBe('http://10.0.0.5:9000');
  });
});
