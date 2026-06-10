import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { loadConfig, getSecret, redactSecret } from '../../shared/config.ts';
import { paths } from '../../shared/paths.ts';
import { getDb, hasFts } from '../../core/store/db.ts';
import { listProfiles, resolveProfile } from '../../core/providers/registry.ts';
import { claudeAuthStatus } from '../../core/providers/claude-cli.ts';
import { resolveActiveProviderId } from '../../core/providers/resolver.ts';
import { listProjects } from '../../projects/manager.ts';

const OK = '\x1b[32m✓\x1b[0m';
const WARN = '\x1b[33m●\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';

interface Check {
  section: string;
  name: string;
  run: () => Promise<{ status: 'ok' | 'warn' | 'fail'; detail: string; fix?: string }>;
}

const SECTION = '\x1b[1;36m◆\x1b[0m';

function binaryExists(name: string): boolean {
  try {
    execFileSync('which', [name], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export type CheckResult = { status: 'ok' | 'warn' | 'fail'; detail: string; fix?: string };

/**
 * Health of the active model provider. Login/local providers are probed
 * honestly; an api-key provider only FAILs when it is explicitly selected and
 * its key is missing — never trapping the user on an unfinished setup.
 */
export async function checkModelProvider(): Promise<CheckResult> {
  const config = loadConfig();
  const isAuto = config.model.provider === 'auto';
  try {
    const activeId = resolveActiveProviderId(config.model.provider);
    const profile = resolveProfile(activeId);
    const label = isAuto ? `auto → ${activeId}` : activeId;
    if (profile.authMode === 'local_endpoint') {
      return { status: 'ok', detail: `${label} (local endpoint ${profile.baseUrl})` };
    }
    if (profile.authMode === 'local_cli_login') {
      const st = claudeAuthStatus();
      if (!st.installed) {
        return { status: 'warn', detail: `${label}: claude CLI not installed`, fix: 'install Claude Code, or `amrita setup` → API provider' };
      }
      if (!st.loggedIn) {
        return { status: 'warn', detail: `${label}: installed but not logged in`, fix: 'claude auth login' };
      }
      const sub = st.subscriptionType ? ` (subscription / Agent SDK credit, ${st.subscriptionType})` : ' (subscription / Agent SDK credit)';
      return { status: 'ok', detail: `${label}: logged in via Claude Code${sub} / ${config.model.model}` };
    }
    const key = profile.keyEnv ? getSecret(profile.keyEnv) : null;
    if (key) {
      return { status: 'ok', detail: `${label} / ${config.model.model} (key ${redactSecret(key)})` };
    }
    // No key. `auto` with nothing configured is a WARN (run setup), not a hard
    // FAIL — only an *explicitly chosen* key provider missing its key fails.
    return isAuto
      ? { status: 'warn', detail: `${label}: no provider configured yet`, fix: 'amrita setup' }
      : { status: 'fail', detail: `${activeId}: no ${profile.keyEnv}`, fix: 'amrita setup' };
  } catch (err) {
    return { status: 'fail', detail: String(err), fix: 'fix model.provider in config' };
  }
}

const checks: Check[] = [
  {
    section: 'Environment',
    name: 'Node version',
    run: async () => {
      const [major, minor] = process.versions.node.split('.').map(Number);
      const ok = major! > 23 || (major === 23 && minor! >= 6);
      return {
        status: ok ? 'ok' : 'fail',
        detail: `node ${process.version}`,
        fix: ok ? undefined : 'Install Node >= 23.6 (native TypeScript + sqlite required)',
      };
    },
  },
  {
    section: 'Environment',
    name: 'State directory',
    run: async () => {
      const home = paths.home();
      if (!existsSync(home)) return { status: 'fail', detail: `${home} missing`, fix: 'run any amrita command to create it' };
      const mode = statSync(home).mode & 0o777;
      return {
        status: mode & 0o077 ? 'warn' : 'ok',
        detail: `${home} (mode ${mode.toString(8)})`,
        fix: mode & 0o077 ? `chmod 700 ${home}` : undefined,
      };
    },
  },
  {
    section: 'Environment',
    name: 'Database',
    run: async () => {
      try {
        getDb().prepare('SELECT 1').get();
        return { status: 'ok', detail: `sqlite ok, FTS5 ${hasFts() ? 'available' : 'NOT available (degraded search)'}` };
      } catch (err) {
        return { status: 'fail', detail: String(err), fix: 'check disk space / permissions on amrita.db' };
      }
    },
  },
  {
    section: 'Model & providers',
    name: 'Model provider',
    run: checkModelProvider,
  },
  {
    section: 'Model & providers',
    name: 'Provider keys',
    run: async () => {
      const configured = listProfiles().filter((p) => p.keyEnv && getSecret(p.keyEnv));
      return {
        status: 'ok',
        detail: configured.length
          ? configured.map((p) => p.id).join(', ')
          : 'none yet (only the active provider needs one)',
      };
    },
  },
  {
    section: 'Channels',
    name: 'Telegram',
    run: async () => {
      const config = loadConfig();
      if (!config.channels.telegram.enabled) return { status: 'ok', detail: 'disabled' };
      const token = getSecret('TELEGRAM_BOT_TOKEN');
      if (!token) return { status: 'fail', detail: 'enabled but no TELEGRAM_BOT_TOKEN', fix: 'amrita setup' };
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
          signal: AbortSignal.timeout(8000),
        });
        const data = (await res.json()) as { ok: boolean; result?: { username?: string } };
        return data.ok
          ? { status: 'ok', detail: `@${data.result?.username}` }
          : { status: 'fail', detail: 'token rejected by Telegram', fix: 'regenerate via @BotFather' };
      } catch {
        return { status: 'warn', detail: 'could not reach api.telegram.org', fix: 'check network' };
      }
    },
  },
  {
    section: 'Connectors',
    name: 'Claude Code connector',
    run: async () => {
      const enabled = loadConfig().connectors.claudeCode.enabled;
      if (!enabled) return { status: 'ok', detail: 'disabled' };
      return binaryExists('claude')
        ? { status: 'ok', detail: 'claude CLI found' }
        : { status: 'warn', detail: 'claude CLI not on PATH', fix: 'install Claude Code or disable the connector' };
    },
  },
  {
    section: 'Connectors',
    name: 'Open Design connector',
    run: async () => {
      const config = loadConfig();
      if (!config.connectors.openDesign.enabled) return { status: 'ok', detail: 'disabled' };
      try {
        const res = await fetch(`${config.connectors.openDesign.baseUrl}/api/health`, {
          signal: AbortSignal.timeout(4000),
        });
        return res.ok
          ? { status: 'ok', detail: `reachable at ${config.connectors.openDesign.baseUrl}` }
          : { status: 'warn', detail: `HTTP ${res.status}`, fix: 'start Open Design' };
      } catch {
        return { status: 'warn', detail: 'not reachable', fix: 'start Open Design or disable the connector' };
      }
    },
  },
  {
    section: 'Service',
    name: 'Daemon',
    run: async () => {
      const config = loadConfig();
      try {
        const res = await fetch(`http://${config.daemon.host}:${config.daemon.port}/healthz`, {
          signal: AbortSignal.timeout(3000),
        });
        return res.ok
          ? { status: 'ok', detail: `running on port ${config.daemon.port}` }
          : { status: 'warn', detail: `unexpected HTTP ${res.status}` };
      } catch {
        return { status: 'warn', detail: 'not running', fix: 'amrita daemon (or systemctl start amrita)' };
      }
    },
  },
  {
    section: 'Workspace',
    name: 'Projects',
    run: async () => {
      const projects = listProjects();
      return { status: 'ok', detail: `${projects.length} project(s)` };
    },
  },
];

export async function doctorCommand(): Promise<void> {
  console.log('Amrita doctor\n');
  let failures = 0;
  let warnings = 0;
  const issues: { label: string; fix: string }[] = [];
  let lastSection = '';

  for (const check of checks) {
    if (check.section !== lastSection) {
      console.log(`${lastSection ? '\n' : ''}${SECTION} ${check.section}`);
      lastSection = check.section;
    }
    let result: CheckResult;
    try {
      result = await check.run();
    } catch (err) {
      result = { status: 'fail', detail: String(err) };
    }
    const icon = result.status === 'ok' ? OK : result.status === 'warn' ? WARN : FAIL;
    if (result.status === 'fail') failures++;
    if (result.status === 'warn') warnings++;
    console.log(`  ${icon} ${check.name.padEnd(24)} ${result.detail}`);
    if (result.fix && result.status !== 'ok') {
      console.log(`      \x1b[36m→\x1b[0m ${result.fix}`);
      issues.push({ label: check.name, fix: result.fix });
    }
  }

  console.log();
  if (!issues.length) {
    console.log('All checks passed. 🎉');
    return;
  }
  // Collected, numbered next-steps — the exact commands to run.
  console.log(`Found ${failures} issue(s) and ${warnings} warning(s) to address:`);
  issues.forEach((it, i) => console.log(`  ${i + 1}. ${it.label}: ${it.fix}`));
  if (failures) process.exitCode = 1;
}

export async function statusCommand(): Promise<void> {
  const config = loadConfig();
  const daemonUp = await fetch(`http://${config.daemon.host}:${config.daemon.port}/healthz`, {
    signal: AbortSignal.timeout(2000),
  })
    .then((r) => r.ok)
    .catch(() => false);
  const resolved = resolveActiveProviderId(config.model.provider);
  const providerLabel = config.model.provider === 'auto' ? `auto → ${resolved}` : resolved;
  console.log(`amrita status
  daemon:    ${daemonUp ? `running (http://${config.daemon.host}:${config.daemon.port})` : 'not running'}
  model:     ${providerLabel} / ${config.model.model}
  telegram:  ${config.channels.telegram.enabled ? 'enabled' : 'disabled'}
  projects:  ${listProjects().length}
  state dir: ${paths.home()}
${daemonUp ? '' : '\n  Run `amrita daemon` to start, or `amrita doctor` for diagnostics.'}`);
}
