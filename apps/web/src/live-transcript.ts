/**
 * A pure, deterministic transcript reducer over the daemon event stream.
 *
 * The web app folds every event frame (replayed history first, then live
 * fan-out) into a `TranscriptState`. It is the single source of truth for the
 * chat transcript, so the same event arriving twice — e.g. a reconnect replays
 * history the client already has — is de-duped by event id and changes nothing.
 *
 * `model.delta` is a stream-only event (never persisted; see the protocol's
 * STREAM_ONLY_TYPES). The daemon does not emit deltas yet, so real token
 * streaming is deferred — but the reducer already renders deltas as an
 * in-progress *draft* assistant bubble, which a fake stream exercises in tests.
 */

import type { AmritaEventLite } from './api.ts';
import type { ChatMessage } from './lib.ts';

const ROLE_BY_TYPE: Record<string, ChatMessage['role']> = {
  'message.user': 'user',
  'message.agent': 'agent',
  'message.system': 'system',
};

export interface TranscriptState {
  /** Event ids already folded in — the de-dupe key. */
  readonly seen: ReadonlySet<string>;
  /** Committed transcript messages, in arrival order. */
  readonly messages: readonly ChatMessage[];
  /** In-progress assistant text accumulated from stream-only `model.delta`. */
  readonly draft: string | null;
  /** Highest event `seq` folded in (drives `sinceSeq` for replay fallback). */
  readonly lastSeq: number;
}

export function emptyTranscript(): TranscriptState {
  return { seen: new Set(), messages: [], draft: null, lastSeq: 0 };
}

function payloadText(ev: AmritaEventLite): string {
  return typeof ev.payload.text === 'string' ? ev.payload.text : '';
}

/**
 * Fold one event into the transcript. Pure: returns the same reference when the
 * event is a no-op (already seen, or a type with no transcript effect), so React
 * can skip re-rendering.
 */
export function reduceEvent(state: TranscriptState, ev: AmritaEventLite): TranscriptState {
  if (ev.id && state.seen.has(ev.id)) return state; // de-dupe by event id

  const lastSeq = typeof ev.seq === 'number' && ev.seq > state.lastSeq ? ev.seq : state.lastSeq;
  const seen = ev.id ? new Set(state.seen).add(ev.id) : state.seen;

  // A stream-only token delta: extend the draft assistant bubble.
  if (ev.type === 'model.delta') {
    return {
      seen,
      messages: state.messages,
      draft: (state.draft ?? '') + payloadText(ev),
      lastSeq,
    };
  }

  const role = ROLE_BY_TYPE[ev.type];
  if (role) {
    const message: ChatMessage = { id: ev.id, role, text: payloadText(ev) };
    // A completed assistant message supersedes any in-progress draft for the turn.
    const draft = role === 'agent' ? null : state.draft;
    return { seen, messages: [...state.messages, message], draft, lastSeq };
  }

  // A non-transcript event (turn.*/model.request/usage/…): record it as seen so
  // a replay never reconsiders it, but leave the message list untouched.
  if (seen === state.seen && lastSeq === state.lastSeq) return state;
  return { seen, messages: state.messages, draft: state.draft, lastSeq };
}

/** Fold a batch of events (e.g. a `GET /events` replay) in order. */
export function foldEvents(
  state: TranscriptState,
  events: readonly AmritaEventLite[],
): TranscriptState {
  let next = state;
  for (const ev of events) next = reduceEvent(next, ev);
  return next;
}

const DRAFT_ID = '__draft__';

/**
 * The rendered message list: committed messages plus, if a draft is in flight,
 * a trailing in-progress assistant bubble (`pending: true`) for it.
 */
export function transcriptMessages(state: TranscriptState): ChatMessage[] {
  if (!state.draft) return [...state.messages];
  return [...state.messages, { id: DRAFT_ID, role: 'agent', text: state.draft, pending: true }];
}
