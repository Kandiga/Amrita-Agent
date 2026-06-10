import type { Provider, ProviderProfile } from '../../shared/types.ts';
import { loadConfig, getSecret } from '../../shared/config.ts';
import { anthropicProvider } from './anthropic.ts';
import { openAiCompatProvider } from './openai-compat.ts';
import { claudeCliProvider } from './claude-cli.ts';
import { mockProvider } from './mock.ts';

/**
 * Declarative provider profiles (Hermes pattern).
 * Auth honesty: only api_key and local_endpoint modes live here.
 * CLI-passthrough providers (Claude Code, Codex) are connectors, not providers.
 */
export const builtinProfiles: Record<string, ProviderProfile> = {
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code local login (subscription / Agent SDK credit)',
    api: 'claude-cli',
    baseUrl: 'cli://claude',
    keyEnv: null,
    authMode: 'local_cli_login',
    defaultModel: 'default',
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    api: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    keyEnv: 'ANTHROPIC_API_KEY',
    authMode: 'api_key',
    defaultModel: 'claude-sonnet-4-6',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    api: 'openai-compat',
    baseUrl: 'https://api.openai.com/v1',
    keyEnv: 'OPENAI_API_KEY',
    authMode: 'api_key',
    defaultModel: 'gpt-5.2',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    api: 'openai-compat',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY',
    authMode: 'api_key',
    defaultModel: 'anthropic/claude-sonnet-4.6',
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    api: 'openai-compat',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyEnv: 'GEMINI_API_KEY',
    authMode: 'api_key',
    defaultModel: 'gemini-2.5-pro',
  },
  xai: {
    id: 'xai',
    label: 'xAI (Grok)',
    api: 'openai-compat',
    baseUrl: 'https://api.x.ai/v1',
    keyEnv: 'XAI_API_KEY',
    authMode: 'api_key',
    defaultModel: 'grok-4',
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama (local)',
    api: 'openai-compat',
    baseUrl: 'http://127.0.0.1:11434/v1',
    keyEnv: null,
    authMode: 'local_endpoint',
    defaultModel: 'qwen3',
  },
  'local-openai': {
    id: 'local-openai',
    label: 'Local OpenAI-compatible (llama.cpp / vLLM)',
    api: 'openai-compat',
    baseUrl: 'http://127.0.0.1:8000/v1',
    keyEnv: null,
    authMode: 'local_endpoint',
    defaultModel: 'default',
  },
  mock: {
    id: 'mock',
    label: 'Mock (tests)',
    api: 'openai-compat',
    baseUrl: 'mock://',
    keyEnv: null,
    authMode: 'local_endpoint',
    defaultModel: 'mock-1',
  },
};

export function resolveProfile(providerId: string): ProviderProfile {
  const base = builtinProfiles[providerId];
  const override = loadConfig().providers[providerId];
  if (!base && !override) throw new Error(`Unknown provider: ${providerId}`);
  return { ...(base ?? builtinProfiles['local-openai']!), ...(override ?? {}), id: providerId };
}

export function getProvider(providerId: string): Provider {
  const profile = resolveProfile(providerId);
  if (providerId === 'mock') return mockProvider(profile);
  if (profile.api === 'claude-cli') return claudeCliProvider(profile);
  if (profile.api === 'anthropic') return anthropicProvider(profile);
  return openAiCompatProvider(profile);
}

export function listProfiles(): ProviderProfile[] {
  return Object.values(builtinProfiles).filter((p) => p.id !== 'mock');
}

/** Does this provider require Amrita to hold an API key? (false for login/local modes.) */
export function providerNeedsApiKey(profile: ProviderProfile): boolean {
  return profile.authMode === 'api_key' && Boolean(profile.keyEnv);
}

export type ProviderState = 'configured' | 'needs-setup' | 'local' | 'local-login';

/**
 * Static, honest state for a provider. For `local-login` this reports only
 * that the mode is login-based — `amrita doctor` performs the live CLI probe.
 */
export function providerStateLabel(profile: ProviderProfile): ProviderState {
  if (profile.authMode === 'local_endpoint') return 'local';
  if (profile.authMode === 'local_cli_login') return 'local-login';
  return profile.keyEnv && getSecret(profile.keyEnv) ? 'configured' : 'needs-setup';
}

/**
 * Inputs needed to judge provider health without doing I/O inside the pure
 * helpers — the caller supplies the live facts (CLI login state, key presence)
 * so recommendation/health logic stays deterministic and unit-testable.
 */
export interface ProviderHealthInput {
  /** Result of probing `claude auth status` — is the local Claude login usable? */
  claudeLoggedIn: boolean;
  /** Whether a secret is present for a given env var. */
  hasKey: (keyEnv: string | null) => boolean;
}

/**
 * Is this provider usable right now?
 * - api_key         → a key is present
 * - local_cli_login → the CLI reports logged in
 * - local_endpoint  → treated as configured (the user set the endpoint; live
 *                     reachability is `amrita doctor`'s job, not setup's)
 */
export function isProviderHealthy(profile: ProviderProfile, input: ProviderHealthInput): boolean {
  if (profile.authMode === 'api_key') return input.hasKey(profile.keyEnv);
  if (profile.authMode === 'local_cli_login') return input.claudeLoggedIn;
  return true;
}

/**
 * Deterministic recommendation for the setup default — never traps the user on
 * a broken API-key provider:
 *   1. keep the current provider if it is healthy / configured
 *   2. else prefer Claude Code local login when it is logged in
 *   3. else keep an explicitly-chosen login/local provider
 *   4. else fall back to the first API-key provider (which will need a key)
 */
export function recommendProvider(
  currentId: string,
  profiles: ProviderProfile[],
  input: ProviderHealthInput,
): string {
  const current = profiles.find((p) => p.id === currentId);
  if (current && isProviderHealthy(current, input)) return current.id;
  const claude = profiles.find((p) => p.id === 'claude-code');
  if (claude && input.claudeLoggedIn) return claude.id;
  if (current && current.authMode !== 'api_key') return current.id;
  const firstApi = profiles.find((p) => p.authMode === 'api_key');
  return (firstApi ?? profiles[0]!).id;
}
