import type { ConclusionCapsuleLite } from './api.ts';

/**
 * The Conclusion Capsule in the chat column (ADR-0048 §11) is a DERIVED,
 * read-only view — never a message, never persisted. This tiny pure module owns
 * the only stateful concern the UI has: deciding whether an async capsule
 * response is still relevant, so a slow fetch for conversation A can never paint
 * over the capsule the operator is now looking at in conversation B.
 */

export interface CapsuleState {
  /** The conversation the held capsule belongs to (guards stale async paints). */
  conversationId: string | null;
  capsule: ConclusionCapsuleLite | null;
}

export function emptyCapsule(): CapsuleState {
  return { conversationId: null, capsule: null };
}

/**
 * Fold a freshly-fetched capsule into state IFF it is still the selected
 * conversation. `forConversation` is what the caller ASKED for; `selected` is
 * what is on screen NOW. A mismatch is dropped (stale response). A same-or-older
 * `rev` for the SAME conversation is also dropped, so an out-of-order response
 * cannot rewind a newer capsule.
 */
export function hydrateCapsule(
  state: CapsuleState,
  capsule: ConclusionCapsuleLite | null,
  forConversation: string,
  selected: string | null,
): CapsuleState {
  if (forConversation !== selected) return state; // a stale response for a past conversation
  if (!capsule) return { conversationId: forConversation, capsule: null };
  if (
    state.conversationId === forConversation &&
    state.capsule &&
    capsule.rev < state.capsule.rev
  ) {
    return state; // an out-of-order response must not rewind a newer rev
  }
  return { conversationId: forConversation, capsule };
}

/** Clear the capsule when the selected conversation changes (before the fetch lands). */
export function resetCapsuleFor(conversationId: string | null): CapsuleState {
  return { conversationId, capsule: null };
}

/** Is there anything worth rendering? A capsule with only empty sections is hidden. */
export function capsuleHasContent(capsule: ConclusionCapsuleLite | null): boolean {
  if (!capsule) return false;
  return (
    capsule.progress.length > 0 ||
    capsule.decisions.length > 0 ||
    capsule.risks.length > 0 ||
    capsule.conflicts.length > 0 ||
    capsule.validation.length > 0 ||
    capsule.nextActions.length > 0
  );
}
