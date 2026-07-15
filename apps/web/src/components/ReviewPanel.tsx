import type { ReviewPacketWire } from '@amrita/protocol';
import { useState } from 'react';
import { client } from '../client.ts';
import { textDir } from '../lib.ts';

/**
 * The weekly review (ADR-0045).
 *
 * "פעם בשבוע אמריטה תריץ סקירה: מה נתקע, מה מתקרב לדדליין, מה מחכה להחלטה."
 *
 * The panel is deliberately powerless. Running the review raises Inbox proposals
 * and posts one line into the conversation — it closes nothing, moves nothing and
 * publishes nothing. Everything it notices still has to pass through you.
 */

interface Props {
  projectId: string | undefined;
  onRaised: () => void;
  onError: (e: unknown) => void;
}

export function ReviewPanel({ projectId, onRaised, onError }: Props) {
  const [packet, setPacket] = useState<ReviewPacketWire | null>(null);
  const [busy, setBusy] = useState(false);
  const [raised, setRaised] = useState<number | null>(null);

  async function load(): Promise<void> {
    if (!projectId) return;
    setBusy(true);
    try {
      setPacket(await client.review(projectId));
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function run(): Promise<void> {
    if (!projectId) return;
    setBusy(true);
    try {
      const { raised: n } = await client.reviewRun(projectId);
      setRaised(n);
      onRaised();
      await load();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Weekly review</h2>

      {!packet ? (
        <p className="empty-note">
          What is stuck, what is nearing its date, what is waiting on a decision. Amrita runs this
          weekly on her own — you can also ask now.
        </p>
      ) : packet.empty ? (
        <p className="empty-note">
          Week of {packet.weekOf}: nothing stale, nothing overdue, nothing waiting. Quiet weeks are
          real.
        </p>
      ) : (
        <ul className="review-list">
          {packet.overdue.map((m) => (
            <li key={m.milestoneId} dir={textDir(m.title)}>
              <span className="charter-mark contradiction">overdue</span> {m.title} — {m.daysLate}d
              past {m.targetDate}
            </li>
          ))}
          {packet.approaching.map((m) => (
            <li key={m.milestoneId} dir={textDir(m.title)}>
              <span className="charter-mark unconfirmed">due soon</span> {m.title} — {m.daysLeft}d
              left
            </li>
          ))}
          {packet.blockers.map((b) => (
            <li key={b.taskId} dir={textDir(b.title)}>
              <span className="charter-mark missing">blocked</span> {b.title} — {b.reason}
            </li>
          ))}
          {packet.stale.map((t) => (
            <li key={t.taskId} dir={textDir(t.title)}>
              <span className="charter-mark unconfirmed">stale</span> {t.title} — untouched{' '}
              {t.daysSinceMoved}d
            </li>
          ))}
          {packet.waitingDecisions.map((q) => (
            <li key={q.questionId} dir={textDir(q.text)}>
              <span className="charter-mark missing">waiting</span> {q.text} — open {q.ageDays}d
            </li>
          ))}
          {packet.openRisks.map((r) => (
            <li key={r.riskId} dir={textDir(r.text)}>
              <span className="charter-mark contradiction">risk</span> {r.text}
              {r.severity ? ` · ${r.severity}` : ''}
            </li>
          ))}
        </ul>
      )}

      {packet && packet.recommendations.length > 0 && (
        <ul className="review-recs">
          {packet.recommendations.map((r) => (
            <li key={r} dir={textDir(r)}>
              {r}
            </li>
          ))}
        </ul>
      )}

      {raised !== null && (
        <p className="review-raised">
          {raised === 0
            ? 'Nothing new to raise — it had already said all of this.'
            : `${raised} proposal${raised === 1 ? '' : 's'} raised in the Inbox. Nothing changed on its own.`}
        </p>
      )}

      <div className="brief-actions">
        <button type="button" disabled={!projectId || busy} onClick={() => void load()}>
          {busy ? 'Looking…' : packet ? 'Refresh' : 'What needs attention?'}
        </button>
        <button type="button" disabled={!projectId || busy} onClick={() => void run()}>
          Raise these in the Inbox
        </button>
      </div>
    </section>
  );
}
