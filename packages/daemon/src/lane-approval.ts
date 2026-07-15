/**
 * The Approval Constitution (ADR-0048) — the deterministic policy that decides
 * whether a lane spawn proceeds (operational, reversible) or is gated (material,
 * hard-to-reverse, outward-facing). It REPLACES the one-line gate
 * (`realExecution && approvals === 'forward'`), whose real bug was that
 * `auto-safe`/`sandboxed` blindly SKIPPED the gate — so a lane declared `auto-safe`
 * could write the real repo root with an unbounded budget and never ask.
 *
 * The `approvals` field keeps its meaning: `forward` = "ask me for anything real"
 * (behavior UNCHANGED from the old gate); `auto-safe`/`sandboxed` = pre-authorized
 * for OPERATIONAL work only — this resolver still gates the MATERIAL classes.
 *
 * Pure, like `execution-route.ts` — every input injected, no clock/store/probes.
 */
import type { LaneMandate } from '@amrita/protocol';
import { isWithin } from './lane-scope.ts';

export type ActionClass =
  | 'dry-run'
  | 'read-only-research'
  | 'jailed-edit'
  | 'interactive-session'
  | 'writes-shared-root'
  | 'spend-over-threshold'
  | 'network-egress'
  | 'scope-overlap'
  | 'outward-or-irreversible';

export interface LanePosture {
  realExecution: boolean;
  dryRun?: boolean;
  /** The lane kind — `*-tmux` is an interactive session (attended, gated). */
  kind: string;
  /** The per-lane jail root (`<workspacesRoot>`); paths under it are operational. */
  workspacesRoot: string | null;
  maxUsdCap: number;
  maxTokensCap: number;
  /** Ids of active lanes whose scope overlaps this one (from `activeScopeConflicts`). */
  scopeConflicts?: readonly string[];
}

export interface ApprovalVerdict {
  gate: 'auto' | 'approval';
  class: ActionClass;
  reason: string;
}

const OUTWARD_RE = /\b(deploy|publish|release|push|migrate|rotate|delete)\b/i;

const MATERIAL: ReadonlySet<ActionClass> = new Set<ActionClass>([
  'interactive-session',
  'writes-shared-root',
  'spend-over-threshold',
  'network-egress',
  'scope-overlap',
  'outward-or-irreversible',
]);

function classify(mandate: LaneMandate, posture: LanePosture): ActionClass {
  // Most-consequential first; deny-by-default on ambiguity (fall through to a GATE).
  if (posture.kind.endsWith('-tmux')) return 'interactive-session';
  if (posture.scopeConflicts && posture.scopeConflicts.length > 0) return 'scope-overlap';
  if (mandate.scope.network !== 'none') return 'network-egress';
  if (OUTWARD_RE.test(mandate.goal)) return 'outward-or-irreversible';

  // Explicit over-cap only. An UNSET budget is not "over threshold": the per-lane
  // jail + the always-on wall-clock cap contain it, and treating unset as material
  // would gate every ordinary jailed run (and break `auto-safe`). An unbounded run
  // that ALSO escapes the jail is still caught below as `writes-shared-root`.
  const { maxUsd, maxTokens } = mandate.budget;
  const overSpend =
    (maxUsd !== undefined && maxUsd > posture.maxUsdCap) ||
    (maxTokens !== undefined && maxTokens > posture.maxTokensCap);
  if (overSpend) return 'spend-over-threshold';

  if (posture.kind === 'research') return 'read-only-research';

  const paths = mandate.scope.paths ?? [];
  const jail = posture.workspacesRoot;
  const jailed =
    Boolean(jail) && paths.length > 0 && paths.every((p) => isWithin(p, jail as string));
  return jailed ? 'jailed-edit' : 'writes-shared-root';
}

export function resolveApprovalPolicy(mandate: LaneMandate, posture: LanePosture): ApprovalVerdict {
  // A dry run, or a daemon that cannot really execute, gates nothing (the runner
  // refuses real exec anyway — matches the old gate's non-opted-in case).
  if (posture.dryRun || !posture.realExecution) {
    return { gate: 'auto', class: 'dry-run', reason: 'dry run — nothing executes for real' };
  }

  const cls = classify(mandate, posture);

  // 'forward' gates anything real — the exact behavior of the gate this replaces.
  if (mandate.approvals === 'forward') {
    return { gate: 'approval', class: cls, reason: `forward policy — ${cls}` };
  }

  // 'auto-safe'/'sandboxed' are pre-authorized for OPERATIONAL work only. The hole
  // being closed: they no longer skip the gate for MATERIAL actions.
  return MATERIAL.has(cls)
    ? { gate: 'approval', class: cls, reason: `material action — ${cls}` }
    : { gate: 'auto', class: cls, reason: `operational — ${cls}` };
}
