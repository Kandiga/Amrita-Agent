import { resolve, sep } from 'node:path';
import type { AcceptanceCriterion, TaskVerification, VerificationResult } from '@amrita/protocol';

/**
 * ADR-0055 — evidence-based done: the PURE acceptance-verification core.
 * All IO is injected (`fileExists`, `exec`), so the policy is unit-testable and
 * the kernel shell stays thin. Command output is DISCARDED by design — only the
 * exit code enters the record (events stay value-free; a test log can hold
 * anything, including secrets).
 */

export interface VerifyIO {
  /** The project's bound working folder — the jail every check lives in. */
  root: string;
  fileExists: (absolutePath: string) => boolean;
  /** Run a gate command in the root; resolves with the exit code only. */
  exec: (run: string, cwd: string, timeoutMs: number) => Promise<{ code: number }>;
  now: () => string;
  timeoutMs?: number;
}

/** Resolve a criterion path INSIDE the root; null = it escapes (refused). */
export function resolveWithinRoot(root: string, relativePath: string): string | null {
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, relativePath);
  return candidate === resolvedRoot || candidate.startsWith(resolvedRoot + sep) ? candidate : null;
}

/** The machine-checkable subset — `manual` is human judgement, never verified. */
export function machineCriteria(criteria: readonly AcceptanceCriterion[]): AcceptanceCriterion[] {
  return criteria.filter((c) => c.kind !== 'manual');
}

/**
 * Run every machine criterion and seal one verification record. `passed` is
 * true only when EVERY machine check succeeded; a jail escape is an honest
 * failed result, never a silent skip.
 */
export async function runAcceptance(
  criteria: readonly AcceptanceCriterion[],
  io: VerifyIO,
): Promise<TaskVerification> {
  const results: VerificationResult[] = [];
  for (const criterion of machineCriteria(criteria)) {
    if (criterion.kind === 'file') {
      const abs = resolveWithinRoot(io.root, criterion.path);
      if (!abs) {
        results.push({ criterion, ok: false, detail: 'path escapes the project folder' });
      } else {
        const ok = io.fileExists(abs);
        results.push({ criterion, ok, ...(ok ? {} : { detail: 'missing' }) });
      }
      continue;
    }
    if (criterion.kind !== 'command') continue; // manual — filtered above; narrows the type
    try {
      const { code } = await io.exec(criterion.run, io.root, io.timeoutMs ?? 120_000);
      results.push({ criterion, ok: code === 0, detail: `exit ${code}` });
    } catch {
      results.push({ criterion, ok: false, detail: 'failed to run' });
    }
  }
  return { at: io.now(), passed: results.length > 0 && results.every((r) => r.ok), results };
}
