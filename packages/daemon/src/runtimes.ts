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
  /** Runtime id: `claude-code` (wired) or a detection-only id (`codex`, `opencode`). */
  id: string;
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
  /** Probe budget. The default favors snappy status panels; interactive
   * choosers pass more — `claude auth status` alone takes ~4s on a VPS, and a
   * slow honest answer beats a fast wrong one. */
  timeoutMs?: number;
}): Promise<CodingRuntimeStatus> {
  const probe = opts.prober ?? defaultProber;
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const base = {
    id: 'claude-code' as const,
    title: 'Claude Code',
    realExecution: opts.realExecution,
  };

  const version = await probe('claude', ['--version'], timeoutMs);
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

  const auth = await probe('claude', ['auth', 'status'], timeoutMs);
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
    executable: false,
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
}): Promise<CodingRuntimeStatus[]> {
  const probe = opts.prober ?? defaultProber;
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const out: CodingRuntimeStatus[] = [];
  for (const rt of CODING_RUNTIMES) {
    if (rt.id === 'claude-code') {
      out.push(
        await getClaudeCodeStatus({
          realExecution: opts.realExecution,
          prober: probe,
          timeoutMs,
        }),
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
