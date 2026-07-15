import type { HubPreviewWire } from '@amrita/protocol';
import { useState } from 'react';
import { client } from '../client.ts';
import { type WriteCtx, textDir } from '../lib.ts';

/**
 * The public stakeholder hub (ADR-0045).
 *
 * "לפני פרסום אמריטה תציג תצוגה מקדימה והשוואה… רק אחרי אישור תיווצר גרסה ציבורית
 *  מתועדת ותעלה לכתובת יציבה."
 *
 * Two things this panel must never do:
 *
 *  1. **Publish anything implicitly.** Publishing goes through an approval, and the
 *     button says exactly what it costs: a page someone already fetched cannot be
 *     un-fetched.
 *  2. **Show the operator a preview that is not the thing that gets published.** The
 *     preview IS the public object — the same allowlist, the same builder — so what
 *     you see is precisely what a stranger would see.
 */

interface Props {
  projectId: string | undefined;
  writeCtx: WriteCtx | null;
  onError: (e: unknown) => void;
}

export function HubPanel({ projectId, writeCtx, onError }: Props) {
  const [preview, setPreview] = useState<HubPreviewWire | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');

  async function load(): Promise<void> {
    if (!projectId) return;
    setBusy(true);
    try {
      setPreview(await client.hubPreview(projectId));
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function publish(): Promise<void> {
    if (!writeCtx) return;
    setBusy(true);
    try {
      await client.hubPublish(writeCtx);
      await load();
    } catch (e) {
      // A denied approval is a legitimate outcome, not a crash.
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(): Promise<void> {
    if (!writeCtx || !reason.trim()) return;
    setBusy(true);
    try {
      await client.hubRevoke({ ...writeCtx, reason: reason.trim() });
      setReason('');
      await load();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  if (!preview) {
    return (
      <section className="card">
        <h2>Stakeholder hub</h2>
        <p className="empty-note">
          A public page built from an explicit allowlist — the goal, the roadmap, the milestones and
          progress as a count. The budget, the risks, the decisions, the task list and your private
          notes are not in it, and cannot be: they are not fields it has.
        </p>
        <button type="button" disabled={!projectId || busy} onClick={() => void load()}>
          {busy ? 'Building…' : 'Preview what the public would see'}
        </button>
      </section>
    );
  }

  const h = preview.hub;
  const live = preview.published;

  return (
    <section className="card">
      <h2>Stakeholder hub</h2>

      {live ? (
        <p className="hub-live">
          Published at{' '}
          <a href={`/p/${live.slug}`} target="_blank" rel="noreferrer">
            /p/{live.slug}
          </a>
          {live.inSync ? (
            <span className="doc-badge approved">up to date</span>
          ) : (
            <span className="doc-badge proposed">the project has changed since</span>
          )}
        </p>
      ) : (
        <p className="empty-note">Nothing is public yet.</p>
      )}

      {/* This IS the public object — same allowlist, same builder. */}
      <div className="hub-preview">
        <strong dir={textDir(h.projectName)}>{h.projectName}</strong>
        {h.goal && <p dir={textDir(h.goal)}>{h.goal}</p>}
        {h.finishLine && <p className="hub-fin">Done means: {h.finishLine}</p>}
        <p className="hub-prog">
          {h.progress.done} of {h.progress.total} complete
        </p>
        {h.phases.length > 0 && (
          <p className="hub-phases">{h.phases.map((p) => p.title).join(' → ')}</p>
        )}
        {h.milestones.length > 0 && (
          <ul className="hub-ms">
            {h.milestones.map((m) => (
              <li key={m.title} dir={textDir(m.title)}>
                {m.title}
                {m.targetDate ? ` · ${m.targetDate}` : ''} · {m.status}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="brief-actions">
        <button type="button" disabled={busy} onClick={() => void load()}>
          Refresh
        </button>
        <button
          type="button"
          disabled={!writeCtx || busy || !h.goal}
          onClick={() => void publish()}
          title="Anyone with the link can read it, and a page already fetched cannot be un-fetched."
        >
          {live ? 'Republish (same link)' : 'Publish…'}
        </button>
      </div>

      {live && (
        <div className="inbox-dismiss">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            dir={textDir(reason)}
            placeholder="Take it down because…"
            aria-label="Reason for revoking"
            disabled={!writeCtx || busy}
          />
          <button
            type="button"
            className="ghost"
            disabled={!writeCtx || busy || !reason.trim()}
            onClick={() => void revoke()}
          >
            Take it down
          </button>
        </div>
      )}

      <p className="hub-note">
        Publishing asks for your approval first. Taking a page down removes it, but cannot un-send a
        copy someone already has.
      </p>
    </section>
  );
}
