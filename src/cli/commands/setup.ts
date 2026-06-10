import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig, saveConfig, setSecret, getSecret } from '../../shared/config.ts';
import {
  listProfiles,
  providerNeedsApiKey,
  recommendProvider,
} from '../../core/providers/registry.ts';
import { claudeAuthStatus, type ClaudeAuthStatus } from '../../core/providers/claude-cli.ts';
import type { ProviderProfile } from '../../shared/types.ts';

/**
 * Guided setup wizard. Honest by design: it never pretends something is
 * connected, never harvests tokens, groups options by how you pay /
 * authenticate, and — crucially — defaults the prompt to a *recommended,
 * working* provider rather than trapping you on a broken API-key default.
 */

// Plain-language description per provider.
const META: Record<string, { uses: string; cost: string }> = {
  'claude-code': {
    uses: 'your installed Claude Code login',
    cost: 'your Claude subscription / Agent SDK credit — no API key',
  },
  anthropic: { uses: 'Anthropic Messages API', cost: 'pay-per-token API credits' },
  openai: { uses: 'OpenAI API', cost: 'pay-per-token API credits' },
  openrouter: { uses: 'OpenRouter (many models, one key)', cost: 'pay-per-token via OpenRouter' },
  gemini: { uses: 'Google Gemini API', cost: 'pay-per-token API credits' },
  xai: { uses: 'xAI Grok API', cost: 'pay-per-token API credits' },
  ollama: { uses: 'a local Ollama server', cost: 'free — runs on your hardware' },
  'local-openai': { uses: 'a local OpenAI-compatible server', cost: 'free — runs on your hardware' },
};

// Friendly known-model suggestions (the user can always type a custom id).
const KNOWN_MODELS: Record<string, string[]> = {
  'claude-code': ['default', 'sonnet', 'opus', 'haiku'],
  anthropic: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-haiku-4-5-20251001'],
  openai: ['gpt-5.2', 'gpt-5.2-mini'],
  openrouter: ['anthropic/claude-sonnet-4.6', 'openai/gpt-5.2'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  xai: ['grok-4'],
};

function requiresLine(p: ProviderProfile): string {
  if (p.authMode === 'local_cli_login') return 'local login (no key in Amrita)';
  if (p.authMode === 'local_endpoint') return 'a running local server';
  return `${p.keyEnv} (API key)`;
}

/** Honest, live "is it ready?" note per provider. `claude` status is passed in. */
function statusNote(p: ProviderProfile, claude: ClaudeAuthStatus): string {
  if (p.authMode === 'local_cli_login') {
    if (!claude.installed) return 'claude CLI not installed → install Claude Code';
    if (!claude.loggedIn) return 'installed, not logged in → run: claude auth login';
    return `logged in${claude.subscriptionType ? ` (${claude.subscriptionType})` : ''} ✓`;
  }
  if (p.authMode === 'local_endpoint') return `endpoint ${p.baseUrl} (verify with doctor)`;
  return p.keyEnv && getSecret(p.keyEnv) ? 'key set ✓' : 'no key yet';
}

/** Short health phrase for the header lines. */
function shortHealth(p: ProviderProfile, claude: ClaudeAuthStatus): string {
  if (p.authMode === 'local_cli_login') {
    if (!claude.installed) return 'claude CLI not installed';
    if (!claude.loggedIn) return 'not logged in (run: claude auth login)';
    return `logged in${claude.subscriptionType ? ` (${claude.subscriptionType})` : ''}`;
  }
  if (p.authMode === 'local_endpoint') return `local endpoint ${p.baseUrl}`;
  return p.keyEnv && getSecret(p.keyEnv) ? 'key set' : `incomplete (missing ${p.keyEnv})`;
}

function labelExtra(p: ProviderProfile): string {
  return p.id === 'xai' ? ' — API key only (no subscription login)' : '';
}

export async function setupCommand(_args: string[]): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  const config = loadConfig(true);

  const profiles = listProfiles();
  // Probe the Claude login ONCE and reuse everywhere (avoids repeated spawns).
  const claude = claudeAuthStatus();
  const health = { claudeLoggedIn: claude.loggedIn, hasKey: (k: string | null) => Boolean(k && getSecret(k)) };
  const recommendedId = recommendProvider(config.model.provider, profiles, health);

  // ---- header: current state + recommendation ----
  const currentProfile = profiles.find((p) => p.id === config.model.provider);
  console.log("Amrita setup — choose how Amrita's brain connects.");
  console.log(
    `Current provider: ${config.model.provider}${currentProfile ? ` — ${shortHealth(currentProfile, claude)}` : ' — unknown provider'}`,
  );
  const recProfile = profiles.find((p) => p.id === recommendedId)!;
  console.log(`Recommended:      ${recProfile.label} — ${shortHealth(recProfile, claude)}`);
  if (currentProfile && currentProfile.authMode === 'api_key' && !(currentProfile.keyEnv && getSecret(currentProfile.keyEnv))) {
    console.log('\nYour current provider is incomplete. Press Enter to switch to the recommended option.');
  }
  console.log('\nPress Enter to accept the recommended choice, or type a number.\n');

  // ---- grouped, numbered options (recommended one is marked) ----
  const ordered: ProviderProfile[] = [];
  const printGroup = (title: string, sub: string, list: ProviderProfile[]) => {
    if (!list.length) return;
    console.log(`${title}\n  ${sub}`);
    for (const p of list) {
      ordered.push(p);
      const n = ordered.length;
      const mark = p.id === recommendedId ? '  [recommended]' : '';
      console.log(`  ${n}. ${p.label}${labelExtra(p)}${mark}`);
      console.log(`       uses:   ${META[p.id]?.uses ?? p.label}`);
      console.log(`       cost:   ${META[p.id]?.cost ?? '—'}`);
      console.log(`       needs:  ${requiresLine(p)}`);
      console.log(`       status: ${statusNote(p, claude)}`);
    }
    console.log();
  };

  printGroup('A) Use a local subscription / login (recommended if you have one)',
    'Amrita drives a CLI you already logged into; it never sees your password or tokens.',
    profiles.filter((p) => p.authMode === 'local_cli_login'));
  console.log('  • Codex local login — planned, not yet a selectable brain provider.');
  console.log('       It will authenticate via Codex\'s own `codex login`; not available yet.\n');
  printGroup('B) Use an API key / aggregator', 'You bring a key; Amrita calls the official API.',
    profiles.filter((p) => p.authMode === 'api_key'));
  printGroup('C) Use a local model', 'An OpenAI-compatible server on your own machine.',
    profiles.filter((p) => p.authMode === 'local_endpoint'));

  // ---- pick a provider (Enter = recommended) ----
  const recommendedNum = ordered.findIndex((p) => p.id === recommendedId) + 1;
  const pickRaw = (await rl.question(`Choose provider number [${recommendedNum}]: `)).trim();
  let profile = recProfile;
  if (pickRaw) {
    profile = ordered[Number(pickRaw) - 1] ?? profiles.find((p) => p.id === pickRaw) ?? recProfile;
  }
  const providerChanged = config.model.provider !== profile.id;
  config.model.provider = profile.id;
  console.log(`\n→ ${profile.label}`);

  // ---- authenticate (key ONLY when the mode actually needs one) ----
  if (providerNeedsApiKey(profile) && profile.keyEnv && !getSecret(profile.keyEnv)) {
    const key = (await rl.question(`${profile.keyEnv} (paste key, or Enter to skip): `)).trim();
    if (key) {
      setSecret(profile.keyEnv, key);
      console.log('  saved to ~/.amrita/secrets.env (0600)');
    } else {
      console.log(`  skipped — Amrita can't think until ${profile.keyEnv} is set.`);
    }
  } else if (profile.authMode === 'local_cli_login') {
    if (!claude.installed) {
      console.log('  Claude Code CLI is not installed. Install it from https://claude.ai/code, then re-run setup.');
    } else if (!claude.loggedIn) {
      console.log('  Not logged in yet. In a terminal run:  claude auth login');
      console.log('  (Amrita never stores your Claude credentials — the CLI keeps them.)');
    } else {
      console.log(`  Using your Claude login${claude.subscriptionType ? ` (${claude.subscriptionType})` : ''}. No API key needed.`);
    }
  } else if (profile.authMode === 'local_endpoint') {
    console.log(`  Make sure your local server is running at ${profile.baseUrl}.`);
  }

  // ---- model ----
  const suggested = providerChanged ? profile.defaultModel : config.model.model;
  const known = KNOWN_MODELS[profile.id];
  if (known) console.log(`  Known models: ${known.join(', ')} (or type any custom id)`);
  if (profile.authMode === 'local_cli_login') {
    console.log("  'default' lets Claude Code use the model your subscription is set to.");
  }
  const model = (await rl.question(`Model [${suggested}]: `)).trim();
  config.model.model = model || suggested;

  // ---- telegram ----
  const wantTg = (await rl.question(`\nEnable Telegram? (y/N) [${config.channels.telegram.enabled ? 'y' : 'n'}]: `))
    .trim()
    .toLowerCase();
  if (wantTg === 'y' || wantTg === 'yes') {
    config.channels.telegram.enabled = true;
    if (!getSecret('TELEGRAM_BOT_TOKEN')) {
      const token = (await rl.question('Bot token from @BotFather (Enter to skip): ')).trim();
      if (token) setSecret('TELEGRAM_BOT_TOKEN', token);
    }
    console.log('  Telegram is owner-only: add your numeric id to channels.telegram.allowedUserIds in ~/.amrita/config.json.');
  } else if (wantTg === 'n' || wantTg === 'no') {
    config.channels.telegram.enabled = false;
  }

  // ---- public URL ----
  const publicUrl = (await rl.question(`Public URL for web links (Enter for http://127.0.0.1:${config.daemon.port}): `)).trim();
  config.daemon.publicUrl = publicUrl || null;

  saveConfig(config);
  rl.close();
  console.log(`\nDone — provider set to ${config.model.provider} / ${config.model.model}. Next steps:
  amrita doctor   — verify everything (including your login status)
  amrita daemon   — start the daemon (web UI + telegram)
  amrita chat     — talk from this terminal right now`);
}
