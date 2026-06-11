import { spawn } from 'node:child_process';

/**
 * Coding-runtime status probes (docs/strategy/native-interactive-surface.md §2.9,
 * ADR-0019). A coding runtime (Claude Code today; Codex/OpenCode behind the same
 * contract later) is independent of the brain model: its status must be visible
 * and manageable even when the active brain provider is not Anthropic.
 *
 * Honesty rules: states come ONLY from real probes with bounded timeouts; an
 * inconclusive probe is `status_unknown`, never a green badge. No probe output
 * containing secrets is ever returned — only classified state + version string.
 */

export type CodingRuntimeState =
  | 'ready' // installed AND the auth probe succeeded
  | 'installed_unauthenticated' // installed, auth probe explicitly failed
  | 'installed_auth_unknown' // installed, auth probe inconclusive
  | 'not_installed'
  | 'status_unknown'; // probes timed out / errored inconclusively

export interface CodingRuntimeStatus {
  id: 'claude-code';
  title: string;
  state: CodingRuntimeState;
  version?: string;
  /** Whether THIS daemon allows real lane execution (ADR-0015 posture). */
  realExecution: boolean;
  detail: string;
  /** Exact next command for the operator, when one is known. Never a secret. */
  nextCommand?: string;
}

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
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], shell: false });
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

const PROBE_TIMEOUT_MS = 1500;

/**
 * Probe Claude Code's local install/auth state. Two bounded probes:
 * `claude --version` (installed?) then `claude auth status` (authenticated?).
 * Auth-probe output is classified, never echoed (it could mention account ids).
 */
export async function getClaudeCodeStatus(opts: {
  realExecution: boolean;
  prober?: CommandProber;
}): Promise<CodingRuntimeStatus> {
  const probe = opts.prober ?? defaultProber;
  const base = {
    id: 'claude-code' as const,
    title: 'Claude Code',
    realExecution: opts.realExecution,
  };

  const version = await probe('claude', ['--version'], PROBE_TIMEOUT_MS);
  if (version.kind === 'spawn_error') {
    return {
      ...base,
      state: 'not_installed',
      detail: 'the `claude` CLI was not found on PATH',
      nextCommand: 'npm install -g @anthropic-ai/claude-code',
    };
  }
  if (version.kind === 'timeout' || version.kind === 'failed') {
    return {
      ...base,
      state: 'status_unknown',
      detail: 'the `claude` CLI did not answer a bounded version probe',
      nextCommand: 'claude --version',
    };
  }
  const versionString = version.stdout.trim().slice(0, 60);

  const auth = await probe('claude', ['auth', 'status'], PROBE_TIMEOUT_MS);
  if (auth.kind === 'ok') {
    return {
      ...base,
      state: 'ready',
      ...(versionString ? { version: versionString } : {}),
      detail: 'installed and authenticated (subscription login; no key is ever forwarded)',
    };
  }
  if (auth.kind === 'failed') {
    return {
      ...base,
      state: 'installed_unauthenticated',
      ...(versionString ? { version: versionString } : {}),
      detail: 'installed, but the auth probe reported not logged in',
      nextCommand: 'claude login',
    };
  }
  return {
    ...base,
    state: 'installed_auth_unknown',
    ...(versionString ? { version: versionString } : {}),
    detail: 'installed; authentication could not be verified within the probe timeout',
    nextCommand: 'claude auth status',
  };
}
