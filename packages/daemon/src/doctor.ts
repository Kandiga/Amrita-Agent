import { CONNECTOR_MANIFESTS } from './connectors.ts';
import type { AmritaKernel } from './kernel.ts';
import { PROVIDER_ROLES, envPresent } from './provider.ts';

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

export type DoctorStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorStatus;
  detail?: string;
  /** An exact command the operator can run to resolve a warn/fail. */
  fix?: string;
}

export interface DoctorSection {
  title: string;
  checks: DoctorCheck[];
}

export interface DoctorReport {
  /** False iff any check failed (warns keep ok=true). */
  ok: boolean;
  /** The worst status across all checks. */
  status: DoctorStatus;
  sections: DoctorSection[];
  /** Deduped fix commands from every warn/fail check, in report order. */
  fixes: string[];
}

function worst(checks: DoctorCheck[]): DoctorStatus {
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  if (checks.some((c) => c.status === 'warn')) return 'warn';
  return 'ok';
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

/** Run all doctor checks. Pure read — never mutates state, never reads a secret value. */
export function runDoctor(kernel: AmritaKernel): DoctorReport {
  const sections = [
    storeSection(kernel),
    providerSection(kernel),
    laneSection(kernel),
    channelSection(),
    connectorSection(),
    authSection(),
  ];
  const all = sections.flatMap((s) => s.checks);
  const fixes = [...new Set(all.filter((c) => c.status !== 'ok' && c.fix).map((c) => c.fix ?? ''))];
  const status = worst(all);
  return { ok: status !== 'fail', status, sections, fixes };
}
