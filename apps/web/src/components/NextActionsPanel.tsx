import type { CompanionAction } from '../companion.ts';

/** Rule-based next-best actions — pure display over `nextActions()` output. */
export function NextActionsPanel({ actions }: { actions: CompanionAction[] }) {
  return (
    <section className="card">
      <h2>Next actions</h2>
      {actions.length === 0 ? (
        <p className="empty-note">
          Nothing urgent — runtime is healthy and nothing is waiting on you.
        </p>
      ) : (
        actions.map((a) => (
          <div key={a.id} className={`companion-action companion-${a.urgency}`}>
            <strong>{a.label}</strong>
            <p>{a.detail}</p>
          </div>
        ))
      )}
    </section>
  );
}
