import type { AmritaKernel } from './kernel.ts';
import { envPresent } from './provider.ts';

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
    const bound = accounts.filter((a) => a.provider === p.id && a.secretRef);
    const unbound = accounts.filter((a) => a.provider === p.id && !a.secretRef);
    if (bound.length === 0 && unbound.length === 0) {
      // Unconfigured by default → a warning, not a failure (PLAN §5.4).
      checks.push({
        id: `provider.${p.id}`,
        label: `${p.id} provider`,
        status: 'warn',
        detail: 'needs setup — no account connected',
        fix: `amrita --db <PATH> account connect --provider ${p.id}`,
      });
      continue;
    }
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
        fix: `export ${envName}=<your-key>  # set in the daemon's shell; Amrita never stores values`,
      });
    } else {
      checks.push({
        id: `provider.${p.id}`,
        label: `${p.id} provider`,
        status: 'warn',
        detail: 'account connected but no secret_ref bound',
        fix: 'amrita --db <PATH> account bind-secret <ACCOUNT_ID> <ENV_NAME>',
      });
    }
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
      {
        id: 'channel.telegram',
        label: 'telegram',
        status: 'warn',
        detail:
          'needs setup — transport + owner allowlist are implemented and tested, but a live bot runner is not bundled yet',
        fix: 'amrita --db <PATH> channel pair --project <SLUG>  # pairing codes work today; bot runner is a future WO',
      },
    ],
  };
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
    authSection(),
  ];
  const all = sections.flatMap((s) => s.checks);
  const fixes = [...new Set(all.filter((c) => c.status !== 'ok' && c.fix).map((c) => c.fix ?? ''))];
  const status = worst(all);
  return { ok: status !== 'fail', status, sections, fixes };
}
