import { existsSync } from 'node:fs';
import type { DoctorCheck, DoctorReport, DoctorSection, DoctorStatus } from '@amrita/protocol';
import {
  CINEMA_BRIDGE_TOKEN_ENV,
  CINEMA_BRIDGE_URL_ENV,
  cinemaBridgeTokenPresent,
  cinemaProviders,
} from './cinema.ts';
import { CONNECTOR_MANIFESTS } from './connectors.ts';
import {
  amritaHome,
  checkPermissions,
  configJsonPath,
  readConfig,
  secretsEnvPath,
} from './home.ts';
import type { AmritaKernel } from './kernel.ts';
import { PROVIDER_ROLES, envPresent } from './provider.ts';
import { CODING_RUNTIMES, type CodingRuntimeStatus } from './runtimes.ts';

/**
 * Doctor — grouped setup/health checks over the kernel (PLAN §5.4).
 *
 * Scoping rules (ported from v0.1): something *unconfigured by default* is a
 * `warn` ("needs setup"), while something *explicitly configured but unusable*
 * (an account bound to an env var that is not set) is a `fail`. Every warn/fail
 * carries an exact fix command; the report ends with a numbered fix list.
 *
 * Honesty rules: presence-only env checks (never a value), and no capability is
 * reported better than it is — e.g. Telegram says its live bot runner is not
 * bundled, even though the transport itself is implemented and tested.
 */

// Report shapes are protocol-owned wire contracts since ADR-0032.
export type { DoctorCheck, DoctorReport, DoctorSection, DoctorStatus };

function worst(checks: DoctorCheck[]): DoctorStatus {
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  if (checks.some((c) => c.status === 'warn')) return 'warn';
  return 'ok';
}

/**
 * Home / config / secrets group (ADR-0026 / Hermes doctor lesson). Reports the
 * machine-local paths and — critically — flags permissions looser than required
 * (home 0700, secrets/config 0600), with `amrita doctor --fix` as the remedy.
 * Presence + mode only; never reads a secret value.
 */
function homeSection(kernel: AmritaKernel): DoctorSection {
  const checks: DoctorCheck[] = [];
  checks.push({
    id: 'home.dir',
    label: 'amrita home',
    status: 'ok',
    detail: `${amritaHome()} · db ${kernel.health().dbPath}`,
  });

  const secretsPath = secretsEnvPath();
  checks.push({
    id: 'home.secrets',
    label: 'secrets file',
    status: 'ok',
    detail: existsSync(secretsPath)
      ? `${secretsPath} (present; env-var NAMES only ever reach the store)`
      : 'none yet — created on first `amrita setup` save',
  });

  const cfg = readConfig();
  checks.push({
    id: 'home.config',
    label: 'config',
    status: 'ok',
    detail: existsSync(configJsonPath())
      ? `${configJsonPath()}${cfg.lastSetupAt ? ` · last setup ${cfg.lastSetupAt}` : ''}`
      : 'none yet (defaults in effect)',
  });

  // Permissions: anything looser than required is a fail with an exact --fix.
  for (const issue of checkPermissions()) {
    checks.push({
      id: `home.perm.${issue.label.replace(/\s+/g, '-')}`,
      label: `${issue.label} permissions`,
      status: 'fail',
      detail: `${issue.path} is ${issue.actualMode.toString(8).padStart(3, '0')}, expected ${issue.expectedMode.toString(8).padStart(3, '0')}`,
      fix: 'amrita doctor --fix  # tightens home (0700) and secret/config files (0600)',
    });
  }
  return { title: 'home', checks };
}

/**
 * Coding-runtime group (ADR-0026): every registered runtime with its live
 * probe state. Claude Code carries auth state; detection-only runtimes
 * (codex/opencode) say so honestly. Never claims a runtime is runnable
 * without evidence.
 */
function runtimesSectionFrom(runtimes: CodingRuntimeStatus[]): DoctorSection {
  const checks: DoctorCheck[] = runtimes.map((rt) => {
    // An EXECUTABLE runtime (claude-code, codex — both real lane runners + chat
    // providers) that is installed-but-unauthenticated is a warn worth acting on;
    // masking codex as `ok` when logged out hid a runtime Amrita can actually
    // drive (community-onboarding finding 13). Genuinely detection-only runtimes
    // (opencode, executable:false) and never-installed stay informational `ok`.
    const executable = CODING_RUNTIMES.find((r) => r.id === rt.id)?.executable === true;
    const ready = rt.state === 'ready';
    const actionableUnauth =
      rt.state === 'installed_unauthenticated' || rt.state === 'installed_auth_unknown';
    const status: DoctorStatus = ready ? 'ok' : executable && actionableUnauth ? 'warn' : 'ok';
    return {
      id: `runtime.${rt.id}`,
      label: rt.title,
      status,
      detail: rt.detail + (rt.version ? ` · ${rt.version}` : ''),
      ...(status === 'warn' && rt.nextCommand ? { fix: rt.nextCommand } : {}),
    };
  });
  return { title: 'runtimes', checks };
}

function storeSection(kernel: AmritaKernel): DoctorSection {
  const h = kernel.health();
  const c = h.counts;
  return {
    title: 'store',
    checks: [
      {
        id: 'store.schema',
        label: 'event store schema',
        status: h.schemaVersion >= 0 ? 'ok' : 'fail',
        detail:
          h.schemaVersion >= 0
            ? `v${h.schemaVersion} · ${h.dbPath}`
            : `no applied migrations in ${h.dbPath}`,
        ...(h.schemaVersion >= 0 ? {} : { fix: 'amritad --db <PATH>  # migrations run on open' }),
      },
      {
        id: 'store.counts',
        label: 'rows',
        status: 'ok',
        detail: `projects ${c.projects} · conversations ${c.conversations} · messages ${c.messages} · events ${c.events}`,
      },
    ],
  };
}

function providerSection(kernel: AmritaKernel): DoctorSection {
  const accounts = kernel.listAccounts();
  const checks: DoctorCheck[] = [];
  for (const p of kernel.listProviders()) {
    if (p.kind === 'mock') {
      checks.push({
        id: 'provider.mock',
        label: 'mock provider',
        status: 'ok',
        detail: 'deterministic, always available',
      });
      continue;
    }
    // Detection-only catalog entries (e.g. codex) are not actionable setup
    // state — the chooser explains them; doctor stays signal-only.
    if (p.executable === false) continue;
    const all = accounts.filter((a) => a.provider === p.id);
    const bound = all.filter((a) => a.secretRef);
    const unbound = all.filter((a) => !a.secretRef);
    // Login + local providers: presence-only here (live login state comes from
    // `providers.catalog` / `runtime status`, never claimed by doctor).
    if (p.authMode === 'subscription_cli' || p.authMode === 'local_endpoint') {
      if (p.available) {
        checks.push({
          id: `provider.${p.id}`,
          label: `${p.id} provider`,
          status: 'ok',
          detail:
            p.authMode === 'subscription_cli'
              ? 'configured — subscription login (live state: amrita runtime status)'
              : 'local endpoint configured',
        });
      } else if (all.length > 0) {
        checks.push({
          id: `provider.${p.id}`,
          label: `${p.id} provider`,
          status: 'warn',
          detail: 'account connected but the endpoint/login is not configured',
          fix: 'amrita setup',
        });
      }
      // unconfigured login/local providers are silent here — the single
      // "no brain" warning below covers them without 7 lines of noise.
      continue;
    }
    if (bound.length === 0 && unbound.length === 0) continue; // covered by the summary warn
    if (p.envReady) {
      checks.push({
        id: `provider.${p.id}`,
        label: `${p.id} provider`,
        status: 'ok',
        detail: `${bound.length} account(s) bound · env ready`,
      });
      continue;
    }
    if (bound.length > 0) {
      // Explicitly configured but the env var is absent → a failure.
      const envName = bound[0]?.secretRef ?? '<ENV_NAME>';
      checks.push({
        id: `provider.${p.id}`,
        label: `${p.id} provider`,
        status: 'fail',
        detail: `account bound to ${envName}, but that env var is not set`,
        fix: `amrita setup  # writes ${envName} to ~/.amrita/secrets.env (0600); Amrita never stores values`,
      });
    } else {
      checks.push({
        id: `provider.${p.id}`,
        label: `${p.id} provider`,
        status: 'warn',
        detail: 'account connected but no secret_ref bound',
        fix: 'amrita account bind-secret <ACCOUNT_ID> <ENV_NAME>',
      });
    }
  }
  // One quiet summary instead of a warn-per-provider wall when nothing is set up.
  if (!checks.some((c) => c.id.startsWith('provider.') && c.id !== 'provider.mock')) {
    checks.push({
      id: 'provider.none',
      label: 'brain (model provider)',
      status: 'warn',
      detail:
        'no brain configured yet — choose a subscription login, API key (Anthropic/OpenAI/OpenRouter/Gemini), or local endpoint',
      fix: 'amrita setup',
    });
  }
  // Role policy (D5/ADR-0017): unconfigured `auto` is a warning, not a failure.
  const bindings = PROVIDER_ROLES.map((role) => ({ role, binding: kernel.getRoleBinding(role) }));
  if (bindings.some((b) => b.binding)) {
    checks.push({
      id: 'provider.roles',
      label: 'role policy',
      status: 'ok',
      detail: bindings
        .map((b) => `${b.role} → ${b.binding ? b.binding.provider : 'auto'}`)
        .join(' · '),
    });
  } else {
    checks.push({
      id: 'provider.roles',
      label: 'role policy',
      status: 'warn',
      detail:
        'no role bindings — role turns resolve via auto (first available real provider, else mock)',
      fix: 'amrita role set main <provider>',
    });
  }
  return { title: 'providers', checks };
}

function laneSection(kernel: AmritaKernel): DoctorSection {
  const h = kernel.health();
  return {
    title: 'lanes',
    checks: [
      {
        id: 'lanes.realExecution',
        label: 'real Claude Code execution',
        status: 'ok', // off is the safe default, not a problem
        detail: h.lanes.realExecution
          ? 'enabled (workspace-confined, env-scrubbed)'
          : 'disabled (safe default) — dry-run lanes always work; enable with AMRITA_LANES_ALLOW_REAL_EXECUTION=1',
      },
      {
        id: 'lanes.active',
        label: 'active lanes',
        status: 'ok',
        detail: String(h.lanes.active),
      },
    ],
  };
}

function channelSection(): DoctorSection {
  return {
    title: 'channels',
    checks: [
      {
        id: 'channel.web',
        label: 'web',
        status: 'ok',
        detail: 'served by this daemon (HTTP + WS, bearer-token gated)',
      },
      ...(envPresent('TELEGRAM_BOT_TOKEN') && envPresent('AMRITA_TELEGRAM_ALLOWED_IDS')
        ? [
            {
              id: 'channel.telegram',
              label: 'telegram',
              status: 'ok' as const,
              detail:
                'token + owner allowlist present (presence-checked only) — start the runner with: amritad --http --telegram',
            },
          ]
        : [
            {
              id: 'channel.telegram',
              label: 'telegram',
              status: 'warn' as const,
              detail:
                'needs setup — the operator runner exists but requires TELEGRAM_BOT_TOKEN and AMRITA_TELEGRAM_ALLOWED_IDS (comma-separated numeric ids)',
              fix: 'amrita setup  # telegram section; then: amritad --http --telegram',
            },
          ]),
    ],
  };
}

function connectorSection(): DoctorSection {
  const checks: DoctorCheck[] = CONNECTOR_MANIFESTS.map((m) => {
    const missing = m.requiredEnv.filter((name) => !envPresent(name));
    if (missing.length > 0) {
      return {
        id: `connector.${m.slug}`,
        label: `${m.title} connector`,
        status: 'warn' as const,
        detail: `needs setup — missing env: ${missing.join(', ')}`,
        ...(m.setupCommands[0] ? { fix: m.setupCommands[0] } : {}),
      };
    }
    // Doctor is synchronous → presence-only. `connected` needs the live probe
    // behind `connectors.status` (ADR-0022); never claim it from here.
    return {
      id: `connector.${m.slug}`,
      label: `${m.title} connector`,
      status: 'ok' as const,
      detail:
        'env configured (presence-checked only) — verify live with the connectors.status RPC / Setup Hub',
    };
  });
  return { title: 'connectors', checks };
}

/**
 * Cinema module group (ADR-0028, Phase 2): amritad proxies `cinema.chat` to the
 * module's own brain daemon (brain-bridge). Live-probes the bridge's public
 * /health; the bearer is presence-checked only (never a value).
 */
async function cinemaSection(): Promise<DoctorSection> {
  const { bridge, providers } = await cinemaProviders();
  const tokenPresent = envPresent(CINEMA_BRIDGE_TOKEN_ENV);
  const checks: DoctorCheck[] = [
    bridge.reachable
      ? {
          id: 'cinema.bridge',
          label: 'module brain (brain-bridge)',
          status: 'ok',
          detail: `bridge up at ${bridge.url}`,
        }
      : {
          id: 'cinema.bridge',
          label: 'module brain (brain-bridge)',
          status: 'warn',
          detail: `no bridge at ${bridge.url} — cinema.chat proxying unavailable`,
          fix: 'start the Cinema brain-bridge daemon (systemd: aba-brain-bridge), or point AMRITA_CINEMA_BRIDGE_URL at it',
        },
    tokenPresent
      ? {
          id: 'cinema.bearer',
          label: 'bridge bearer',
          status: 'ok',
          detail: `${CINEMA_BRIDGE_TOKEN_ENV} is set (presence-checked only)`,
        }
      : {
          id: 'cinema.bearer',
          label: 'bridge bearer',
          status: 'warn',
          detail: `${CINEMA_BRIDGE_TOKEN_ENV} not set — cinema.chat will refuse with missing_env_value`,
          fix: `export ${CINEMA_BRIDGE_TOKEN_ENV}=<bridge bearer>  # in the amritad environment`,
        },
    // Per-provider rows RENDER the bridge's computed truth (never re-probe here);
    // prompt_only rows are informational and can never be green.
    ...(bridge.reachable
      ? providers.map(
          (row): DoctorCheck => ({
            id: `cinema.provider.${row.id}`,
            label: `${row.title} [${row.role}]`,
            status: row.state === 'ready' || row.state === 'prompt_only' ? 'ok' : 'warn',
            detail: `${row.state} — ${row.note}`,
            ...(row.fix ? { fix: row.fix } : {}),
          }),
        )
      : []),
  ];
  return { title: 'cinema', checks };
}

function authSection(): DoctorSection {
  const fromEnv = envPresent('AMRITA_AUTH_TOKEN');
  return {
    title: 'auth',
    checks: [
      {
        id: 'auth.token',
        label: 'control-surface bearer token',
        status: fromEnv ? 'ok' : 'warn',
        detail: fromEnv
          ? 'AMRITA_AUTH_TOKEN is set (presence-checked only)'
          : 'not set — amritad --http generates an ephemeral token and prints it once at startup',
        ...(fromEnv
          ? {}
          : { fix: 'export AMRITA_AUTH_TOKEN=<long-random-string>  # for a stable local token' }),
      },
    ],
  };
}

/**
 * Run all doctor checks (ADR-0026: now async, because runtimes are live-probed).
 * Pure read — never mutates state, never reads a secret value. Sections are
 * ordered home → store → providers → runtimes → lanes → channels → connectors →
 * auth so the operator reads "where things live" before "what's wired".
 */
/** Skill registry health (ADR-0035): counts + honest warnings for refused dirs. */
function skillsSection(kernel: AmritaKernel): DoctorSection {
  const rows = kernel.listSkills();
  const active = rows.filter((r) => r.state === 'active').length;
  const refused = rows.filter((r) => r.state !== 'active');
  const checks: DoctorCheck[] = [
    {
      id: 'skills.registry',
      label: 'skill registry',
      status: 'ok',
      detail: `${active} registered (${rows.filter((r) => r.tier === 'system').length} system) — registry gates only; no executor exists yet`,
    },
  ];
  for (const r of refused.slice(0, 5)) {
    checks.push({
      id: `skills.${r.tier}.${r.name}`,
      label: `skill ${r.name} (${r.tier})`,
      status: 'warn',
      detail: r.detail,
      fix: 'add a valid skill.json (name/tier/version/description/owner/permissions/usage) — see ADR-0035',
    });
  }
  return { title: 'skills', checks };
}

/**
 * Community onboarding: doctor now separates readiness profiles.
 * - `core`   — the basic chat loop (home/store/brain/roles/runtimes/lanes/web/
 *   auth token). Its `worst()` is the top-line ok/status a fresh user judges by.
 * - `optional` — integrations neutral until enabled (telegram/github/mcp/skills).
 * - `private`  — bespoke maintainer modules (Cinema/brain-bridge) hidden unless
 *   explicitly enabled, so a stranger never sees an aba-brain-bridge fix hint.
 */
function cinemaEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  // Opt-in only: an explicit bridge URL or the bridge bearer being present.
  return Boolean((env[CINEMA_BRIDGE_URL_ENV] ?? '').trim()) || cinemaBridgeTokenPresent(env);
}

export async function runDoctor(kernel: AmritaKernel): Promise<DoctorReport> {
  const runtimes = await kernel.getCodingRuntimes();
  const tagged: { section: DoctorSection; profile: 'core' | 'optional' | 'private' }[] = [
    { section: homeSection(kernel), profile: 'core' },
    { section: storeSection(kernel), profile: 'core' },
    { section: providerSection(kernel), profile: 'core' },
    { section: runtimesSectionFrom(runtimes), profile: 'core' },
    { section: laneSection(kernel), profile: 'core' },
    { section: channelSection(), profile: 'optional' },
    { section: connectorSection(), profile: 'optional' },
    { section: skillsSection(kernel), profile: 'optional' },
    { section: authSection(), profile: 'core' },
  ];
  if (cinemaEnabled()) {
    tagged.push({ section: await cinemaSection(), profile: 'private' });
  }
  const sections: DoctorSection[] = tagged.map((t) => ({ ...t.section, profile: t.profile }));
  const all = sections.flatMap((s) => s.checks);
  const core = tagged.filter((t) => t.profile === 'core').flatMap((t) => t.section.checks);
  const fixes = [...new Set(all.filter((c) => c.status !== 'ok' && c.fix).map((c) => c.fix ?? ''))];
  // The top-line status reflects CORE readiness only; an unconfigured optional
  // integration or a disabled private module can never make the product look broken.
  const status = worst(core);
  return { ok: status !== 'fail', status, sections, fixes };
}
