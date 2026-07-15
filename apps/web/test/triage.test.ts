import type { InboxItemRowWire } from '@amrita/protocol';
import { describe, expect, it } from 'vitest';
import { buildTriageTarget, defaultKind, originLabel } from '../src/triage.ts';

type Item = Pick<InboxItemRowWire, 'text' | 'suggestedKind' | 'suggested'>;

const item = (over: Partial<Item> = {}): Item => ({
  text: 'the venue deposit is due March 3rd',
  suggestedKind: null,
  suggested: null,
  ...over,
});

describe('inbox triage (ADR-0044)', () => {
  it('preselects what the Scribe proposed', () => {
    expect(defaultKind(item({ suggestedKind: 'risk' }))).toBe('risk');
  });

  it('falls back to `task` for a bare human capture', () => {
    expect(defaultKind(item())).toBe('task');
  });

  it('seeds a task from the suggested payload', () => {
    const target = buildTriageTarget(
      item({
        suggestedKind: 'task',
        suggested: { title: 'Pay the venue deposit', body: 'to the park office' },
      }),
      'task',
    );
    expect(target).toEqual({
      kind: 'task',
      title: 'Pay the venue deposit',
      body: 'to the park office',
    });
  });

  it('carries a suggested risk severity through', () => {
    expect(
      buildTriageTarget(
        item({ suggestedKind: 'risk', suggested: { text: 'rain', severity: 'high' } }),
        'risk',
      ),
    ).toEqual({ kind: 'risk', text: 'rain', severity: 'high' });
  });

  it('drops a severity that is not a real level (never trust the payload)', () => {
    expect(
      buildTriageTarget(
        item({ suggestedKind: 'risk', suggested: { text: 'rain', severity: 'catastrophic' } }),
        'risk',
      ),
    ).toEqual({ kind: 'risk', text: 'rain' });
  });

  it('RETARGETS: the operator can say "that is not a task, it is a risk"', () => {
    // The suggestion was a task; the operator picks risk. The task-shaped payload
    // must not leak into the risk command — it falls back to the item text.
    const target = buildTriageTarget(
      item({ suggestedKind: 'task', suggested: { title: 'Pay the deposit', body: 'x' } }),
      'risk',
    );
    expect(target).toEqual({ kind: 'risk', text: 'the venue deposit is due March 3rd' });
  });

  it('honors the operator edit over the suggestion', () => {
    const target = buildTriageTarget(
      item({ suggestedKind: 'task', suggested: { title: 'Pay the deposit' } }),
      'task',
      'Pay the deposit BY WIRE',
    );
    expect(target).toEqual({ kind: 'task', title: 'Pay the deposit BY WIRE' });
  });

  it('maps every kind to its real command shape', () => {
    const i = item({ text: 'x' });
    expect(buildTriageTarget(i, 'decision')).toEqual({ kind: 'decision', text: 'x' });
    expect(buildTriageTarget(i, 'question')).toEqual({ kind: 'question', text: 'x' });
    expect(buildTriageTarget(i, 'memory')).toEqual({ kind: 'memory', content: 'x' });
    expect(buildTriageTarget(i, 'milestone')).toEqual({ kind: 'milestone', title: 'x' });
  });

  it('carries a suggested milestone date', () => {
    expect(
      buildTriageTarget(
        item({
          suggestedKind: 'milestone',
          suggested: { title: 'Permits', targetDate: '2026-09-01' },
        }),
        'milestone',
      ),
    ).toEqual({ kind: 'milestone', title: 'Permits', targetDate: '2026-09-01' });
  });

  it('returns null for an empty result, so Accept can be disabled', () => {
    expect(buildTriageTarget(item({ text: '   ' }), 'task', '   ')).toBeNull();
  });

  it('names who raised the item, honestly', () => {
    expect(originLabel('agent')).toBe('Amrita');
    expect(originLabel('lane')).toBe('a lane');
    expect(originLabel('user')).toBe('you');
  });
});
