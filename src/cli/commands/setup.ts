import { createInterface, type Interface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  loadConfig,
  saveConfig,
  backupConfig,
  setSecret,
  getSecret,
  redactSecret,
} from '../../shared/config.ts';
import {
  listProfiles,
  providerNeedsApiKey,
  recommendProvider,
  isProviderHealthy,
  resolveProviderId,
  type ProviderHealthInput,
} from '../../core/providers/registry.ts';
import { claudeAuthStatus, type ClaudeAuthStatus } from '../../core/providers/claude-cli.ts';
import type { ProviderProfile, AmritaConfig } from '../../shared/types.ts';

/**
 * Sectioned setup wizard (Hermes-style): a current-state summary, a menu of
 * focused sections, and safe, idempotent re-runs. `amrita setup <section>`
 * jumps straight to one section. Config is backed up before any change, and
 * every section saves immediately so a partial run is never lost.
 *
 * Honest by design: no token dumping, no API-key prompt for login providers,
 * and the recommended default is always a *working* option — never a broken one.
 */

const META: Record<string, { uses: string; cost: string }> = {
  'claude-code': { uses: 'your installed Claude Code login', cost: 'your Claude subscription / Agent SDK credit — no API key' },
  anthropic: { uses: 'Anthropic Messages API', cost: 'pay-per-token API credits' },
  openai: { uses: 'OpenAI API', cost: 'pay-per-token API credits' },
  openrouter: { uses: 'OpenRouter (many models, one key)', cost: 'pay-per-token via OpenRouter' },
  gemini: { uses: 'Google Gemini API', cost: 'pay-per-token API credits' },
  xai: { uses: 'xAI Grok API', cost: 'pay-per-token API credits' },
  ollama: { uses: 'a local Ollama server', cost: 'free — runs on your hardware' },
  'local-openai': { uses: 'a local OpenAI-compatible server', cost: 'free — runs on your hardware' },
};

const KNOWN_MODELS: Record<string, string[]> = {
  'claude-code': ['default', 'sonnet', 'opus', 'haiku'],
  anthropic: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-haiku-4-5-20251001'],
  openai: ['gpt-5.2', 'gpt-5.2-mini'],
  openrouter: ['anthropic/claude-sonnet-4.6', 'openai/gpt-5.2'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  xai: ['grok-4'],
};

function healthInput(claude: ClaudeAuthStatus): ProviderHealthInput {
  return { claudeLoggedIn: claude.loggedIn, hasKey: (k) => Boolean(k && getSecret(k)) };
}

function shortHealth(p: ProviderProfile, claude: ClaudeAuthStatus): string {
  if (p.authMode === 'local_cli_login') {
    if (!claude.installed) return 'claude CLI not installed';
    if (!claude.loggedIn) return 'not logged in (run: claude auth login)';
    return `logged in${claude.subscriptionType ? ` (${claude.subscriptionType})` : ''}`;
  }
  if (p.authMode === 'local_endpoint') return `local endpoint ${p.baseUrl}`;
  return p.keyEnv && getSecret(p.keyEnv) ? 'key set' : `incomplete (missing ${p.keyEnv})`;
}

/** Describe the active provider, resolving `auto`. */
function describeProvider(config: AmritaConfig, profiles: ProviderProfile[], claude: ClaudeAuthStatus): string {
  if (config.model.provider === 'auto') {
    const resolved = resolveProviderId('auto', healthInput(claude));
    const rp = profiles.find((p) => p.id === resolved);
    return `auto → ${resolved}${rp ? ` (${shortHealth(rp, claude)})` : ''}`;
  }
  const p = profiles.find((x) => x.id === config.model.provider);
  return p ? `${config.model.provider} — ${shortHealth(p, claude)}` : `${config.model.provider} — unknown provider`;
}

// ───────────────────────── status summary ─────────────────────────

function statusSummary(config: AmritaConfig, profiles: ProviderProfile[], claude: ClaudeAuthStatus): string {
  const keys = profiles.filter((p) => p.keyEnv && getSecret(p.keyEnv)).map((p) => p.id);
  const tg = config.channels.telegram.enabled
    ? `enabled${getSecret('TELEGRAM_BOT_TOKEN') ? '' : ' (no token)'}${config.channels.telegram.allowedUserIds.length ? '' : ' (no allowlist)'}`
    : 'disabled';
  const conn = [
    config.connectors.claudeCode.enabled ? 'Claude Code' : null,
    config.connectors.openDesign.enabled ? 'Open Design' : null,
  ].filter(Boolean);
  return [
    `  Model provider : ${describeProvider(config, profiles, claude)} / ${config.model.model}`,
    `  API keys set   : ${keys.length ? keys.join(', ') : 'none'}`,
    `  Telegram       : ${tg}`,
    `  Connectors     : ${conn.length ? conn.join(', ') : 'none enabled'}`,
    `  Web UI         : ${config.daemon.publicUrl ?? `http://127.0.0.1:${config.daemon.port}`}`,
  ].join('\n');
}

// ───────────────────────── sections ─────────────────────────

type ProviderChoice =
  | { kind: 'auto'; label: string }
  | { kind: 'provider'; label: string; profile: ProviderProfile };

async function sectionModel(rl: Interface): Promise<void> {
  const config = loadConfig(true);
  const profiles = listProfiles();
  const claude = claudeAuthStatus();
  const input = healthInput(claude);

  // What to recommend as the Enter-default? Keep a working `auto`, otherwise
  // the best concrete provider (e.g. Claude Code login).
  let recommendedKey: string;
  if (config.model.provider === 'auto') {
    const resolved = resolveProviderId('auto', input);
    const rp = profiles.find((p) => p.id === resolved);
    recommendedKey = rp && isProviderHealthy(rp, input) ? 'auto' : resolved;
  } else {
    recommendedKey = recommendProvider(config.model.provider, profiles, input);
  }

  console.log(`Current: ${describeProvider(config, profiles, claude)}`);

  // Build the numbered choice list: Auto first, then grouped providers.
  const choices: ProviderChoice[] = [{ kind: 'auto', label: 'Auto — always use the best available provider' }];
  const groups: [string, string, ProviderProfile[]][] = [
    ['A) Local subscription / login', 'a CLI you logged into — no API key, no token dumping', profiles.filter((p) => p.authMode === 'local_cli_login')],
    ['B) API key / aggregator', 'you bring a key; Amrita calls the official API', profiles.filter((p) => p.authMode === 'api_key')],
    ['C) Local model', 'an OpenAI-compatible server on your own machine', profiles.filter((p) => p.authMode === 'local_endpoint')],
  ];

  console.log('\n  0/auto. Auto — best available (currently ' + describeProvider({ ...config, model: { ...config.model, provider: 'auto' } }, profiles, claude).replace('auto → ', '') + ')' + (recommendedKey === 'auto' ? '  [recommended]' : ''));
  for (const [title, sub, list] of groups) {
    if (!list.length) continue;
    console.log(`\n${title} — ${sub}`);
    for (const p of list) {
      choices.push({ kind: 'provider', label: p.label, profile: p });
      const n = choices.length - 1; // auto is index 0 → option "0/auto"; providers start at 1
      const mark = p.id === recommendedKey ? '  [recommended]' : '';
      const extra = p.id === 'xai' ? ' — API key only' : '';
      console.log(`  ${n}. ${p.label}${extra}${mark}`);
      console.log(`       cost: ${META[p.id]?.cost ?? '—'}  ·  status: ${shortHealth(p, claude)}`);
    }
  }

  const recNum = recommendedKey === 'auto' ? 'auto' : String(choices.findIndex((c) => c.kind === 'provider' && c.profile.id === recommendedKey));
  const raw = (await rl.question(`\nChoose provider [${recNum}]: `)).trim().toLowerCase();

  let chosen: ProviderChoice;
  if (!raw) chosen = recommendedKey === 'auto' ? choices[0]! : choices.find((c) => c.kind === 'provider' && c.profile.id === recommendedKey)!;
  else if (raw === 'auto' || raw === '0') chosen = choices[0]!;
  else chosen = choices[Number(raw)] ?? choices.find((c) => c.kind === 'provider' && c.profile.id === raw) ?? choices[0]!;

  if (chosen.kind === 'auto') {
    config.model.provider = 'auto';
    config.model.model = 'default';
    console.log('\n→ Auto. Amrita will use the best available provider each run; no API key needed here.');
    saveConfig(config);
    return;
  }

  const profile = chosen.profile;
  const changed = config.model.provider !== profile.id;
  config.model.provider = profile.id;
  console.log(`\n→ ${profile.label}`);

  if (providerNeedsApiKey(profile) && profile.keyEnv && !getSecret(profile.keyEnv)) {
    const key = (await rl.question(`${profile.keyEnv} (paste key, or Enter to set later): `)).trim();
    if (key) {
      setSecret(profile.keyEnv, key);
      console.log('  saved to ~/.amrita/secrets.env (0600)');
    } else {
      console.log(`  left unset — this provider won't work until ${profile.keyEnv} is set.`);
    }
  } else if (profile.authMode === 'local_cli_login') {
    if (!claude.installed) console.log('  Claude Code CLI not installed — get it at https://claude.ai/code, then re-run.');
    else if (!claude.loggedIn) console.log('  Not logged in yet. Run:  claude auth login  (Amrita never stores your credentials).');
    else console.log(`  Using your Claude login${claude.subscriptionType ? ` (${claude.subscriptionType})` : ''}. No API key needed.`);
  } else if (profile.authMode === 'local_endpoint') {
    console.log(`  Ensure your local server is running at ${profile.baseUrl} (configure it in section "Local model endpoint").`);
  }

  const suggested = changed ? profile.defaultModel : config.model.model;
  const known = KNOWN_MODELS[profile.id];
  if (known) console.log(`  Known models: ${known.join(', ')} (or any custom id)`);
  if (profile.authMode === 'local_cli_login') console.log("  'default' = the model your Claude subscription is set to.");
  const model = (await rl.question(`Model [${suggested}]: `)).trim();
  config.model.model = model || suggested;
  saveConfig(config);
}

async function sectionCredentials(rl: Interface): Promise<void> {
  const config = loadConfig(true);
  const apiProfiles = listProfiles().filter((p) => p.authMode === 'api_key');
  console.log('API keys are stored only in ~/.amrita/secrets.env (0600) — never shown in full.\n');
  apiProfiles.forEach((p, i) => {
    const key = p.keyEnv ? getSecret(p.keyEnv) : null;
    console.log(`  ${i + 1}. ${p.label} — ${key ? `set (${redactSecret(key)})` : 'not set'}`);
  });
  const pick = (await rl.question('\nEdit which key? (number, Enter to skip): ')).trim();
  const profile = apiProfiles[Number(pick) - 1];
  if (!profile || !profile.keyEnv) return;
  const val = (await rl.question(`${profile.keyEnv} (paste, or Enter to keep): `)).trim();
  if (val) {
    setSecret(profile.keyEnv, val);
    console.log('  saved.');
  }
}

async function sectionTelegram(rl: Interface): Promise<void> {
  const config = loadConfig(true);
  const cur = config.channels.telegram.enabled;
  const ans = (await rl.question(`Enable Telegram? (y/N) [${cur ? 'y' : 'n'}]: `)).trim().toLowerCase();
  if (ans === 'y' || ans === 'yes') {
    config.channels.telegram.enabled = true;
    if (!getSecret('TELEGRAM_BOT_TOKEN')) {
      const token = (await rl.question('Bot token from @BotFather (Enter to skip): ')).trim();
      if (token) setSecret('TELEGRAM_BOT_TOKEN', token);
    }
    const ids = (await rl.question(`Your numeric Telegram id(s), comma-separated [${config.channels.telegram.allowedUserIds.join(',') || 'none'}]: `)).trim();
    if (ids) {
      config.channels.telegram.allowedUserIds = ids.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
    }
    console.log('  Telegram is owner-only: only allowlisted ids may talk to the bot (it can run shell/file tools).');
  } else if (ans === 'n' || ans === 'no') {
    config.channels.telegram.enabled = false;
  }
  saveConfig(config);
}

async function sectionConnectors(rl: Interface): Promise<void> {
  const config = loadConfig(true);
  const cc = (await rl.question(`Enable Claude Code connector (delegated coding)? (Y/n) [${config.connectors.claudeCode.enabled ? 'y' : 'n'}]: `)).trim().toLowerCase();
  if (cc === 'n' || cc === 'no') config.connectors.claudeCode.enabled = false;
  else if (cc === 'y' || cc === 'yes') config.connectors.claudeCode.enabled = true;
  console.log(`  Claude Code autonomy is '${config.connectors.claudeCode.autonomy}' (change it only by editing config.json — kept out of band for safety).`);
  const od = (await rl.question(`Enable Open Design connector? (y/N) [${config.connectors.openDesign.enabled ? 'y' : 'n'}]: `)).trim().toLowerCase();
  if (od === 'y' || od === 'yes') {
    config.connectors.openDesign.enabled = true;
    const url = (await rl.question(`Open Design base URL [${config.connectors.openDesign.baseUrl}]: `)).trim();
    if (url) config.connectors.openDesign.baseUrl = url;
  } else if (od === 'n' || od === 'no') {
    config.connectors.openDesign.enabled = false;
  }
  saveConfig(config);
}

async function sectionEndpoint(rl: Interface): Promise<void> {
  const config = loadConfig(true);
  const cur = config.providers.ollama?.baseUrl ?? 'http://127.0.0.1:11434/v1';
  console.log('Set a custom base URL for a local OpenAI-compatible server (Ollama / llama.cpp / vLLM).');
  const url = (await rl.question(`Ollama base URL [${cur}]: `)).trim();
  if (url) {
    config.providers.ollama = { ...(config.providers.ollama ?? {}), baseUrl: url };
    console.log('  saved. Pick "Ollama" as your provider in the Model section to use it.');
  }
  saveConfig(config);
}

async function sectionWebUI(rl: Interface): Promise<void> {
  const config = loadConfig(true);
  console.log(`The daemon binds to http://127.0.0.1:${config.daemon.port}; put a TLS proxy in front for public access.`);
  const publicUrl = (await rl.question(`Public URL for login links [${config.daemon.publicUrl ?? 'none'}]: `)).trim();
  if (publicUrl) config.daemon.publicUrl = publicUrl;
  else if (publicUrl === '' && config.daemon.publicUrl) {
    // keep as-is on bare Enter
  }
  saveConfig(config);
}

async function sectionReview(_rl: Interface): Promise<void> {
  const config = loadConfig(true);
  const profiles = listProfiles();
  const claude = claudeAuthStatus();
  console.log('Current configuration:\n');
  console.log(statusSummary(config, profiles, claude));
  console.log('\nVerify it live:  amrita doctor');
}

interface Section {
  key: string;
  title: string;
  run: (rl: Interface) => Promise<void>;
}

const SECTIONS: Section[] = [
  { key: 'model', title: 'Model & provider', run: sectionModel },
  { key: 'credentials', title: 'API credentials', run: sectionCredentials },
  { key: 'telegram', title: 'Telegram channel', run: sectionTelegram },
  { key: 'connectors', title: 'Connectors (Claude Code, Open Design)', run: sectionConnectors },
  { key: 'endpoint', title: 'Local model endpoint', run: sectionEndpoint },
  { key: 'webui', title: 'Web UI / public URL', run: sectionWebUI },
  { key: 'review', title: 'Review & verify', run: sectionReview },
];

// ───────────────────────── entry point ─────────────────────────

export async function setupCommand(args: string[]): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  backupConfig();

  // Focused subcommand: `amrita setup model`, `amrita setup telegram`, …
  const direct = args[0] && SECTIONS.find((s) => s.key === args[0]);
  try {
    if (direct) {
      console.log(`Amrita setup — ${direct.title}\n`);
      await direct.run(rl);
      console.log('\nSaved. Run `amrita doctor` to verify.');
      return;
    }

    // Menu loop.
    for (;;) {
      const config = loadConfig(true);
      const profiles = listProfiles();
      const claude = claudeAuthStatus();
      console.log("\nAmrita setup — choose how Amrita's brain connects and which channels run.\n");
      console.log(statusSummary(config, profiles, claude));
      console.log('\nSections:');
      SECTIONS.forEach((s, i) => console.log(`  ${i + 1}. ${s.title}`));
      console.log('  0. Done');

      // Recommend the model section first while the provider isn't usable.
      const providerOk = config.model.provider === 'auto'
        ? Boolean(profiles.find((p) => p.id === resolveProviderId('auto', healthInput(claude))) && claude.loggedIn)
        : isProviderHealthy(profiles.find((p) => p.id === config.model.provider) ?? profiles[0]!, healthInput(claude));
      const def = providerOk ? '0' : '1';

      const pick = (await rl.question(`\nSection number [${def}]: `)).trim() || def;
      if (pick === '0') break;
      const section = SECTIONS[Number(pick) - 1];
      if (!section) {
        console.log('  (no such section)');
        continue;
      }
      console.log(`\n── ${section.title} ──`);
      await section.run(rl);
    }

    const config = loadConfig(true);
    console.log(`\nDone — provider ${config.model.provider} / ${config.model.model}. Next steps:
  amrita doctor   — verify everything (incl. live login status)
  amrita daemon   — start the daemon (web UI + telegram + scheduler)
  amrita chat     — talk from this terminal right now`);
  } finally {
    rl.close();
  }
}
