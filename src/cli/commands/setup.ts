import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig, saveConfig, setSecret, getSecret } from '../../shared/config.ts';
import { listProfiles, providerNeedsApiKey } from '../../core/providers/registry.ts';
import { claudeAuthStatus } from '../../core/providers/claude-cli.ts';
import type { ProviderProfile } from '../../shared/types.ts';

/**
 * Guided setup wizard. Honest by design: it never pretends something is
 * connected, never harvests tokens, and groups the options by how you pay /
 * authenticate so a non-technical user can choose with confidence.
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

/** Honest, live "is it ready?" note per provider. */
function configuredNote(p: ProviderProfile): string {
  if (p.authMode === 'local_cli_login') {
    const st = claudeAuthStatus();
    if (!st.installed) return 'claude CLI not installed → install Claude Code';
    if (!st.loggedIn) return 'installed, not logged in → run: claude auth login';
    return `logged in${st.subscriptionType ? ` (${st.subscriptionType})` : ''} ✓`;
  }
  if (p.authMode === 'local_endpoint') return `endpoint ${p.baseUrl}`;
  return p.keyEnv && getSecret(p.keyEnv) ? 'key set ✓' : 'no key yet';
}

function labelExtra(p: ProviderProfile): string {
  // Honest caveat for Grok: no official local subscription connector.
  return p.id === 'xai' ? ' — API key only (no subscription login)' : '';
}

export async function setupCommand(_args: string[]): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  const config = loadConfig(true);
  console.log("Amrita setup — choose how Amrita's brain connects. Press Enter to keep the [default].\n");

  const profiles = listProfiles();
  const login = profiles.filter((p) => p.authMode === 'local_cli_login');
  const apiKey = profiles.filter((p) => p.authMode === 'api_key');
  const local = profiles.filter((p) => p.authMode === 'local_endpoint');

  // A flat, numbered, selectable list assembled across the three groups.
  const ordered: ProviderProfile[] = [];
  const printGroup = (title: string, sub: string, list: ProviderProfile[]) => {
    console.log(`${title}\n  ${sub}`);
    for (const p of list) {
      ordered.push(p);
      const n = ordered.length;
      console.log(`  ${n}. ${p.label}${labelExtra(p)}`);
      console.log(`       uses:       ${META[p.id]?.uses ?? p.label}`);
      console.log(`       cost:       ${META[p.id]?.cost ?? '—'}`);
      console.log(`       needs:      ${requiresLine(p)}`);
      console.log(`       status:     ${configuredNote(p)}`);
    }
    console.log();
  };

  printGroup('A) Use a local subscription / login (recommended if you have one)',
    'Amrita drives a CLI you already logged into; it never sees your password or tokens.', login);
  // Codex: honest placeholder — not yet wired as an Amrita brain provider.
  console.log('  • Codex local login — planned, not yet a selectable brain provider.');
  console.log('       Codex would authenticate through its own CLI (`codex login`); when');
  console.log('       Amrita ships the Codex provider this option will appear here.\n');

  printGroup('B) Use an API key / aggregator', 'You bring a key; Amrita calls the official API.', apiKey);
  printGroup('C) Use a local model', 'An OpenAI-compatible server on your own machine.', local);

  // ---- pick a provider ----
  const pickRaw = (await rl.question(`Provider for Amrita's brain [${config.model.provider}]: `)).trim();
  let profile = profiles.find((p) => p.id === config.model.provider) ?? ordered[0]!;
  if (pickRaw) {
    profile = ordered[Number(pickRaw) - 1] ?? profiles.find((p) => p.id === pickRaw) ?? profile;
  }
  const providerChanged = config.model.provider !== profile.id;
  config.model.provider = profile.id;
  console.log(`\n→ ${profile.label}`);

  // ---- authenticate (key only when the mode actually needs one) ----
  if (providerNeedsApiKey(profile) && profile.keyEnv && !getSecret(profile.keyEnv)) {
    const key = (await rl.question(`${profile.keyEnv} (paste key, or Enter to skip): `)).trim();
    if (key) {
      setSecret(profile.keyEnv, key);
      console.log('  saved to ~/.amrita/secrets.env (0600)');
    } else {
      console.log(`  skipped — Amrita can't think until ${profile.keyEnv} is set.`);
    }
  } else if (profile.authMode === 'local_cli_login') {
    const st = claudeAuthStatus();
    if (!st.installed) {
      console.log('  Claude Code CLI is not installed. Install it from https://claude.ai/code, then re-run setup.');
    } else if (!st.loggedIn) {
      console.log('  Not logged in yet. In a terminal run:  claude auth login');
      console.log('  (Amrita never stores your Claude credentials — the CLI keeps them.)');
    } else {
      console.log(`  Using your Claude login${st.subscriptionType ? ` (${st.subscriptionType})` : ''}. No API key needed.`);
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
  console.log(`\nDone. Next steps:
  amrita doctor   — verify everything (including your login status)
  amrita daemon   — start the daemon (web UI + telegram)
  amrita chat     — talk from this terminal right now`);
}
