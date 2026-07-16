import { describe, expect, it } from 'vitest';
import type { ConclusionCapsuleLite } from '../src/api.ts';
import {
  capsuleHasContent,
  emptyCapsule,
  hydrateCapsule,
  resetCapsuleFor,
} from '../src/capsule-state.ts';

/** ADR-0048 §11 — the Conclusion Capsule in chat: derived, read-only, stale-safe. */

const capsule = (over: Partial<ConclusionCapsuleLite> = {}): ConclusionCapsuleLite => ({
  conversationId: 'C1',
  status: 'running',
  progress: [],
  decisions: [],
  risks: [],
  conflicts: [],
  validation: [],
  nextActions: [],
  rev: 1,
  ...over,
});

describe('hydrateCapsule — stale-response isolation', () => {
  it('folds a capsule in when it is still the selected conversation', () => {
    const next = hydrateCapsule(emptyCapsule(), capsule({ rev: 3 }), 'C1', 'C1');
    expect(next.capsule?.rev).toBe(3);
    expect(next.conversationId).toBe('C1');
  });

  it('DROPS a response for a conversation that is no longer selected', () => {
    const start = { conversationId: 'C2', capsule: capsule({ conversationId: 'C2' }) };
    // A slow fetch for C1 lands while C2 is on screen — must not paint over C2.
    const next = hydrateCapsule(start, capsule({ conversationId: 'C1' }), 'C1', 'C2');
    expect(next).toBe(start);
  });

  it('does not rewind to an older rev for the same conversation (out-of-order)', () => {
    const start = hydrateCapsule(emptyCapsule(), capsule({ rev: 5 }), 'C1', 'C1');
    const next = hydrateCapsule(start, capsule({ rev: 2 }), 'C1', 'C1');
    expect(next.capsule?.rev).toBe(5); // the newer one wins
  });

  it('a null response for the selected conversation clears the capsule', () => {
    const start = hydrateCapsule(emptyCapsule(), capsule(), 'C1', 'C1');
    expect(hydrateCapsule(start, null, 'C1', 'C1').capsule).toBeNull();
  });
});

describe('resetCapsuleFor + capsuleHasContent', () => {
  it('reset drops the held capsule for a switched conversation', () => {
    const s = resetCapsuleFor('C9');
    expect(s.conversationId).toBe('C9');
    expect(s.capsule).toBeNull();
  });

  it('an all-empty capsule renders nothing; any section shows the card', () => {
    expect(capsuleHasContent(null)).toBe(false);
    expect(capsuleHasContent(capsule())).toBe(false);
    expect(
      capsuleHasContent(
        capsule({ nextActions: [{ text: 'Approve the QA lane', provenance: [] }] }),
      ),
    ).toBe(true);
  });
});
