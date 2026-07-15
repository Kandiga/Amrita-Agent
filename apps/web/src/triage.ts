/**
 * Inbox triage — pure (ADR-0044).
 *
 * Turning a proposal into a real aggregate is a decision with consequences, so
 * the logic lives here as plain functions rather than inside a `.tsx` component:
 * `apps/web` runs vitest with `environment: 'node'` and a `.ts`-only glob, so a
 * component is structurally untestable while this is testable on day one. Same
 * reason `companion.ts` and `surface.ts` exist.
 */
import type { InboxItemRowWire, InboxKind } from '@amrita/protocol';

/** The typed command payload for each promotion target — mirrors the RPC union. */
export type TriageTarget =
  | { kind: 'task'; title: string; body?: string; milestoneId?: string }
  | { kind: 'decision'; text: string }
  | { kind: 'risk'; text: string; severity?: 'low' | 'medium' | 'high' }
  | { kind: 'question'; text: string }
  | { kind: 'milestone'; title: string; description?: string; targetDate?: string }
  | { kind: 'memory'; content: string };

export const TRIAGE_KINDS: InboxKind[] = [
  'task',
  'decision',
  'risk',
  'question',
  'milestone',
  'memory',
];

export const KIND_LABELS: Record<InboxKind, string> = {
  task: 'Task',
  decision: 'Decision',
  risk: 'Risk',
  question: 'Question',
  milestone: 'Milestone',
  memory: 'Memory',
};

/** A short, human label for who raised an item. */
export function originLabel(origin: InboxItemRowWire['origin']): string {
  switch (origin) {
    case 'agent':
      return 'Amrita';
    case 'lane':
      return 'a lane';
    case 'system':
      return 'the system';
    case 'user':
      return 'you';
  }
}

/**
 * Build the triage command payload for a chosen kind.
 *
 * Seeds from the Scribe's `suggested` payload when it is present and its shape
 * fits the chosen kind, otherwise falls back to the item's raw `text`. The
 * operator can retarget an item ("this isn't a task, it's a risk") and still get
 * a sensible starting point.
 *
 * Returns `null` when the result would be empty — the caller disables Accept
 * rather than sending a command that the daemon would only reject.
 */
export function buildTriageTarget(
  item: Pick<InboxItemRowWire, 'text' | 'suggestedKind' | 'suggested'>,
  kind: InboxKind,
  override?: string,
): TriageTarget | null {
  const s = (item.suggestedKind === kind && item.suggested) || {};
  const pick = (key: string): string | undefined => {
    const v = (s as Record<string, unknown>)[key];
    return typeof v === 'string' && v.trim() ? v : undefined;
  };

  const text =
    (override ?? '').trim() || pick('title') || pick('text') || pick('content') || item.text.trim();
  if (!text) return null;

  switch (kind) {
    case 'task': {
      const body = pick('body');
      return { kind, title: text, ...(body ? { body } : {}) };
    }
    case 'decision':
      return { kind, text };
    case 'risk': {
      const sev = pick('severity');
      const severity = sev === 'low' || sev === 'medium' || sev === 'high' ? sev : undefined;
      return { kind, text, ...(severity ? { severity } : {}) };
    }
    case 'question':
      return { kind, text };
    case 'milestone': {
      const targetDate = pick('targetDate');
      return { kind, title: text, ...(targetDate ? { targetDate } : {}) };
    }
    case 'memory':
      return { kind, content: text };
  }
}

/**
 * The kind to preselect in the triage control: what the Scribe proposed, or
 * `task` — the most common promotion — for a bare human capture.
 */
export function defaultKind(item: Pick<InboxItemRowWire, 'suggestedKind'>): InboxKind {
  return item.suggestedKind ?? 'task';
}

/** The editable text to seed the triage field with. */
export function seedText(item: Pick<InboxItemRowWire, 'text'>): string {
  return item.text;
}
