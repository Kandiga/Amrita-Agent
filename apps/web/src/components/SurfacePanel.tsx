import { textDir } from '../lib.ts';
import { buildSandboxedPreview } from '../sandbox.ts';
import type { ArtifactSpec } from '../surface.ts';

interface SurfacePanelProps {
  artifacts: ArtifactSpec[];
  /** Durably approve a proposed preview's exact content (ADR-0020). */
  onApprovePreview: (previewId: string, contentHash: string) => void;
  /** Open a preview/design artifact in the live canvas beside the chat. */
  onOpenCanvas?: (artifactId: string) => void;
}

/**
 * The Native Interactive Surface: deterministic Stage-A renderers plus the
 * first Stage-B `html-preview` — which renders ONLY inside the sandbox harness
 * (no same-origin, zero-network CSP) and is never auto-approved.
 */
export function SurfacePanel({ artifacts, onApprovePreview, onOpenCanvas }: SurfacePanelProps) {
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
          if (a.kind === 'html-preview' || a.kind === 'design-page') {
            const sandboxed = buildSandboxedPreview({
              kind: a.kind,
              id: a.id,
              projectId: a.projectId,
              title: a.title,
              html: a.html,
            });
            return (
              <article key={a.id} className="artifact artifact-preview">
                <div className="preview-head">
                  <span className="artifact-kind">
                    {a.kind === 'design-page' ? 'design' : 'preview'}
                  </span>
                  <span className={`doc-badge preview-${a.status}`}>{a.status}</span>
                  {onOpenCanvas ? (
                    <button
                      type="button"
                      className="canvas-open-btn"
                      onClick={() => onOpenCanvas(a.id)}
                    >
                      Open canvas ⤢
                    </button>
                  ) : null}
                </div>
                <iframe
                  className="preview-frame"
                  title={a.title}
                  sandbox={sandboxed.sandbox}
                  srcDoc={sandboxed.srcDoc}
                />
                {a.status === 'proposed' ? (
                  <div className="preview-actions">
                    <p className="artifact-sub">
                      Proposed from this project's brief, brand and plan — approve to keep this
                      exact version. Any state change re-proposes it.
                    </p>
                    <button type="button" onClick={() => onApprovePreview(a.id, a.contentHash)}>
                      Approve preview
                    </button>
                  </div>
                ) : (
                  <p className="artifact-sub">approved — matches the version you signed off</p>
                )}
              </article>
            );
          }
          if (a.kind === 'workspace-preview') {
            return (
              <article key={a.id} className="artifact artifact-workspace">
                <span className="artifact-kind">live build</span>
                <h3 dir={textDir(a.title)}>{a.title}</h3>
                <p className="artifact-sub">
                  {a.laneKind} lane · {a.laneStatus} — real files from the lane's workspace
                </p>
                {onOpenCanvas ? (
                  <button
                    type="button"
                    className="canvas-open-btn"
                    onClick={() => onOpenCanvas(a.id)}
                  >
                    Open canvas ⤢
                  </button>
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
