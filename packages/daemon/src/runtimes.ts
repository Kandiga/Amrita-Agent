import { spawn } from 'node:child_process';
import { scrubEnv } from '@amrita/lanes';
import type { CodingRuntimeState, CodingRuntimeStatusWire } from '@amrita/protocol';

/**
 * Coding-runtime status probes (docs/strategy/native-interactive-surface.md §2.9,
 * ADR-0019). A coding runtime (Claude Code today; Codex/OpenCode behind the same
 * contract later) is independent of the brain model: its status must be visible
 * and manageable even when the active brain provider is not Anthropic.
 *
 * Honesty rules: states come ONLY from real probes with bounded timeouts; an
 * inconclusive probe is `status_unknown`, never a green badge. No probe output
 * containing secrets is ever returned — only classified state + version string.
 *
 * Status shapes are protocol-owned wire contracts since ADR-0032.
 */
export type { CodingRuntimeState };
export type CodingRuntimeStatus = CodingRuntimeStatusWire;

export type ProbeResult =
  | { kind: 'ok'; stdout: string }
  | { kind: 'failed'; stdout: string }
  | { kind: 'timeout' }
  | { kind: 'spawn_error' };

/** Run a command with a hard timeout. No shell, fixed argv, output capped. */
export type CommandProber = (
  cmd: string,
  args: string[],
  timeoutMs: number,
) => Promise<ProbeResult>;

export const defaultProber: CommandProber = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      // SECURITY: probe `claude auth status`/`codex login status` with the SAME scrubbed
      // env the real turn uses, so exit 0 means the user's own login is valid — not a
      // stray API key masquerading as a subscription (community-onboarding finding 5/6).
      child = spawn(cmd, args, {
        stdio: ['ignore', 'pipe', 'ignore'],
        shell: false,
        env: scrubEnv(process.env),
      });
    } catch {
      resolve({ kind: 'spawn_error' });
      return;
    }
    let out = '';
    let settled = false;
    const settle = (r: ProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle({ kind: 'timeout' });
    }, timeoutMs);
    child.stdout?.on('data', (c: Buffer) => {
      if (out.length < 4096) out += c.toString('utf8');
    });
    child.on('error', () => {
      clearTimeout(timer);
      settle({ kind: 'spawn_error' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      settle(code === 0 ? { kind: 'ok', stdout: out } : { kind: 'failed', stdout: out });
    });
  });

/**
 * QA finding 7: ONE 1.5s budget starved the auth probe — `claude auth status`
 * alone takes ~4s on a VPS/WSL, so a genuinely logged-in CLI was reported
 * "authentication could not be verified within the probe timeout". Split the
 * budgets: a version probe is local and fast; an auth probe may touch disk,
 * keychain, or network and deserves patience. A slow honest answer beats a
 * fast wrong one.
 */
const VERSION_PROBE_TIMEOUT_MS = 2_000;
const AUTH_PROBE_TIMEOUT_MS = 10_000;

/**
 * Probe Claude Code's local install/auth state. Two bounded probes:
 * `claude --version` (installed?) then `claude auth status` (authenticated?).
 * Auth-probe output is classified, never echoed (it could mention account ids).
 */
/**
 * Two-probe install+auth classification shared by every real coding-runtime CLI
 * (`<cmd> --version` then an auth-check argv). One owner for the honesty rules
 * (ADR-0019 §6): a probe that fails or times out is `status_unknown`/
 * `installed_auth_unknown`, never a guessed green state.
 */
async function probeInstallAndAuth(opts: {
  probe: CommandProber;
  versionTimeoutMs: number;
  authTimeoutMs: number;
  base: { id: string; title: string; realExecution: boolean };
  cmd: string;
  authArgs: string[];
  installHint: string;
  loginHint: string;
  readyDetail: string;
  /** Parse the CLI's own status output into an observed auth mode (P2). */
  parseAuthMode?: (stdout: string) => 'subscription' | 'api-key' | undefined;
}): Promise<CodingRuntimeStatus> {
  const {
    probe,
    versionTimeoutMs,
    authTimeoutMs,
    base,
    cmd,
    authArgs,
    installHint,
    loginHint,
    readyDetail,
    parseAuthMode,
  } = opts;
  const version = await probe(cmd, ['--version'], versionTimeoutMs);
  if (version.kind === 'spawn_error') {
    return {
      ...base,
      state: 'not_installed',
      detail: `the \`${cmd}\` CLI was not found on PATH`,
      nextCommand: installHint,
    };
  }
  if (version.kind === 'timeout' || version.kind === 'failed') {
    return {
      ...base,
      state: 'status_unknown',
      detail: `the \`${cmd}\` CLI did not answer a bounded version probe`,
      nextCommand: `${cmd} --version`,
    };
  }
  const versionString = version.stdout.trim().slice(0, 60);

  const auth = await probe(cmd, authArgs, authTimeoutMs);
  if (auth.kind === 'ok') {
    const authMode = parseAuthMode?.(auth.stdout);
    return {
      ...base,
      state: 'ready',
      ...(versionString ? { version: versionString } : {}),
      ...(authMode ? { authMode } : {}),
      detail: readyDetail,
    };
  }
  if (auth.kind === 'failed') {
    return {
      ...base,
      state: 'installed_unauthenticated',
      ...(versionString ? { version: versionString } : {}),
      detail: 'installed, but the auth probe reported not logged in',
      nextCommand: loginHint,
    };
  }
  return {
    ...base,
    state: 'installed_auth_unknown',
    ...(versionString ? { version: versionString } : {}),
    detail: 'installed; authentication could not be verified within the probe timeout',
    nextCommand: `${cmd} ${authArgs.join(' ')}`,
  };
}

export async function getClaudeCodeStatus(opts: {
  realExecution: boolean;
  prober?: CommandProber;
  /** Probe budget. The default favors snappy status panels; interactive
   * choosers pass more — `claude auth status` alone takes ~4s on a VPS, and a
   * slow honest answer beats a fast wrong one. */
  timeoutMs?: number;
}): Promise<CodingRuntimeStatus> {
  return probeInstallAndAuth({
    probe: opts.prober ?? defaultProber,
    versionTimeoutMs: opts.timeoutMs ?? VERSION_PROBE_TIMEOUT_MS,
    authTimeoutMs: opts.timeoutMs ?? AUTH_PROBE_TIMEOUT_MS,
    base: { id: 'claude-code', title: 'Claude Code', realExecution: opts.realExecution },
    cmd: 'claude',
    authArgs: ['auth', 'status'],
    installHint: 'npm install -g @anthropic-ai/claude-code',
    loginHint: 'claude auth login',
    readyDetail: 'installed and authenticated (subscription login; no key is ever forwarded)',
    parseAuthMode: (out) => {
      // `claude auth status` prints JSON with authMethod = 'claude.ai' (login)
      // or 'api_key'. Under the scrubbed probe env (P1) a stray key can't reach
      // it, so 'api_key' here means the CLI genuinely resolved a key — reported
      // honestly, never relabelled as a subscription.
      try {
        const m = (JSON.parse(out) as { authMethod?: string }).authMethod;
        if (m === 'api_key') return 'api-key';
        if (typeof m === 'string' && m.length > 0) return 'subscription';
      } catch {
        /* non-JSON output — leave the mode unknown rather than guess */
      }
      return undefined;
    },
  });
}

/**
 * Codex's install+auth probe (ADR-0040/0043) — real now: `codex login status`
 * exits 0 when a ChatGPT session is active (verified live on codex-cli 0.144.1),
 * so codex gets the SAME honest ready/unauthenticated/unknown classification as
 * claude-code, not the generic detection-only path.
 */
export async function getCodexStatus(opts: {
  realExecution: boolean;
  prober?: CommandProber;
  timeoutMs?: number;
}): Promise<CodingRuntimeStatus> {
  return probeInstallAndAuth({
    probe: opts.prober ?? defaultProber,
    versionTimeoutMs: opts.timeoutMs ?? VERSION_PROBE_TIMEOUT_MS,
    authTimeoutMs: opts.timeoutMs ?? AUTH_PROBE_TIMEOUT_MS,
    base: { id: 'codex', title: 'Codex', realExecution: opts.realExecution },
    cmd: 'codex',
    authArgs: ['login', 'status'],
    installHint: 'npm install -g @openai/codex',
    loginHint: 'codex login',
    readyDetail: 'installed and authenticated (ChatGPT subscription; no key is ever forwarded)',
    // `codex login status` prints 'Logged in using ChatGPT' (subscription) on exit 0.
    parseAuthMode: (out) => (/chatgpt/i.test(out) ? 'subscription' : 'subscription'),
  });
}

// ── generalized coding-runtime registry (ADR-0026) ──────────────────────────

/**
 * Coding runtimes Amrita knows about. Claude Code is fully wired (install+auth
 * probe + real lane execution). Codex/OpenCode are DETECTION-ONLY today — they
 * are probed for presence and reported honestly with the future seam, never
 * faked as runnable (Hermes runtime-registry lesson, generalized).
 */
export interface RuntimeSpec {
  id: string;
  title: string;
  detectCli: string;
  installHint: string;
  /** False → Amrita can detect it but cannot drive lanes through it yet. */
  executable: boolean;
}

export const CODING_RUNTIMES: readonly RuntimeSpec[] = [
  {
    id: 'claude-code',
    title: 'Claude Code',
    detectCli: 'claude',
    installHint: 'npm install -g @anthropic-ai/claude-code',
    executable: true,
  },
  {
    id: 'codex',
    title: 'OpenAI Codex',
    detectCli: 'codex',
    installHint: 'npm install -g @openai/codex',
    executable: true, // real lane runner + chat provider since ADR-0040
  },
  {
    id: 'opencode',
    title: 'OpenCode',
    detectCli: 'opencode',
    installHint: 'see https://opencode.ai',
    executable: false,
  },
];

/**
 * Probe every coding runtime. Claude Code gets the full install+auth probe;
 * detection-only runtimes get a bounded `--version` presence probe and an
 * honest `not_installed` / `installed_auth_unknown` state with a clear note
 * that Amrita cannot drive them yet.
 */
export async function getRuntimesStatus(opts: {
  realExecution: boolean;
  prober?: CommandProber;
  timeoutMs?: number;
  /** Tool names a real Claude Code lane may use (ADR-0043) — attached to the
   *  claude-code entry only; codex has no tool-allowlist concept. */
  claudeAllowedTools?: string[];
}): Promise<CodingRuntimeStatus[]> {
  const probe = opts.prober ?? defaultProber;
  const timeoutMs = opts.timeoutMs ?? VERSION_PROBE_TIMEOUT_MS;
  const out: CodingRuntimeStatus[] = [];
  for (const rt of CODING_RUNTIMES) {
    if (rt.id === 'claude-code') {
      const status = await getClaudeCodeStatus({
        realExecution: opts.realExecution,
        prober: probe,
        timeoutMs,
      });
      out.push(
        opts.claudeAllowedTools && opts.claudeAllowedTools.length > 0
          ? { ...status, allowedTools: opts.claudeAllowedTools }
          : status,
      );
      continue;
    }
    if (rt.id === 'codex') {
      out.push(
        await getCodexStatus({ realExecution: opts.realExecution, prober: probe, timeoutMs }),
      );
      continue;
    }
    const version = await probe(rt.detectCli, ['--version'], timeoutMs);
    const base = { id: rt.id, title: rt.title, realExecution: false };
    if (version.kind === 'spawn_error') {
      out.push({
        ...base,
        state: 'not_installed',
        detail: `the \`${rt.detectCli}\` CLI was not found on PATH`,
        nextCommand: rt.installHint,
      });
    } else if (version.kind === 'ok') {
      out.push({
        ...base,
        state: 'installed_auth_unknown',
        version: version.stdout.trim().slice(0, 60),
        detail: 'detected, but Amrita cannot drive lanes through it yet (detection-only)',
      });
    } else {
      out.push({
        ...base,
        state: 'status_unknown',
        detail: `the \`${rt.detectCli}\` CLI did not answer a bounded version probe`,
      });
    }
  }
  return out;
}
