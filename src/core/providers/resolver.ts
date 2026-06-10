import { claudeAuthStatus, claudeBin } from './claude-cli.ts';
import { getSecret } from '../../shared/config.ts';
import { resolveProviderId, type ProviderHealthInput } from './registry.ts';

/**
 * Live provider-health facts (CLI login + key presence), assembled from the
 * environment. The CLI-login probe is cached briefly so resolving `auto`
 * doesn't spawn `claude auth status` repeatedly within a single turn; the
 * cache key includes the CLI path so changing it (e.g. in tests) re-probes.
 * Key presence is always read fresh (the closure calls getSecret on demand).
 */
let cache: { at: number; bin: string; claudeLoggedIn: boolean } | null = null;
const TTL_MS = 3000;

export function liveHealthInput(): ProviderHealthInput {
  const at = Date.now();
  const bin = claudeBin();
  if (!cache || cache.bin !== bin || at - cache.at > TTL_MS) {
    cache = { at, bin, claudeLoggedIn: claudeAuthStatus().loggedIn };
  }
  return {
    claudeLoggedIn: cache.claudeLoggedIn,
    hasKey: (k) => Boolean(k && getSecret(k)),
  };
}

/** Resolve the configured provider id (possibly `auto`) to a concrete one. */
export function resolveActiveProviderId(providerId: string): string {
  if (providerId !== 'auto') return providerId; // fast path — no CLI probe
  return resolveProviderId(providerId, liveHealthInput());
}
