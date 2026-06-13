import {
  backupBeforeReconfigure,
  secretsEnvPath,
  writeConfig,
  writeSecretsEnv,
} from '@amrita/daemon';
import { CliError, type InProcessClient } from './client.ts';
import { resolveWriteContext } from './context.ts';

/**
 * `amrita setup` — the first-run wizard (ADR-0024). Sectioned and idempotent
 * like the v0.1 wizard: provider → telegram → summary. Secrets go to
 * `~/.amrita/secrets.env` (0600); the store only ever sees env-var NAMES.
 *
 * Every effect goes through the same RPC methods as the individual commands
 * (`accounts.connect`, `accounts.bindSecretRef`, `providers.role.set`), so the
 * wizard can never do something the CLI cannot.
 */

/** Minimal fetch shape the telegram probe needs — injectable for tests. */
export type ProbeFetch = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface SetupDeps {
  /** Plain-text question; returns the trimmed answer ('' for Enter). */
  ask(question: string): Promise<string>;
  /** Masked question for pasted secrets; echo is suppressed by the caller. */
  askSecret(question: string): Promise<string>;
  out(line: string): void;
  fetchImpl: ProbeFetch;
  env: NodeJS.ProcessEnv;
  /** ISO timestamp for backup stamps + lastSetupAt (injected; tests may omit). */
  now?: string;
}

/** One `providers.catalog` entry (ADR-0025) — the wizard renders FROM this. */
interface CatalogEntry {
  id: string;
  title: string;
  group: 'login' | 'api_key' | 'local';
  authMode: string;
  defaultModel: string;
  executable: boolean;
  envName?: string;
  keyUrl?: string;
  installHint?: string;
  state: 'ready' | 'needs_key' | 'needs_login' | 'missing_cli' | 'needs_endpoint' | 'unavailable';
  detail: string;
  fix?: string;
}

interface ProviderInfoLite {
  id: string;
  available: boolean;
  envReady: boolean;
}
interface AccountLite {
  id: string;
  provider: string;
  authMode?: string;
  secretRef: string | null;
}

const GROUP_TITLES: Record<CatalogEntry['group'], string> = {
  login: 'Subscription / login (no API key anywhere)',
  api_key: 'API key',
  local: 'Local / self-hosted',
};

const STATE_MARKS: Record<CatalogEntry['state'], string> = {
  ready: '✓',
  needs_key: '·',
  needs_login: '!',
  missing_cli: '✗',
  needs_endpoint: '·',
  unavailable: '✗',
};

/** v0.1 lesson: recommend what will actually work — ready login > ready key > anthropic. */
function recommendedIndex(entries: CatalogEntry[]): number {
  const ready = entries.findIndex((e) => e.executable && e.state === 'ready');
  if (ready >= 0) return ready + 1;
  const anthropic = entries.findIndex((e) => e.id === 'anthropic');
  return anthropic >= 0 ? anthropic + 1 : 1;
}

function isYes(answer: string, defaultYes: boolean): boolean {
  const a = answer.trim().toLowerCase();
  if (a === '') return defaultYes;
  return a === 'y' || a === 'yes';
}

/** Save into the secrets file AND the live process env so this run sees it. */
function saveSecret(name: string, value: string, env: NodeJS.ProcessEnv): void {
  writeSecretsEnv({ [name]: value }, env);
  env[name] = value;
}

/** Connect-or-reuse the account for `provider`; bind `envName` for key auth. */
async function ensureAccount(
  client: InProcessClient,
  provider: string,
  authMode: 'api_key' | 'subscription_cli' | 'local_endpoint',
  envName?: string,
): Promise<string> {
  const accounts = await client.call<AccountLite[]>('accounts.list');
  const existing = accounts.find((a) => a.provider === provider);
  if (existing) {
    if (envName && existing.secretRef !== envName) {
      await client.call('accounts.bindSecretRef', { accountId: existing.id, envName });
    }
    return existing.id;
  }
  const ctx = await resolveWriteContext(client, {});
  const created = await client.call<{ accountId: string }>('accounts.connect', {
    projectId: ctx.projectId,
    conversationId: ctx.conversationId,
    provider,
    authMode,
  });
  if (envName) {
    await client.call('accounts.bindSecretRef', { accountId: created.accountId, envName });
  }
  return created.accountId;
}

async function sectionProvider(client: InProcessClient, deps: SetupDeps): Promise<void> {
  const { out, ask } = deps;
  const entries = await client.call<CatalogEntry[]>('providers.catalog');
  out('');
  out('── Brain (model provider) ──');
  let lastGroup: CatalogEntry['group'] | null = null;
  for (const [i, e] of entries.entries()) {
    if (e.group !== lastGroup) {
      out(`  ${GROUP_TITLES[e.group]}:`);
      lastGroup = e.group;
    }
    const mark = STATE_MARKS[e.state];
    out(`    ${i + 1}) ${e.title}`);
    out(`         ${mark} ${e.detail}`);
  }
  out('    0) skip for now (the deterministic mock provider keeps working)');
  const rec = recommendedIndex(entries);
  out(`  Recommended: ${rec}) ${entries[rec - 1]?.title ?? ''}`);

  // Choice loop: unavailable picks explain themselves and return here — the
  // user always has a way forward (another provider, or 0 to skip).
  for (;;) {
    const answer = await ask(`Choose a brain [${rec}]: `);
    const idx = answer.trim() === '' ? rec : Number(answer.trim());
    if (idx === 0) {
      out('  → skipped — chat uses the deterministic mock provider until one is configured');
      return;
    }
    const entry = entries[idx - 1];
    if (!entry || !Number.isInteger(idx)) {
      out(`  ! '${answer.trim()}' is not an option — pick a number from the list (0 to skip)`);
      continue;
    }
    const done = await configureProvider(client, deps, entry);
    if (done) return;
  }
}

/** Configure one catalog entry. Returns false to send the user back to the menu. */
async function configureProvider(
  client: InProcessClient,
  deps: SetupDeps,
  entry: CatalogEntry,
): Promise<boolean> {
  const { out, ask } = deps;
  if (!entry.executable) {
    out(`  ✗ ${entry.title}: ${entry.detail}`);
    if (entry.state === 'missing_cli' && entry.installHint) {
      out(`    install: ${entry.installHint}`);
    }
    return false;
  }
  switch (entry.authMode) {
    case 'subscription_cli':
      return configureSubscription(client, deps, entry);
    case 'local_endpoint':
      return configureLocalEndpoint(client, deps, entry);
    default:
      return configureApiKey(client, deps, entry);
  }
}

async function configureSubscription(
  client: InProcessClient,
  deps: SetupDeps,
  entry: CatalogEntry,
): Promise<boolean> {
  const { out, ask } = deps;
  if (entry.state === 'missing_cli') {
    out(`  ✗ ${entry.detail}`);
    out(`    install: ${entry.installHint ?? ''} — then re-run \`amrita setup\``);
    return false;
  }
  if (entry.state === 'needs_login') {
    out(`  ! ${entry.detail}`);
    out(`    fix: ${entry.fix ?? 'log in once, then re-run `amrita setup`'}`);
    if (
      !isYes(await ask('  Bind it as your brain anyway (it will work after login)? (y/N): '), false)
    ) {
      return false;
    }
  } else {
    out(`  ✓ ${entry.detail}`);
  }
  await ensureAccount(client, entry.id, 'subscription_cli');
  await client.call('providers.role.set', { role: 'main', provider: entry.id });
  out(`  ✓ ${entry.id} bound as your main brain (model: ${entry.defaultModel})`);
  out('    Amrita invokes your logged-in CLI session — no key is stored or forwarded.');
  return true;
}

async function configureApiKey(
  client: InProcessClient,
  deps: SetupDeps,
  entry: CatalogEntry,
): Promise<boolean> {
  const { out, ask, askSecret, env } = deps;
  const envName = entry.envName ?? `${entry.id.toUpperCase()}_API_KEY`;
  const hasValue = typeof env[envName] === 'string' && env[envName] !== '';
  if (hasValue) {
    out(`  ✓ ${envName} already set — keeping the existing value`);
  } else {
    if (entry.keyUrl) out(`  Get a key at: ${entry.keyUrl}`);
    const key = await askSecret(`  Paste your ${envName} (Enter to go back): `);
    if (key.trim() === '') {
      out('  → no key entered');
      return false;
    }
    saveSecret(envName, key.trim(), env);
    out(`  ✓ saved to ${secretsEnvPath(env)} (0600) — the database stores the NAME only`);
  }

  const model = (await ask(`  Model [${entry.defaultModel}]: `)).trim();
  await ensureAccount(client, entry.id, 'api_key', envName);
  await client.call('providers.role.set', {
    role: 'main',
    provider: entry.id,
    ...(model ? { model } : {}),
  });

  const providers = await client.call<ProviderInfoLite[]>('providers.list');
  const live = providers.find((p) => p.id === entry.id);
  if (live?.available) {
    out(`  ✓ ${entry.id} connected and bound as your main brain — env ready`);
  } else {
    out(`  ! ${entry.id} bound as main, but ${envName} is still missing —`);
    out('    chat falls back honestly until the key is present');
  }
  return true;
}

interface EndpointProbe {
  ok: boolean;
  models: string[];
  probedUrl: string;
  detail: string;
  suggestedUrl?: string;
}

async function configureLocalEndpoint(
  client: InProcessClient,
  deps: SetupDeps,
  entry: CatalogEntry,
): Promise<boolean> {
  const { out, ask, askSecret, env } = deps;
  out('  Any OpenAI-compatible server works: Ollama, vLLM, LM Studio, llama.cpp.');
  const baseUrlAnswer = (await ask('  Base URL [http://localhost:11434/v1]: ')).trim();
  let baseUrl = baseUrlAnswer === '' ? 'http://localhost:11434/v1' : baseUrlAnswer;

  // Optional key first, so the /models probe can authenticate.
  const key = await askSecret('  API key, if your server needs one (Enter for none): ');
  let keyEnv: string | undefined;
  if (key.trim() !== '') {
    keyEnv = 'LOCAL_LLM_API_KEY';
    saveSecret(keyEnv, key.trim(), env);
    out(`  ✓ key saved to ${secretsEnvPath(env)} (0600) as ${keyEnv}`);
  }

  // Live probe: /v1 hint for local servers + /models discovery (Hermes flow).
  const probe = await client.call<EndpointProbe>('providers.probeEndpoint', {
    baseUrl,
    ...(keyEnv ? { keyEnv } : {}),
  });
  if (probe.suggestedUrl && probe.suggestedUrl !== baseUrl) {
    out(`  Hint: local servers usually need /v1 — using ${probe.suggestedUrl}`);
    baseUrl = probe.suggestedUrl;
  }
  if (probe.ok) {
    out(`  ✓ endpoint verified via ${probe.probedUrl} — ${probe.detail}`);
  } else {
    out(`  ! could not verify the endpoint (${probe.detail}) — you can still proceed`);
  }

  // Model selection: pick from discovered list, or type a name.
  let model = '';
  if (probe.models.length === 1) {
    model = probe.models[0] ?? '';
    out(`  Using the only model the endpoint reports: ${model}`);
  } else if (probe.models.length > 1) {
    out('  Models the endpoint reports:');
    for (const [i, m] of probe.models.slice(0, 20).entries()) out(`    ${i + 1}) ${m}`);
    const pick = (await ask('  Select a model [1] or type a name: ')).trim();
    const idx = pick === '' ? 1 : Number(pick);
    model =
      Number.isInteger(idx) && idx >= 1 && idx <= probe.models.length
        ? (probe.models[idx - 1] ?? '')
        : pick;
  } else {
    model = (await ask('  Model name (e.g. llama3.1, qwen2.5) — required: ')).trim();
  }
  if (model === '') {
    out('  ! a local endpoint needs a model name — ask your server (`ollama list`)');
    return false;
  }

  const ctx = await resolveWriteContext(client, {});
  await client.call('settings.update', {
    projectId: ctx.projectId,
    conversationId: ctx.conversationId,
    key: 'providers.endpoint.local',
    value: { baseUrl, model, ...(keyEnv ? { keyEnv } : {}) },
  });
  await ensureAccount(client, entry.id, 'local_endpoint');
  await client.call('providers.role.set', { role: 'main', provider: entry.id });
  out(`  ✓ local endpoint bound as your main brain — ${baseUrl} · ${model}`);
  return true;
}

/** Live getMe probe — honest validation, 5s timeout, never throws. */
async function probeTelegramToken(
  token: string,
  fetchImpl: ProbeFetch,
): Promise<{ ok: boolean; username?: string }> {
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { ok: false };
    const body = (await res.json()) as { ok?: boolean; result?: { username?: string } };
    if (body.ok !== true) return { ok: false };
    return { ok: true, ...(body.result?.username ? { username: body.result.username } : {}) };
  } catch {
    return { ok: false };
  }
}

async function sectionTelegram(deps: SetupDeps): Promise<void> {
  const { out, ask, askSecret, env, fetchImpl } = deps;
  out('');
  out('── Telegram channel ──');
  const already =
    typeof env.TELEGRAM_BOT_TOKEN === 'string' &&
    env.TELEGRAM_BOT_TOKEN !== '' &&
    typeof env.AMRITA_TELEGRAM_ALLOWED_IDS === 'string' &&
    env.AMRITA_TELEGRAM_ALLOWED_IDS !== '';
  if (already) {
    out('  ✓ telegram already configured (token + allowlist present)');
    if (!isYes(await ask('  Reconfigure? (y/N): '), false)) return;
  } else if (!isYes(await ask('Enable Telegram? (y/N): '), false)) {
    out('  → skipped — enable later with `amrita setup`');
    return;
  }

  out('  Create a bot with @BotFather (/newbot) to get a token.');
  const token = await askSecret('  Paste the bot token (Enter to skip): ');
  if (token.trim() === '') {
    out('  → no token entered — telegram stays "needs setup"');
    return;
  }
  const probe = await probeTelegramToken(token.trim(), fetchImpl);
  if (probe.ok) {
    out(`  ✓ token verified live — bot @${probe.username ?? 'unknown'}`);
  } else {
    out('  ! token did NOT verify against api.telegram.org');
    if (!isYes(await ask('  Save it anyway? (y/N): '), false)) {
      out('  → not saved');
      return;
    }
  }
  saveSecret('TELEGRAM_BOT_TOKEN', token.trim(), env);

  out('  Get your numeric id from @userinfobot. Only these ids may talk to the bot.');
  const ids = await ask('  Allowed user id(s), comma-separated: ');
  const cleaned = ids
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (cleaned.length === 0 || cleaned.some((s) => !/^\d+$/.test(s))) {
    throw new CliError('allowed ids must be comma-separated numbers (from @userinfobot)');
  }
  saveSecret('AMRITA_TELEGRAM_ALLOWED_IDS', cleaned.join(','), env);
  out(`  ✓ saved — ${cleaned.length} allowed id(s)`);
}

// ── model roles (fast / main / deep) ────────────────────────────────────────

interface RoleStatusLite {
  roles: { role: string; resolvesTo: string; via: string; model?: string }[];
}

async function sectionRoles(client: InProcessClient, deps: SetupDeps): Promise<void> {
  const { out, ask } = deps;
  out('');
  out('── Model roles (fast / main / deep) ──');
  out('  Roles let cheap turns use a fast brain and hard turns a deep one.');
  const known = await client.call<{ id: string }[]>('providers.list');
  const ids = known.map((p) => p.id);
  const status = await client.call<RoleStatusLite>('runtime.status');
  for (const role of ['fast', 'main', 'deep'] as const) {
    const cur = status.roles.find((r) => r.role === role);
    const shown = cur ? `${cur.resolvesTo} (via ${cur.via})` : 'auto';
    const answer = (
      await ask(`  ${role} brain [${shown}] (provider id, 'auto', or Enter to keep): `)
    ).trim();
    if (answer === '') continue;
    if (answer === 'auto') {
      await client.call('providers.role.clear', { role });
      out(`  ✓ ${role} → auto`);
      continue;
    }
    if (!ids.includes(answer)) {
      out(`  ! unknown provider '${answer}' (known: ${ids.join(', ')}) — kept ${shown}`);
      continue;
    }
    await client.call('providers.role.set', { role, provider: answer });
    out(`  ✓ ${role} → ${answer}`);
  }
}

// ── coding runtimes (informational; honest live probes) ─────────────────────

interface RuntimeLite {
  codingRuntimes: {
    id: string;
    title: string;
    state: string;
    detail: string;
    nextCommand?: string;
  }[];
}

async function sectionRuntime(client: InProcessClient, deps: SetupDeps): Promise<void> {
  const { out } = deps;
  out('');
  out('── Coding runtimes ──');
  const status = await client.call<RuntimeLite>('runtime.status');
  for (const rt of status.codingRuntimes) {
    const mark = rt.state === 'ready' ? '✓' : rt.state === 'not_installed' ? '✗' : '!';
    out(`  ${mark} ${rt.title} — ${rt.detail}`);
    if (rt.nextCommand && rt.state !== 'ready') out(`      → ${rt.nextCommand}`);
  }
  out('  Coding runtimes power lanes (delegated work); they are independent of your brain.');
}

// ── daemon / service (informational) ────────────────────────────────────────

async function sectionService(_client: InProcessClient, deps: SetupDeps): Promise<void> {
  const { out } = deps;
  out('');
  out('── Daemon / service ──');
  out('  Run Amrita in the background to serve the web UI and Telegram:');
  out('    amritad --http --telegram        # foreground (recommended on WSL)');
  out('  For a systemd user service (Linux), re-run the installer and accept the');
  out('  service prompt; then logs are: journalctl --user -u amritad -f');
}

// ── agent / runtime settings (real lane execution opt-in) ───────────────────

async function sectionAgent(_client: InProcessClient, deps: SetupDeps): Promise<void> {
  const { out, ask, env } = deps;
  out('');
  out('── Agent settings ──');
  const realOn = env.AMRITA_LANES_ALLOW_REAL_EXECUTION === '1';
  out(
    `  Real lane execution (Claude Code runs for real): ${realOn ? 'ENABLED' : 'disabled (safe default)'}`,
  );
  out('  Operator approvals gate every real run (ADR-0021) — dry-run lanes always work.');
  if (!realOn) {
    if (isYes(await ask('  Enable real lane execution? (y/N): '), false)) {
      saveSecret('AMRITA_LANES_ALLOW_REAL_EXECUTION', '1', env);
      out('  ✓ enabled (workspace-confined, env-scrubbed) — restart the daemon to apply');
    } else {
      out('  → kept disabled');
    }
  } else if (isYes(await ask('  Disable real lane execution? (y/N): '), false)) {
    saveSecret('AMRITA_LANES_ALLOW_REAL_EXECUTION', '0', env);
    out('  ✓ disabled — restart the daemon to apply');
  }
}

// ── tools / connectors / plugins (honest detected/unavailable) ──────────────

interface ConnectorStatusLite {
  manifest: { slug: string; title: string };
  state: string;
  detail: string;
  nextCommand?: string;
}

async function sectionTools(client: InProcessClient, deps: SetupDeps): Promise<void> {
  const { out } = deps;
  out('');
  out('── Tools & connectors ──');
  const connectors = await client.call<ConnectorStatusLite[]>('connectors.status');
  for (const c of connectors) {
    const mark = c.state === 'connected' ? '✓' : c.state === 'needs_setup' ? '·' : '!';
    out(`  ${mark} ${c.manifest.title} — ${c.detail}`);
    if (c.nextCommand && c.state !== 'connected') out(`      → ${c.nextCommand}`);
  }
  out('  Plugins / skills / MCP: not implemented in v2 yet — they appear here when they land.');
}

async function sectionSummary(client: InProcessClient, deps: SetupDeps): Promise<void> {
  const { out } = deps;
  const report = await client.call<{ status: string; fixes: string[] }>('doctor');
  out('');
  out('── Summary ──');
  out(
    `  doctor: ${report.status}${report.fixes.length ? ` · ${report.fixes.length} fix(es) remaining` : ''}`,
  );
  out('');
  out('Next:');
  out('  amrita chat "hello"            # first real turn with your brain');
  out('  amritad --http --telegram      # start the daemon (web + telegram)');
  out('  amrita doctor                  # full health report any time');
}

// ── section registry + flow routing (Hermes SETUP_SECTIONS lesson) ──────────

type SectionHandler = (client: InProcessClient, deps: SetupDeps) => Promise<void>;

export interface SetupSection {
  id: string;
  title: string;
  run: SectionHandler;
}

/** Every setup section, addressable as `amrita setup <id>` (ADR-0026). */
export const SETUP_SECTIONS: readonly SetupSection[] = [
  { id: 'brain', title: 'Brain (model provider)', run: sectionProvider },
  { id: 'roles', title: 'Model roles', run: sectionRoles },
  { id: 'runtime', title: 'Coding runtimes', run: sectionRuntime },
  { id: 'channels', title: 'Channels (Telegram)', run: (_c, d) => sectionTelegram(d) },
  { id: 'service', title: 'Daemon / service', run: sectionService },
  { id: 'agent', title: 'Agent settings', run: sectionAgent },
  { id: 'tools', title: 'Tools & connectors', run: sectionTools },
];

export const SETUP_SECTION_IDS = SETUP_SECTIONS.map((s) => s.id);

/** A filesystem-safe backup stamp derived from an ISO time (or a fallback). */
function backupStamp(now?: string): string {
  return (now ?? 'manual').replace(/[:.]/g, '-');
}

export interface SetupOptions {
  /** Run exactly one section by id (`amrita setup <section>`). */
  section?: string;
  /** Run every section (full reconfigure) instead of the quick essentials. */
  full?: boolean;
}

/**
 * The first-run wizard and reconfigure entry point (ADR-0024/0026).
 *
 * - `section` → back up, run that one section, done.
 * - `full` → back up, run every section, summary.
 * - default → quick essentials (brain + channels) + summary — the first-run path.
 *
 * Sections are idempotent and show current values; existing config/secrets are
 * backed up to `*.bak.<stamp>` before a full or section reconfigure.
 */
export async function runSetupWizard(
  client: InProcessClient,
  deps: SetupDeps,
  opts: SetupOptions = {},
): Promise<void> {
  deps.out('Amrita setup — sections are idempotent; re-run any time.');
  deps.out(`Secrets file: ${secretsEnvPath(deps.env)} (created on first save, mode 0600)`);

  if (opts.section) {
    const section = SETUP_SECTIONS.find((s) => s.id === opts.section);
    if (!section) {
      throw new CliError(
        `unknown setup section '${opts.section}' (sections: ${SETUP_SECTION_IDS.join(', ')})`,
      );
    }
    backupBeforeReconfigure(backupStamp(deps.now), deps.env);
    await section.run(client, deps);
    markSetupComplete(deps);
    return;
  }

  if (opts.full) {
    const backups = backupBeforeReconfigure(backupStamp(deps.now), deps.env);
    if (backups.length > 0) deps.out(`  (backed up ${backups.length} file(s) before reconfigure)`);
    for (const section of SETUP_SECTIONS) await section.run(client, deps);
  } else {
    // Quick essentials — the default first-run path.
    await sectionProvider(client, deps);
    await sectionTelegram(deps);
  }
  await sectionSummary(client, deps);
  markSetupComplete(deps);
}

/** Best-effort: record that setup ran, in the non-secret config file. */
function markSetupComplete(deps: SetupDeps): void {
  try {
    writeConfig({ setupComplete: true, ...(deps.now ? { lastSetupAt: deps.now } : {}) }, deps.env);
  } catch {
    // config persistence is best-effort; the DB + secrets file are the source of truth
  }
}

/**
 * Guard rail when there is no TTY: print the exact non-interactive equivalent,
 * tailored to the requested section (Hermes lesson: never a broken wizard in a
 * headless env — give the config commands instead).
 */
export function nonInteractiveGuidance(section?: string): string {
  const head =
    section && SETUP_SECTION_IDS.includes(section)
      ? `setup section '${section}' needs an interactive terminal. Non-interactive equivalent:`
      : 'setup needs an interactive terminal. Non-interactive equivalent:';
  const bySection: Record<string, string[]> = {
    brain: [
      '  amrita account connect --provider anthropic',
      '  amrita account bind-secret <ACCOUNT_ID> ANTHROPIC_API_KEY',
      '  amrita role set main anthropic',
      "  printf 'ANTHROPIC_API_KEY=...\\n' >> ~/.amrita/secrets.env && chmod 600 ~/.amrita/secrets.env",
    ],
    roles: ['  amrita role set fast <provider>', '  amrita role set main <provider>'],
    channels: [
      "  printf 'TELEGRAM_BOT_TOKEN=...\\nAMRITA_TELEGRAM_ALLOWED_IDS=...\\n' >> ~/.amrita/secrets.env",
      '  chmod 600 ~/.amrita/secrets.env   # then: amritad --http --telegram',
    ],
    agent: [
      "  printf 'AMRITA_LANES_ALLOW_REAL_EXECUTION=1\\n' >> ~/.amrita/secrets.env  # opt in to real lanes",
    ],
    runtime: ['  amrita runtime status', '  npm install -g @anthropic-ai/claude-code'],
    service: ['  amritad --http --telegram', '  # systemd: re-run scripts/install.sh'],
    tools: ['  amrita connectors status'],
  };
  const body = (section && bySection[section]) ?? [
    '  amrita account connect --provider anthropic',
    '  amrita account bind-secret <ACCOUNT_ID> ANTHROPIC_API_KEY',
    '  amrita role set main anthropic',
    "  printf 'ANTHROPIC_API_KEY=...\\nTELEGRAM_BOT_TOKEN=...\\nAMRITA_TELEGRAM_ALLOWED_IDS=...\\n' >> ~/.amrita/secrets.env && chmod 600 ~/.amrita/secrets.env",
  ];
  return [head, ...body].join('\n');
}

// ── interactive wiring (TTY only; tests inject SetupDeps instead) ────────────

// Line buffer shared across reads: terminals (notably WSL pseudo-ttys) may
// split one typed line across data chunks or batch several lines into one.
// Treating "one chunk = one answer" made a stray newline land as the NEXT
// question's empty answer (live-QA bug: answering `y` to telegram skipped it).
let pendingInput = '';

/** Read one line in canonical mode — the terminal echoes typed input itself. */
function readLine(): Promise<string> {
  return new Promise((resolve) => {
    const takeLine = (): boolean => {
      const i = pendingInput.indexOf('\n');
      if (i < 0) return false;
      const line = pendingInput.slice(0, i).replace(/\r$/, '');
      pendingInput = pendingInput.slice(i + 1);
      process.stdin.off('data', onData);
      process.stdin.pause();
      resolve(line);
      return true;
    };
    const onData = (chunk: Buffer): void => {
      pendingInput += chunk.toString('utf8');
      takeLine();
    };
    if (takeLine()) return; // a complete line is already buffered
    process.stdin.on('data', onData);
    process.stdin.resume();
  });
}

/** Read one line in raw mode with echo suppressed — for pasted secrets. */
function readSecretLine(): Promise<string> {
  return new Promise((resolve) => {
    // Drain a complete line the canonical reader already buffered (batched
    // paste / piped input) before touching the terminal at all.
    const buffered = pendingInput.indexOf('\n');
    if (buffered >= 0) {
      const line = pendingInput.slice(0, buffered).replace(/\r$/, '');
      pendingInput = pendingInput.slice(buffered + 1);
      process.stdout.write('\n');
      resolve(line);
      return;
    }
    const stdin = process.stdin;
    stdin.setRawMode?.(true);
    stdin.resume();
    let buf = '';
    const finish = (value: string): void => {
      stdin.off('data', onData);
      stdin.setRawMode?.(false);
      stdin.pause();
      process.stdout.write('\n');
      resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      for (let i = 0; i < text.length; i++) {
        const ch = text[i] as string;
        if (ch === '\n' || ch === '\r' || ch === '\u0004') {
          // Preserve anything after the terminator (a multi-line paste) for
          // the NEXT question instead of silently discarding it.
          const rest = text.slice(i + 1);
          pendingInput += ch === '\r' && rest.startsWith('\n') ? rest.slice(1) : rest;
          finish(buf);
          return;
        }
        if (ch === '\u0003') {
          // Ctrl+C: restore the terminal before going down
          stdin.setRawMode?.(false);
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

/** Real-terminal SetupDeps: stdout prompts, masked secrets, global fetch. */
export function makeInteractiveDeps(): SetupDeps {
  return {
    ask: (q) => {
      process.stdout.write(q);
      return readLine();
    },
    askSecret: (q) => {
      process.stdout.write(q);
      return readSecretLine();
    },
    out: (line) => process.stdout.write(`${line}\n`),
    fetchImpl: (url, init) => fetch(url, init),
    env: process.env,
    now: new Date().toISOString(),
  };
}
