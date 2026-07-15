import type { MilestoneRowWire, RiskRowWire, TaskRowWire } from '@amrita/protocol';
import { HEALTH_LABEL, buildStatusStrip } from '../health.ts';
import { textDir } from '../lib.ts';

/**
 * The status strip (ADR-0045).
 *
 * "לא עשרים מספרים, אלא שלוש או ארבע אינדיקציות שבאמת משנות החלטה."
 *
 * Four things: what is the health, what is next, how long is left, what is in the
 * way. All derived — this component owns no state and stores nothing.
 */
export function StatusStrip({
  activated,
  tasks,
  milestones,
  risks,
  today,
}: {
  activated: boolean;
  tasks: TaskRowWire[];
  milestones: MilestoneRowWire[];
  risks: RiskRowWire[];
  today: string;
}) {
  const s = buildStatusStrip({ activated, tasks, milestones, risks, today });
  if (s.health === 'not-started') return null; // the activation panel is saying it better

  const days = s.nextMilestone?.daysLeft;

  return (
    <section className={`status-strip health-${s.health}`} aria-label="Project status">
      <span className={`status-health ${s.health}`}>{HEALTH_LABEL[s.health]}</span>

      {s.nextMilestone ? (
        <span className="status-next" dir="auto">
          <strong>Next:</strong> {s.nextMilestone.title}
          {days !== null && days !== undefined && (
            <em>
              {' · '}
              {days < 0 ? `${Math.abs(days)}d overdue` : days === 0 ? 'today' : `${days}d left`}
            </em>
          )}
        </span>
      ) : (
        <span className="status-next">
          <strong>Next:</strong> <em>no dated milestone</em>
        </span>
      )}

      {s.topBlocker ? (
        <span className="status-blocker" dir={textDir(s.topBlocker.text)}>
          <strong>Blocker:</strong> {s.topBlocker.text}
        </span>
      ) : (
        <span className="status-blocker">
          <strong>Blocker:</strong> <em>nothing in the way</em>
        </span>
      )}

      <span className="status-counts">
        {s.counts.open} open
        {s.counts.blocked > 0 && ` · ${s.counts.blocked} waiting`}
        {s.counts.overdue > 0 && ` · ${s.counts.overdue} overdue`}
      </span>
    </section>
  );
}
