import type { RetroPacketWire } from '@amrita/protocol';
import { useState } from 'react';
import { client } from '../client.ts';
import { type WriteCtx, textDir } from '../lib.ts';

/**
 * The retrospective, and the one door out of the project (ADR-0045).
 *
 * "הלקחים לא יזלגו אוטומטית לכל הפרויקטים. אתה תאשר מה הופך לידע ארגוני."
 *
 * Every lesson has its own button. There is no "promote all", and there never will
 * be: one project's hard-won lesson is another project's confidently-wrong
 * assumption, and the only thing standing between those two is a human reading the
 * sentence and deciding they still believe it.
 */

interface Props {
  projectId: string | undefined;
  writeCtx: WriteCtx | null;
  onError: (e: unknown) => void;
}

export function RetroPanel({ projectId, writeCtx, onError }: Props) {
  const [packet, setPacket] = useState<RetroPacketWire | null>(null);
  const [promoted, setPromoted] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function load(): Promise<void> {
    if (!projectId) return;
    setBusy(true);
    try {
      setPacket(await client.retro(projectId));
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function run(): Promise<void> {
    if (!writeCtx) return;
    setBusy(true);
    try {
      await client.retroRun(writeCtx);
      await load();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function promote(lesson: string): Promise<void> {
    if (!writeCtx) return;
    setBusy(true);
    try {
      await client.retroPromote({ ...writeCtx, lesson });
      setPromoted((p) => [...p, lesson]);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Retrospective</h2>

      {!packet ? (
        <>
          <p className="empty-note">
            What actually happened — dates that slipped, questions nobody answered, risks left open,
            work that ended still blocked. Computed from the record, not remembered.
          </p>
          <button type="button" disabled={!projectId || busy} onClick={() => void load()}>
            {busy ? 'Looking…' : 'What happened?'}
          </button>
        </>
      ) : (
        <>
          <p className="retro-outcome">
            {packet.outcome.tasksDone} of {packet.outcome.tasksTotal} tasks done ·{' '}
            {packet.outcome.milestonesHit} milestones hit, {packet.outcome.milestonesMissed} missed
            {packet.outcome.finishLine ? ` · done meant: ${packet.outcome.finishLine}` : ''}
          </p>

          {packet.empty ? (
            <p className="empty-note">
              Nothing slipped and nothing was left open. That is rare — and worth knowing.
            </p>
          ) : (
            <ul className="retro-findings">
              {packet.findings.map((f) => (
                <li key={f.detail} dir={textDir(f.detail)}>
                  <span className="charter-mark missing">{f.kind}</span> {f.detail}
                </li>
              ))}
            </ul>
          )}

          {packet.lessons.length > 0 && (
            <>
              <h3 className="retro-h3">Worth keeping</h3>
              <p className="retro-warn">
                Nothing here reaches another project until you say so. Promote only what you
                actually believe — each lesson is kept with the project it came from.
              </p>
              <ul className="retro-lessons">
                {packet.lessons.map((l) => (
                  <li key={l}>
                    <span dir={textDir(l)}>{l}</span>
                    {promoted.includes(l) ? (
                      <span className="doc-badge approved">promoted</span>
                    ) : (
                      <button
                        type="button"
                        disabled={!writeCtx || busy}
                        onClick={() => void promote(l)}
                      >
                        Keep for future projects
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className="brief-actions">
            <button type="button" disabled={busy} onClick={() => void load()}>
              Refresh
            </button>
            <button type="button" disabled={!writeCtx || busy} onClick={() => void run()}>
              Record this retrospective
            </button>
          </div>
        </>
      )}
    </section>
  );
}
