import { describe, expect, it } from 'vitest';
import type { KnowledgeRecordLite } from '../src/api.ts';
import {
  gapBadgeClass,
  groupRecords,
  linkTitle,
  provenanceLabel,
  sourceBadgeClass,
} from '../src/harness-view.ts';

function rec(over: Partial<KnowledgeRecordLite>): KnowledgeRecordLite {
  return {
    slug: 'decision:1',
    kind: 'decision',
    title: 'Use ULIDs',
    body: '',
    projectId: 'P1',
    owner: null,
    date: null,
    confidence: 'high',
    tags: [],
    links: [],
    status: 'active',
    provenance: { sourceId: 'manual' },
    ...over,
  };
}

describe('harness-view', () => {
  it('only `connected` sources get the ok (green) badge — no fake green', () => {
    expect(sourceBadgeClass('connected')).toBe('runtime-ok');
    expect(sourceBadgeClass('manual')).toBe('runtime-warn');
    expect(sourceBadgeClass('planned')).toBe('runtime-off');
  });

  it('maps gap severity to badges', () => {
    expect(gapBadgeClass('high')).toBe('runtime-off');
    expect(gapBadgeClass('medium')).toBe('runtime-warn');
    expect(gapBadgeClass('low')).toBe('doc-badge');
  });

  it('groups records by kind in render order, dropping empty groups', () => {
    const groups = groupRecords([
      rec({ slug: 'entity:1', kind: 'entity' }),
      rec({ slug: 'decision:1', kind: 'decision' }),
      rec({ slug: 'open-question:1', kind: 'open-question' }),
    ]);
    expect(groups.map((g) => g.kind)).toEqual(['decision', 'open-question', 'entity']);
  });

  it('renders provenance without leaking and resolves link titles', () => {
    expect(provenanceLabel(rec({ provenance: { sourceId: 'repo', ref: 'github:o/r#7' } }))).toBe(
      'repo · github:o/r#7',
    );
    // when ref equals slug, show just the source id (no noise)
    expect(
      provenanceLabel(
        rec({ slug: 'decision:1', provenance: { sourceId: 'manual', ref: 'decision:1' } }),
      ),
    ).toBe('manual');
    const records = [rec({ slug: 'open-question:9', title: 'Which auth?' })];
    expect(linkTitle('open-question:9', records)).toBe('Which auth?');
    expect(linkTitle('missing:1', records)).toBe('missing:1'); // falls back to slug
  });
});
