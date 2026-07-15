import type { InboxItemRowWire, InboxKind } from '@amrita/protocol';
import { useState } from 'react';
import { client } from '../client.ts';
import { type WriteCtx, textDir } from '../lib.ts';
import {
  KIND_LABELS,
  TRIAGE_KINDS,
  buildTriageTarget,
  defaultKind,
  originLabel,
  seedText,
} from '../triage.ts';

/**
 * The Inbox — the one triage queue (ADR-0044).
 *
 * Everything Amrita proposes, every lane result, and every quick capture lands
 * here. An item leaves ONLY by becoming a real aggregate (Accept) or by being
 * dismissed with a reason — never silently. All the decision logic lives in the
 * pure `triage.ts` so it is actually tested; this file just renders it.
 */

interface Props {
  items: InboxItemRowWire[];
  writeCtx: WriteCtx | null;
  onChanged: () => void;
  onError: (e: unknown) => void;
}

export function InboxPanel({ items, writeCtx, onChanged, onError }: Props) {
  const pending = items.filter((i) => i.status === 'pending');
  const [kinds, setKinds] = useState<Record<string, InboxKind>>({});
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [dismissing, setDismissing] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const kindOf = (i: InboxItemRowWire): InboxKind => kinds[i.id] ?? defaultKind(i);
  const textOf = (i: InboxItemRowWire): string => texts[i.id] ?? seedText(i);

  async function accept(item: InboxItemRowWire): Promise<void> {
    if (!writeCtx) return;
    const target = buildTriageTarget(item, kindOf(item), textOf(item));
    if (!target) return;
    setBusy(item.id);
    try {
      await client.inboxTriage({ ...writeCtx, itemId: item.id, ...target });
      onChanged();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(null);
    }
  }

  async function dismiss(item: InboxItemRowWire): Promise<void> {
    if (!writeCtx) return;
    const reason = (dismissing[item.id] ?? '').trim();
    if (!reason) return; // nothing leaves the queue without a reason
    setBusy(item.id);
    try {
      await client.inboxDismiss({ ...writeCtx, itemId: item.id, reason });
      onChanged();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card">
      <h2>
        Inbox {pending.length > 0 && <span className="doc-badge proposed">{pending.length}</span>}
      </h2>

      {pending.length === 0 ? (
        <p className="empty-note">
          Inbox is empty. What you and Amrita agree in chat shows up here as typed proposals —
          accept one and it becomes real project state.
        </p>
      ) : (
        <ul className="inbox-list">
          {pending.map((item) => {
            const kind = kindOf(item);
            const isBusy = busy === item.id;
            return (
              <li key={item.id} className="inbox-item">
                <p className="inbox-text" dir={textDir(item.text)}>
                  {item.text}
                </p>

                <p className="inbox-meta">
                  <span>Raised by {originLabel(item.origin)}</span>
                  {item.confidence && <span> · {item.confidence} confidence</span>}
                </p>

                {item.rationale && (
                  <p className="inbox-rationale" dir={textDir(item.rationale)}>
                    “{item.rationale}”
                  </p>
                )}

                <div className="inbox-actions">
                  <label className="sr-only" htmlFor={`kind-${item.id}`}>
                    Promote as
                  </label>
                  <select
                    id={`kind-${item.id}`}
                    value={kind}
                    disabled={!writeCtx || isBusy}
                    onChange={(e) =>
                      setKinds((k) => ({ ...k, [item.id]: e.target.value as InboxKind }))
                    }
                  >
                    {TRIAGE_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {KIND_LABELS[k]}
                      </option>
                    ))}
                  </select>

                  <input
                    value={textOf(item)}
                    dir={textDir(textOf(item))}
                    disabled={!writeCtx || isBusy}
                    aria-label="What it becomes"
                    onChange={(e) => setTexts((t) => ({ ...t, [item.id]: e.target.value }))}
                  />

                  <button
                    type="button"
                    disabled={!writeCtx || isBusy || !textOf(item).trim()}
                    onClick={() => void accept(item)}
                  >
                    Accept
                  </button>
                </div>

                <div className="inbox-dismiss">
                  <input
                    placeholder="Dismiss because…"
                    value={dismissing[item.id] ?? ''}
                    dir={textDir(dismissing[item.id] ?? '')}
                    disabled={!writeCtx || isBusy}
                    aria-label="Reason for dismissing"
                    onChange={(e) => setDismissing((d) => ({ ...d, [item.id]: e.target.value }))}
                  />
                  <button
                    type="button"
                    className="ghost"
                    disabled={!writeCtx || isBusy || !(dismissing[item.id] ?? '').trim()}
                    onClick={() => void dismiss(item)}
                  >
                    Dismiss
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
