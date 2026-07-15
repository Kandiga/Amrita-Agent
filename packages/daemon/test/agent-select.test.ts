import type { CodingRuntimeState, CodingRuntimeStatusWire } from '@amrita/protocol';
import { describe, expect, it } from 'vitest';
import { resolveAgent } from '../src/agent-select.ts';

const rt = (id: string, state: CodingRuntimeState): CodingRuntimeStatusWire => ({
  id,
  title: id === 'claude-code' ? 'Claude Code' : 'Codex',
  state,
  realExecution: true,
  detail: state === 'ready' ? 'ready' : `install/authenticate ${id}`,
  ...(state === 'ready' ? {} : { nextCommand: `${id} login` }),
});

const bothReady = [rt('claude-code', 'ready'), rt('codex', 'ready')];

describe('resolveAgent — which agent runs the job (ADR-0048)', () => {
  it('build defaults to Claude Code, with Codex as the alternative', () => {
    const c = resolveAgent({ intent: 'build', runtimes: bothReady, realExecution: true });
    expect(c.kind).toBe('claude-code');
    expect(c.via).toBe('policy');
    expect(c.alternatives).toEqual(['codex']);
  });

  it('research defaults to Codex (the research/QA sweet spot)', () => {
    const c = resolveAgent({ intent: 'research', runtimes: bothReady, realExecution: true });
    expect(c.kind).toBe('codex');
    expect(c.alternatives).toEqual(['claude-code']);
  });

  it('an explicit operator override wins over policy', () => {
    const c = resolveAgent({
      intent: 'build',
      runtimes: bothReady,
      realExecution: true,
      override: 'codex',
    });
    expect(c.kind).toBe('codex');
    expect(c.via).toBe('override');
  });

  it('settings priority reorders the default when several are ready', () => {
    const c = resolveAgent({
      intent: 'build',
      runtimes: bothReady,
      realExecution: true,
      priority: ['codex'],
    });
    expect(c.kind).toBe('codex');
    expect(c.via).toBe('policy');
  });

  it('a chosen agent that is NOT ready is honest — human + the exact fix', () => {
    const c = resolveAgent({
      intent: 'build',
      runtimes: [rt('claude-code', 'ready'), rt('codex', 'not_installed')],
      realExecution: true,
      override: 'codex',
    });
    expect(c.kind).toBe('human');
    expect(c.via).toBe('none-ready');
    expect(c.missing?.nextCommand).toBe('codex login');
  });

  it('only one ready runtime → that one, no false choice', () => {
    const c = resolveAgent({
      intent: 'build',
      runtimes: [rt('claude-code', 'not_installed'), rt('codex', 'ready')],
      realExecution: true,
    });
    expect(c.kind).toBe('codex');
    expect(c.via).toBe('only-ready');
  });

  it('nothing ready → human with a runtime fix, never a fake session', () => {
    const c = resolveAgent({
      intent: 'build',
      runtimes: [rt('claude-code', 'not_installed'), rt('codex', 'installed_unauthenticated')],
      realExecution: true,
    });
    expect(c.kind).toBe('human');
    expect(c.missing?.what).toMatch(/coding runtime/i);
    expect(c.missing?.nextCommand).toBe('claude-code login');
  });

  it('a dry-run-only daemon can run no agent', () => {
    const c = resolveAgent({ intent: 'build', runtimes: bothReady, realExecution: false });
    expect(c.kind).toBe('human');
  });

  it('conversational / human intents never reach a coding agent', () => {
    expect(
      resolveAgent({ intent: 'conversational', runtimes: bothReady, realExecution: true }).kind,
    ).toBe('human');
    expect(resolveAgent({ intent: 'human', runtimes: bothReady, realExecution: true }).kind).toBe(
      'human',
    );
  });
});
