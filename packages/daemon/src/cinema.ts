import { ProviderError } from './provider.ts';

/**
 * Cinema module verbs (ADR-0028, integration roadmap Phase 2).
 *
 * amritad is the FRONT DOOR; the single source of the Cinema agent's brain
 * stays the module's own daemon (brain-bridge `cinema-agent.mjs`) — we proxy,
 * we never reimplement, so responses are shape-identical by construction and
 * the two brains cannot drift. Generation channels are explicitly NOT proxied
 * here (Phase-2 non-goal); only the two reasoning verbs cross.
 *
 * Env (NAMES only — values are read from process.env at call time and never
 * stored, logged, or echoed):
 *   AMRITA_CINEMA_BRIDGE_URL   (default http://127.0.0.1:8799)
 *   BRAIN_BRIDGE_TOKEN         (the bridge's bearer; same name the bridge uses)
 */

export const CINEMA_BRIDGE_URL_ENV = 'AMRITA_CINEMA_BRIDGE_URL';
export const CINEMA_BRIDGE_TOKEN_ENV = 'BRAIN_BRIDGE_TOKEN';
export const DEFAULT_CINEMA_BRIDGE_URL = 'http://127.0.0.1:8799';

const CHANNELS = {
  chat: 'reasoning.cinemaChat',
  assetAnalysis: 'reasoning.cinemaAssetAnalysis',
} as const;
export type CinemaVerbKey = keyof typeof CHANNELS;

export interface CinemaProxyDeps {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export function cinemaBridgeUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env[CINEMA_BRIDGE_URL_ENV] ?? '').trim();
  return (raw || DEFAULT_CINEMA_BRIDGE_URL).replace(/\/+$/, '');
}

/** Presence-only check for the doctor — never returns the value. */
export function cinemaBridgeTokenPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean((env[CINEMA_BRIDGE_TOKEN_ENV] ?? '').trim());
}

export async function runCinemaVerb(
  verb: CinemaVerbKey,
  body: Record<string, unknown>,
  deps: CinemaProxyDeps = {},
): Promise<unknown> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const token = (env[CINEMA_BRIDGE_TOKEN_ENV] ?? '').trim();
  if (!token) {
    throw new ProviderError(
      'missing_env_value',
      `cinema bridge bearer not configured — set ${CINEMA_BRIDGE_TOKEN_ENV} in the daemon environment`,
    );
  }
  const base = cinemaBridgeUrl(env);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? 90_000);
  try {
    let r: Response;
    try {
      r = await fetchImpl(`${base}/run/${CHANNELS[verb]}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body ?? {}),
        signal: ctrl.signal,
      });
    } catch (e) {
      const why = e instanceof Error && e.name === 'AbortError' ? 'timed out' : 'unreachable';
      throw new ProviderError(
        'provider_unavailable',
        `cinema brain-bridge ${why} at ${base} — is the module daemon running?`,
      );
    }
    if (r.status === 401 || r.status === 403) {
      throw new ProviderError(
        'provider_error',
        `cinema brain-bridge rejected the bearer (HTTP ${r.status}) — check ${CINEMA_BRIDGE_TOKEN_ENV}`,
      );
    }
    if (!r.ok) {
      throw new ProviderError('provider_error', `cinema brain-bridge returned HTTP ${r.status}`);
    }
    try {
      return (await r.json()) as unknown;
    } catch {
      throw new ProviderError('provider_error', 'cinema brain-bridge returned a non-JSON body');
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Live reachability probe for the doctor (public /health; no bearer needed). */
export async function probeCinemaBridge(
  deps: CinemaProxyDeps = {},
): Promise<{ reachable: boolean; detail: string }> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const base = cinemaBridgeUrl(env);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? 3_000);
  try {
    const r = await fetchImpl(`${base}/health`, { signal: ctrl.signal });
    return r.ok
      ? { reachable: true, detail: `bridge up at ${base}` }
      : { reachable: false, detail: `bridge answered HTTP ${r.status} at ${base}` };
  } catch {
    return { reachable: false, detail: `no bridge at ${base}` };
  } finally {
    clearTimeout(timer);
  }
}
