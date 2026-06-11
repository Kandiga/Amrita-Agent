import type { OperatorApprovalLite } from '../api.ts';
import { textDir } from '../lib.ts';

interface ApprovalsPanelProps {
  approvals: OperatorApprovalLite[];
  onResolve: (approvalId: string, decision: 'allow' | 'deny') => void;
}

/**
 * Pending operator approvals (ADR-0021). Deny-by-default supervision: a
 * dangerous action (e.g. a REAL lane run) waits here until explicitly allowed;
 * unanswered requests time out to deny on the daemon. Rendered only when
 * something is actually pending — no panel theater.
 */
export function ApprovalsPanel({ approvals, onResolve }: ApprovalsPanelProps) {
  if (approvals.length === 0) return null;
  return (
    <section className="card approvals-card">
      <h2>Approvals needed</h2>
      {approvals.map((a) => (
        <div key={a.approvalId} className="approval-row">
          <strong>{a.action}</strong>
          {a.detail ? (
            <p className="approval-detail" dir={textDir(a.detail)}>
              {a.detail}
            </p>
          ) : null}
          <small>requested {a.requestedAt.slice(11, 19)} · times out to deny</small>
          <div className="approval-actions">
            <button type="button" onClick={() => onResolve(a.approvalId, 'allow')}>
              Allow
            </button>
            <button type="button" onClick={() => onResolve(a.approvalId, 'deny')}>
              Deny
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}
