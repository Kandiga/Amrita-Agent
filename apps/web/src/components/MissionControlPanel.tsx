import { textDir } from '../lib.ts';
import type { MissionRow } from '../mission-control.ts';

/**
 * HARMONY-1 — Mission Control: one row per thread of work — task → live
 * session → pending approval → evidence — so the whole loop is visible on one
 * screen. Read-only; every action stays with its owning panel.
 */
export function MissionControlPanel({ rows }: { rows: MissionRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="card mission-control">
      <h2>Mission Control</h2>
      <p className="muted">
        Every live thread in this project — the task, its session, what waits for you, and the
        evidence — in one place.
      </p>
      {rows.map((r) => (
        <div key={r.taskId} className={`mission-row attention-${r.attention}`}>
          <div className="mission-task">
            <strong dir={textDir(r.title)}>{r.title}</strong>
            <small>{r.taskStatus}</small>
          </div>
          <div className="mission-chips">
            {r.lane ? (
              <span className="mission-chip chip-lane">
                {r.lane.kind.replace('-tmux', '')} · {r.lane.status}
              </span>
            ) : (
              <span className="mission-chip chip-empty">no session</span>
            )}
            {r.approval ? (
              <span className="mission-chip chip-approval">⏳ {r.approval.action}</span>
            ) : null}
            {r.evidence !== 'none' ? (
              <span className={`mission-chip chip-evidence evidence-${r.evidence}`}>
                {r.evidence === 'pass'
                  ? '✓ checks'
                  : r.evidence === 'fail'
                    ? '✗ checks'
                    : 'unverified'}
              </span>
            ) : null}
          </div>
          <p className="mission-next" dir={textDir(r.next)}>
            {r.next}
          </p>
        </div>
      ))}
    </section>
  );
}
