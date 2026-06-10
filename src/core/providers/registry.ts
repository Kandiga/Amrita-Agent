import type { Provider, ProviderProfile } from '../../shared/types.ts';
import { loadConfig } from '../../shared/config.ts';
import { anthropicProvider } from './anthropic.ts';
import { openAiCompatProvider } from './openai-compat.ts';
import { mockProvider } from './mock.ts';

/**
 * Declarative provider profiles (Hermes pattern).
 * Auth honesty: only api_key and local_endpoint modes live here.
 * CLI-passthrough providers (Claude Code, Codex) are connectors, not providers.
 */
export const builtinProfiles: Record<string, ProviderProfile> = {
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
  if (profile.api === 'anthropic') return anthropicProvider(profile);
  return openAiCompatProvider(profile);
}

export function listProfiles(): ProviderProfile[] {
  return Object.values(builtinProfiles).filter((p) => p.id !== 'mock');
}
