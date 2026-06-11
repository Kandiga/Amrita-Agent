import { useState } from 'react';
import type { QuestionLite, RiskLite } from '../api.ts';
import { client } from '../client.ts';
import { type WriteCtx, textDir } from '../lib.ts';

/**
 * Open questions and risks share one lifecycle: open → resolve-with-evidence or
 * drop-with-reason (ADR-0018 — silent closures are impossible). This file owns
 * that shared shape once; QuestionsPanel and RisksPanel are thin bindings.
 */

interface SettleItem {
  id: string;
  text: string;
  status: 'open' | 'resolved' | 'dropped';
  resolution: string | null;
  dropReason: string | null;
  severity?: 'low' | 'medium' | 'high' | null;
}

interface SettleListProps {
  title: string;
  addPlaceholder: string;
  emptyNote: string;
  items: SettleItem[];
  withSeverity?: boolean;
  writeCtx: WriteCtx | null;
  onAdd: (ctx: WriteCtx, text: string, severity?: 'low' | 'medium' | 'high') => Promise<unknown>;
  onResolve: (ctx: WriteCtx, id: string, note: string) => Promise<unknown>;
  onDrop: (ctx: WriteCtx, id: string, reason: string) => Promise<unknown>;
  onChanged: () => void;
  onError: (e: unknown) => void;
}

function SettleListPanel(props: SettleListProps) {
  const { title, items, writeCtx, onChanged, onError } = props;
  const [draft, setDraft] = useState('');
  const [severity, setSeverity] = useState<'low' | 'medium' | 'high' | ''>('');
  const [evidence, setEvidence] = useState<Record<string, string>>({});

  async function add(): Promise<void> {
    if (!writeCtx || !draft.trim()) return;
    try {
      await props.onAdd(writeCtx, draft.trim(), severity || undefined);
      setDraft('');
      setSeverity('');
      onChanged();
    } catch (e) {
      onError(e);
    }
  }

  async function settle(id: string, mode: 'resolve' | 'drop'): Promise<void> {
    const note = (evidence[id] ?? '').trim();
    if (!writeCtx || !note) return; // both paths need text: a note or a reason
    try {
      if (mode === 'resolve') await props.onResolve(writeCtx, id, note);
      else await props.onDrop(writeCtx, id, note);
      setEvidence((old) => ({ ...old, [id]: '' }));
      onChanged();
    } catch (e) {
      onError(e);
    }
  }

  return (
    <section className="card">
      <h2>{title}</h2>
      <form
        className="search"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          dir={textDir(draft)}
          placeholder={props.addPlaceholder}
        />
        {props.withSeverity ? (
          <select
            className="risk-severity"
            value={severity}
            onChange={(e) => setSeverity(e.target.value as typeof severity)}
            title="Severity (optional)"
          >
            <option value="">sev?</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </select>
        ) : null}
        <button type="submit" disabled={!draft.trim() || !writeCtx}>
          Add
        </button>
      </form>
      {items.length === 0 ? (
        <p className="empty-note">{props.emptyNote}</p>
      ) : (
        items.map((item) => (
          <div key={item.id} className={`settle-row settle-${item.status}`}>
            <p dir={textDir(item.text)}>
              {item.severity ? (
                <span className={`sev sev-${item.severity}`}>{item.severity}</span>
              ) : null}
              {item.text}
            </p>
            {item.status === 'open' ? (
              <div className="settle-controls">
                <input
                  value={evidence[item.id] ?? ''}
                  onChange={(e) => setEvidence((old) => ({ ...old, [item.id]: e.target.value }))}
                  dir={textDir(evidence[item.id] ?? '')}
                  placeholder="Resolution note / drop reason…"
                />
                <button
                  type="button"
                  disabled={!(evidence[item.id] ?? '').trim()}
                  onClick={() => void settle(item.id, 'resolve')}
                >
                  Resolve
                </button>
                <button
                  type="button"
                  disabled={!(evidence[item.id] ?? '').trim()}
                  onClick={() => void settle(item.id, 'drop')}
                >
                  Drop
                </button>
              </div>
            ) : (
              <small>
                {item.status === 'resolved'
                  ? `resolved — ${item.resolution ?? 'by decision'}`
                  : `dropped — ${item.dropReason}`}
              </small>
            )}
          </div>
        ))
      )}
    </section>
  );
}

interface PanelProps<T> {
  items: T[];
  writeCtx: WriteCtx | null;
  onChanged: () => void;
  onError: (e: unknown) => void;
}

export function QuestionsPanel(props: PanelProps<QuestionLite>) {
  return (
    <SettleListPanel
      title="Open questions"
      addPlaceholder="What is still unknown?"
      emptyNote="No open questions — when one comes up, park it here."
      items={props.items}
      writeCtx={props.writeCtx}
      onAdd={(ctx, text) => client.questionOpen({ ...ctx, text })}
      onResolve={(ctx, questionId, resolution) =>
        client.questionResolve({ ...ctx, questionId, resolution })
      }
      onDrop={(ctx, questionId, reason) => client.questionDrop({ ...ctx, questionId, reason })}
      onChanged={props.onChanged}
      onError={props.onError}
    />
  );
}

export function RisksPanel(props: PanelProps<RiskLite>) {
  return (
    <SettleListPanel
      title="Risks"
      addPlaceholder="What could go wrong?"
      emptyNote="No tracked risks. Honest list — empty means empty."
      items={props.items}
      withSeverity
      writeCtx={props.writeCtx}
      onAdd={(ctx, text, severity) =>
        client.riskOpen({ ...ctx, text, ...(severity ? { severity } : {}) })
      }
      onResolve={(ctx, riskId, resolution) => client.riskResolve({ ...ctx, riskId, resolution })}
      onDrop={(ctx, riskId, reason) => client.riskDrop({ ...ctx, riskId, reason })}
      onChanged={props.onChanged}
      onError={props.onError}
    />
  );
}
