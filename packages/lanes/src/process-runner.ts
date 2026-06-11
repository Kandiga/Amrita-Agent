import { spawn } from 'node:child_process';
import { resolve, sep } from 'node:path';
import type { ProcessResult, ProcessRunner } from './runner.ts';

/**
 * The real child-process boundary for lane runners. **Dormant unless explicitly
 * enabled** by the Claude Code runner's opt-in (ADR-0015). Safety properties:
 *
 * - **No shell.** `spawn(file, args, options)` — never a concatenated shell
 *   string — so user-controlled mandate text cannot inject a command.
 * - **Workspace confinement.** When `allowedRoots` is set, the child's `cwd`
 *   must resolve inside one of them, or the run is refused before spawning.
 * - **Timeout.** `timeoutMs` terminates the child (SIGTERM → SIGKILL) and marks
 *   the result `timedOut`.
 * - **Abort.** An aborted `signal` kills the child; the result carries the kill
 *   `signal` so the caller can map it to `cancelled`.
 * - The environment it receives is already scrubbed by the caller (see env.ts).
 */

export interface NodeProcessRunnerOptions {
  /** Absolute roots a child `cwd` must resolve within. Empty ⇒ no confinement. */
  allowedRoots?: string[];
}

/** True if `target` resolves to, or inside, one of `roots`. */
export function isWithinRoots(target: string, roots: readonly string[]): boolean {
  const resolved = resolve(target);
  return roots.some((r) => {
    const root = resolve(r);
    return resolved === root || resolved.startsWith(root + sep);
  });
}

const SIGKILL_GRACE_MS = 2000;

export function createNodeProcessRunner(opts: NodeProcessRunnerOptions = {}): ProcessRunner {
  const allowedRoots = opts.allowedRoots ?? [];
  return {
    run(spawnOpts) {
      return new Promise<ProcessResult>((resolvePromise, reject) => {
        if (allowedRoots.length > 0) {
          if (!spawnOpts.cwd) {
            reject(new Error('a cwd within an allowed workspace root is required'));
            return;
          }
          if (!isWithinRoots(spawnOpts.cwd, allowedRoots)) {
            reject(new Error('cwd is not within an allowed workspace root'));
            return;
          }
        }

        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let settled = false;
        let killTimer: ReturnType<typeof setTimeout> | null = null;

        const child = spawn(spawnOpts.command, spawnOpts.args, {
          ...(spawnOpts.cwd ? { cwd: spawnOpts.cwd } : {}),
          env: spawnOpts.env, // already scrubbed by the caller
          ...(spawnOpts.signal ? { signal: spawnOpts.signal } : {}),
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        const timer = spawnOpts.timeoutMs
          ? setTimeout(() => {
              timedOut = true;
              child.kill('SIGTERM');
              killTimer = setTimeout(() => child.kill('SIGKILL'), SIGKILL_GRACE_MS);
              killTimer.unref?.();
            }, spawnOpts.timeoutMs)
          : null;
        timer?.unref?.();

        const finish = (result: ProcessResult): void => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (killTimer) clearTimeout(killTimer);
          resolvePromise(result);
        };

        child.stdout?.on('data', (d: Buffer) => {
          const s = d.toString('utf8');
          stdout += s;
          spawnOpts.onStdout?.(s);
        });
        child.stderr?.on('data', (d: Buffer) => {
          stderr += d.toString('utf8');
        });
        child.on('error', (err: Error) => {
          // An aborted signal kills the child and surfaces here as AbortError;
          // treat that as a (cancelled) close, not a hard failure.
          if (spawnOpts.signal?.aborted) {
            finish({ exitCode: -1, stdout, stderr, signal: 'SIGTERM', timedOut });
            return;
          }
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (killTimer) clearTimeout(killTimer);
          reject(err);
        });
        child.on('close', (code: number | null, signal: string | null) => {
          finish({ exitCode: code ?? (signal ? -1 : 0), stdout, stderr, signal, timedOut });
        });
      });
    },
  };
}
