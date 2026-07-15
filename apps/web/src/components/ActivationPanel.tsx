import type { CharterStatusWire } from '@amrita/protocol';
import { useState } from 'react';
import { client } from '../client.ts';
import { type WriteCtx, textDir } from '../lib.ts';

/**
 * Project activation (ADR-0045).
 *
 * From the product brief (voice, file 02):
 *
 *   "היום רוב מערכות הניהול מבקשות ממך לפתוח פרויקט, לתת שם ואז זורקות אותך לתוך
 *    לוח ריק. אנחנו רוצים בדיוק ההפך."
 *
 *   "כאשר יש מספיק בסיס, אמריטה מציעה להפעיל את הפרויקט. רק אחרי אישור שלך היא
 *    יוצרת אבני דרך, שלבים ומשימות ראשונות. כך הלוח לא מופיע מתוך תבנית מוכנה.
 *    הוא נולד מההקשר הספציפי."
 *
 * So this panel has exactly two faces:
 *
 *  - **Not ready.** The charter has no basis yet. We do NOT show an empty board and
 *    we do NOT invent a plan. We show what is missing and hand the operator back to
 *    the conversation, which is where a charter actually gets built.
 *
 *  - **Ready.** Amrita has enough to propose a shape. The operator edits the phases
 *    (they are a proposal, not a verdict) and approves. Only then does anything exist.
 */

interface Props {
  charter: CharterStatusWire | null;
  /** Null until the project has been activated. */
  activatedAt: string | null;
  writeCtx: WriteCtx | null;
  onActivated: () => void;
  onError: (e: unknown) => void;
}

/** A neutral starting shape. Deliberately generic — the operator makes it theirs. */
const SUGGESTED_PHASES = 'Set up\nDo the work\nWrap up';

export function ActivationPanel({ charter, activatedAt, writeCtx, onActivated, onError }: Props) {
  const [phases, setPhases] = useState(SUGGESTED_PHASES);
  const [busy, setBusy] = useState(false);

  // Already a plan — this panel has nothing left to say.
  if (activatedAt) return null;

  const ready = charter?.readyToActivate ?? false;
  const blocking = (charter?.findings ?? []).filter((f) => f.severity === 'high');

  async function activate(): Promise<void> {
    if (!writeCtx) return;
    const titles = phases
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 12);
    if (titles.length === 0) return;

    setBusy(true);
    try {
      await client.activateProject({
        ...writeCtx,
        phases: titles.map((title) => ({ title })),
      });
      onActivated();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card activation">
      <h2>This project has not started yet</h2>

      {!ready ? (
        <>
          <p className="empty-note">
            Amrita will not conjure a board out of nothing. Talk to her — she will ask one question
            at a time, and once the charter has a goal, a finish line and at least one real
            constraint, she will propose a shape for the work.
          </p>
          {blocking.length > 0 && (
            <ul className="charter-findings">
              {blocking.slice(0, 3).map((f) => (
                <li key={`${f.field}:${f.detail}`} className="charter-finding">
                  <span className={`charter-mark ${f.kind}`}>still needed</span>
                  <span dir="auto">{f.ask ?? f.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <>
          <p className="empty-note">
            The charter has enough basis. These are the phases Amrita proposes — the board's columns
            will be these, not a template. Edit them until they are yours, then activate. Nothing
            exists until you do.
          </p>
          <textarea
            value={phases}
            onChange={(e) => setPhases(e.target.value)}
            dir={textDir(phases)}
            rows={4}
            aria-label="Project phases, one per line"
            disabled={!writeCtx || busy}
          />
          <div className="brief-actions">
            <button
              type="button"
              disabled={!writeCtx || busy || phases.trim().length === 0}
              onClick={() => void activate()}
            >
              {busy ? 'Activating…' : 'Activate the project'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
