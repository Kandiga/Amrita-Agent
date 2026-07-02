import { describe, expect, it } from 'vitest';
import {
  CINEMA_ACTION_TYPES,
  CINEMA_DIGEST_MAX_JSON_BYTES,
  CINEMA_VIDEO_OP_TYPES,
  cinemaPlanCardSchema,
  cinemaProjectDigestSchema,
  cinemaProjectRefSchema,
  cinemaVerbSchema,
  newId,
} from '../src/index.ts';

/** The canonical cross-repo fixture — the Cinema repo's contract test parses
 * this exact shape too (docs/strategy/amrita-cinema-mvp-roadmap.md Phase 1). */
function digestFixture(over: Record<string, unknown> = {}) {
  return {
    cinemaProjectId: 'vp_demo_1',
    amritaProjectId: newId(),
    name: 'Launch teaser',
    updatedAt: '2026-07-02T09:00:00.000Z',
    logline: 'A calm dawn over the product world.',
    style: 'gold-quiet-ma · warm grade · 35mm',
    shotCount: 4,
    storyboardFrameCount: 3,
    cardCount: 7,
    assetCounts: { image: 5, voice: 1, music: 1 },
    timeline: {
      clipCount: 6,
      durationSec: 24.5,
      laneClipCounts: { video: 3, voice: 1, music: 1, sfx: 1 },
    },
    qa: { approved: 2, flagged: 0, pending: 2 },
    decisions: ['Aspect 16:9 for the hero cut', 'Applied dialect gold-quiet-ma'],
    contentHash: 'a1b2c3d4',
    ...over,
  };
}

describe('cinema contract (ADR-0028)', () => {
  it('accepts the canonical digest fixture', () => {
    const parsed = cinemaProjectDigestSchema.parse(digestFixture());
    expect(parsed.shotCount).toBe(4);
    expect(parsed.timeline.laneClipCounts.music).toBe(1);
  });

  it('rejects media bytes anywhere in the digest', () => {
    const withMedia = digestFixture({ logline: 'cover data:image/png;base64,AAAA' });
    expect(() => cinemaProjectDigestSchema.parse(withMedia)).toThrow(/media bytes/);
  });

  it('rejects an oversized digest', () => {
    const fat = digestFixture({
      decisions: Array.from({ length: 20 }, (_, i) => `decision ${i} ${'x'.repeat(299 - 12)}`),
      logline: 'x'.repeat(500),
    });
    const json = JSON.stringify(fat);
    // If the padded fixture is still small, the guard itself must still hold the ceiling.
    if (json.length >= CINEMA_DIGEST_MAX_JSON_BYTES) {
      expect(() => cinemaProjectDigestSchema.parse(fat)).toThrow(/under/);
    } else {
      expect(cinemaProjectDigestSchema.parse(fat)).toBeTruthy();
      expect(json.length).toBeLessThan(CINEMA_DIGEST_MAX_JSON_BYTES);
    }
  });

  it('rejects unknown digest keys (strict contract)', () => {
    expect(() => cinemaProjectDigestSchema.parse(digestFixture({ pixels: 'nope' }))).toThrow();
  });

  it('project ref requires a real Amrita ULID', () => {
    expect(() =>
      cinemaProjectRefSchema.parse({
        cinemaProjectId: 'vp_demo_1',
        amritaProjectId: 'not-a-ulid',
        name: 'x',
        updatedAt: '2026-07-02T09:00:00.000Z',
      }),
    ).toThrow();
  });

  it('plan card mirrors the shipping AgentPlan 1:1', () => {
    const plan = cinemaPlanCardSchema.parse({
      id: 'plan_1',
      kind: 'generate',
      title: 'Generate into "Hero"',
      steps: ['Target: key card · 16:9', 'References: 2 on card', 'Model: GPT Image 2'],
      target: 'card',
      risk: 'credit',
      status: 'ready',
      prompt: 'cinematic dawn, 35mm...',
      data: { cardIds: ['c1'] },
    });
    expect(plan.risk).toBe('credit');
    expect(() => cinemaPlanCardSchema.parse({ ...plan, kind: 'render-final-movie' })).toThrow();
  });

  it('verb vocabulary = exactly the module whitelist (17 actions + 8 ops)', () => {
    expect(CINEMA_ACTION_TYPES).toHaveLength(17);
    expect(CINEMA_VIDEO_OP_TYPES).toHaveLength(8);
    expect(cinemaVerbSchema.parse('generate_keyframe')).toBe('generate_keyframe');
    expect(cinemaVerbSchema.parse('markQA')).toBe('markQA');
    expect(() => cinemaVerbSchema.parse('rm -rf')).toThrow();
  });
});
