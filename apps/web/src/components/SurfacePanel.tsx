import { textDir } from '../lib.ts';
import type { ArtifactSpec } from '../surface.ts';

/**
 * The Native Interactive Surface, Stage A: deterministic renderers over typed
 * ArtifactSpecs derived from real project state. No generated code executes
 * here; an empty project renders an honest empty state.
 */
export function SurfacePanel({ artifacts }: { artifacts: ArtifactSpec[] }) {
  return (
    <section className="card surface-card">
      <h2>Surface</h2>
      {artifacts.length === 0 ? (
        <p className="empty-note">
          Structured previews of this project render here — capture a brief or add milestones and
          the Surface comes alive. Built from typed project state, never sample data.
        </p>
      ) : (
        artifacts.map((a) => {
          if (a.kind === 'brief-summary') {
            return (
              <article key={a.id} className="artifact artifact-brief">
                <span className="artifact-kind">brief</span>
                <h3 dir={textDir(a.goal)}>{a.goal}</h3>
                {a.audience ? <p className="artifact-sub">for {a.audience}</p> : null}
                {a.successCriteria.length > 0 ? (
                  <ul>
                    {a.successCriteria.map((s) => (
                      <li key={s} dir={textDir(s)}>
                        {s}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {a.scope.length > 0 || a.noScope.length > 0 ? (
                  <p className="artifact-sub">
                    {a.scope.length > 0 ? `in: ${a.scope.join(' · ')}` : ''}
                    {a.scope.length > 0 && a.noScope.length > 0 ? '  —  ' : ''}
                    {a.noScope.length > 0 ? `out: ${a.noScope.join(' · ')}` : ''}
                  </p>
                ) : null}
              </article>
            );
          }
          if (a.kind === 'lane-receipt') {
            return (
              <article key={a.id} className="artifact artifact-receipt">
                <span className="artifact-kind">receipt</span>
                <h3>
                  {a.laneKind} lane · exit {a.exit}
                </h3>
                {a.goal ? (
                  <p className="artifact-sub" dir={textDir(a.goal)}>
                    {a.goal}
                  </p>
                ) : null}
                {a.summary ? (
                  <p className="artifact-sub" dir={textDir(a.summary)}>
                    {a.summary}
                  </p>
                ) : null}
              </article>
            );
          }
          return (
            <article key={a.id} className="artifact artifact-board">
              <span className="artifact-kind">milestones</span>
              <div className="board-rows">
                {a.items.map((m) => (
                  <div key={m.id} className={`board-row board-${m.status}`}>
                    <span className="board-title" dir={textDir(m.title)}>
                      {m.title}
                    </span>
                    <span className="board-meta">
                      {m.status}
                      {m.targetDate ? ` · → ${m.targetDate}` : ''}
                      {m.openTasks > 0 ? ` · ${m.openTasks} open` : ''}
                    </span>
                  </div>
                ))}
              </div>
              {a.unassignedOpenTasks > 0 ? (
                <p className="artifact-sub">
                  {a.unassignedOpenTasks} open task{a.unassignedOpenTasks > 1 ? 's' : ''} not
                  assigned to a milestone
                </p>
              ) : null}
            </article>
          );
        })
      )}
    </section>
  );
}
