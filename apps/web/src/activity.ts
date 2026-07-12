import type { AmritaEventLite } from './api.ts';

/**
 * The live activity feed (Hermes-style backstage log): every meaningful event
 * on the stream becomes one short, honest line — which brain is thinking,
 * which lane/tool is running, what is waiting on the operator. Pure reducer;
 * lines say only what the events prove.
 */

export type ActivityTone = 'info' | 'work' | 'wait' | 'ok' | 'error';

export interface ActivityLine {
  id: string;
  ts: string;
  tone: ActivityTone;
  text: string;
}

const str = (v: unknown, max = 80): string =>
  typeof v === 'string' ? (v.length > max ? `${v.slice(0, max)}…` : v) : '';

/** Map one stream event to a feed line, or null for chat-visible noise. */
export function activityLine(ev: AmritaEventLite): ActivityLine | null {
  const p = ev.payload;
  const line = (tone: ActivityTone, text: string): ActivityLine => ({
    id: ev.id,
    ts: ev.ts,
    tone,
    text,
  });
  switch (ev.type) {
    case 'turn.started':
      return line('work', 'turn started');
    case 'model.request':
      return line(
        'work',
        `thinking — ${str(p.provider)} · ${str(p.model)}${p.via ? ` (via ${str(p.via)})` : ''}`,
      );
    case 'model.response':
      return line('info', 'reply drafted');
    case 'turn.completed':
      return line('ok', 'turn completed');
    case 'turn.failed':
      return line('error', `turn failed: ${str(p.error, 100)}`);
    case 'turn.interrupted':
      return line('error', 'turn interrupted');

    case 'lane.spawned':
      return line('work', `lane spawned — ${str(p.kind)}`);
    case 'lane.mandate':
      return line('info', `mandate: ${str(p.goal, 70)}`);
    case 'lane.progress':
      return line('work', `lane: ${str(p.note, 90)}`);
    case 'lane.merge_report':
      return line(p.exit === 'done' ? 'ok' : 'info', `lane report — exit ${str(p.exit)}`);
    case 'lane.completed':
      return line('ok', `lane completed (${str(p.exit)})`);
    case 'lane.aborted':
      return line('error', `lane aborted: ${str(p.reason, 90)}`);

    case 'approval.requested':
      return line('wait', `waiting for YOUR approval — ${str(p.action)} ${str(p.detail, 60)}`);
    case 'approval.resolved':
      return line(p.decision === 'allow' ? 'ok' : 'info', `approval ${str(p.decision)}`);

    case 'module.mandate.issued':
      return line('work', `delegated to ${str(p.moduleId)} module`);
    case 'module.mandate.resolved':
      return line('ok', `${str(p.moduleId)} module reported back`);

    case 'memory.updated':
      return line('info', 'memory saved');
    case 'task.created':
      return line('info', `task added: ${str(p.title, 60)}`);
    case 'decision.recorded':
      return line('info', 'decision recorded');
    case 'brief.updated':
      return line('info', 'brief updated');
    case 'brand.updated':
      return line('info', 'brand updated');
    case 'conversation.compressed':
      return line('info', 'conversation compressed into a continuation');

    default:
      return null; // messages + deltas render in the chat itself
  }
}

/** Fold a new event into a bounded ring of activity lines (newest last). */
export function pushActivity(
  lines: readonly ActivityLine[],
  ev: AmritaEventLite,
  cap = 60,
): readonly ActivityLine[] {
  const next = activityLine(ev);
  if (!next) return lines;
  if (lines.some((l) => l.id === next.id)) return lines; // stream + replay de-dupe
  const merged = [...lines, next];
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}

/** The one line describing what is happening RIGHT NOW (for the status strip). */
export function currentActivity(
  lines: readonly ActivityLine[],
  busy: boolean,
): ActivityLine | null {
  const last = lines[lines.length - 1] ?? null;
  if (last && (last.tone === 'wait' || last.tone === 'work')) return last;
  if (busy) {
    return { id: 'local-busy', ts: '', tone: 'work', text: 'working…' };
  }
  return null;
}
