import type { LaneMandate } from '@amrita/protocol';
import { describe, expect, it } from 'vitest';
import { type LanePosture, resolveApprovalPolicy } from '../src/lane-approval.ts';

const mandate = (o: Partial<LaneMandate> = {}): LaneMandate => ({
  laneId: '01KXH15R9K1W1MM86W52WVWABH',
  goal: 'do the thing',
  contextPack: { memory: [], files: [], decisions: [] },
  scope: { network: 'none' },
  budget: {},
  approvals: 'forward',
  deliverables: [],
  ...o,
});

const posture = (o: Partial<LanePosture> = {}): LanePosture => ({
  realExecution: true,
  dryRun: false,
  kind: 'claude-code',
  workspacesRoot: '/ws',
  maxUsdCap: 2,
  maxTokensCap: 200_000,
  ...o,
});

describe('resolveApprovalPolicy — the Approval Constitution (ADR-0048)', () => {
  it('a dry run, or a daemon that cannot really execute, gates nothing', () => {
    expect(resolveApprovalPolicy(mandate(), posture({ dryRun: true })).gate).toBe('auto');
    expect(resolveApprovalPolicy(mandate(), posture({ realExecution: false })).gate).toBe('auto');
  });

  it("'forward' gates anything real — UNCHANGED from the one-line gate it replaces", () => {
    const v = resolveApprovalPolicy(
      mandate({ approvals: 'forward', scope: { paths: ['/ws/L1'], network: 'none' } }),
      posture(),
    );
    expect(v.gate).toBe('approval');
  });

  it("'auto-safe' AUTO-proceeds a jailed edit — the pre-authorized case", () => {
    const v = resolveApprovalPolicy(
      mandate({ approvals: 'auto-safe', scope: { paths: ['/ws/L1'], network: 'none' } }),
      posture(),
    );
    expect(v.class).toBe('jailed-edit');
    expect(v.gate).toBe('auto');
  });

  it('an UNSET budget on a jailed lane is NOT material (jail + wall-clock contain it)', () => {
    const v = resolveApprovalPolicy(
      mandate({
        approvals: 'auto-safe',
        budget: {},
        scope: { paths: ['/ws/L1'], network: 'none' },
      }),
      posture(),
    );
    expect(v.gate).toBe('auto');
  });

  it("'auto-safe' still GATES the material classes — the hole that is now closed", () => {
    const as = (o: Partial<LaneMandate>) =>
      resolveApprovalPolicy(mandate({ approvals: 'auto-safe', ...o }), posture()).gate;
    // writes the shared root (outside the per-lane jail)
    expect(as({ scope: { paths: ['/repo/src'], network: 'none' } })).toBe('approval');
    // network egress
    expect(as({ scope: { network: 'open' } })).toBe('approval');
    // outward / irreversible
    expect(as({ goal: 'deploy to prod', scope: { paths: ['/ws/L1'], network: 'none' } })).toBe(
      'approval',
    );
    // explicit over-cap spend
    expect(as({ budget: { maxUsd: 50 }, scope: { paths: ['/ws/L1'], network: 'none' } })).toBe(
      'approval',
    );
    // an interactive tmux session
    expect(
      resolveApprovalPolicy(
        mandate({ approvals: 'auto-safe', scope: { paths: ['/ws/L1'], network: 'none' } }),
        posture({ kind: 'claude-code-tmux' }),
      ).gate,
    ).toBe('approval');
  });

  it('scope overlap gates even under auto-safe', () => {
    const v = resolveApprovalPolicy(
      mandate({ approvals: 'auto-safe', scope: { paths: ['/ws/L1'], network: 'none' } }),
      posture({ scopeConflicts: ['L2'] }),
    );
    expect(v.class).toBe('scope-overlap');
    expect(v.gate).toBe('approval');
  });
});
