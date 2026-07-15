import type { SystemAuditResultWire, SystemHealthResultWire } from '@amrita/protocol';
import { useEffect, useState } from 'react';
import { client } from '../client.ts';

/**
 * Global Amrita / System Brain (WP5, ADR-0036).
 *
 * The daemon computes a cross-project health aggregate and a self-maintenance
 * audit; neither had any UI. This surfaces both read-only. The audit runs in
 * dry mode by default (`record:false`) — it reports what is missing/unresolved
 * across projects without writing anything, keeping self-maintenance auditable
 * and non-mutating from the app.
 */

interface Props {
  onError: (e: unknown) => void;
}

export function SystemBrainPanel({ onError }: Props) {
  const [health, setHealth] = useState<SystemHealthResultWire | null>(null);
  const [audit, setAudit] = useState<SystemAuditResultWire | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        setHealth(await client.systemHealth());
      } catch (e) {
        onError(e);
      }
    })();
  }, [onError]);

  async function runAudit(): Promise<void> {
    setBusy(true);
    try {
      // Read-only: record stays false, so this reports without mutating anything.
      setAudit(await client.systemAudit(false));
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Global Amrita</h2>
      <p className="hub-note">
        The system brain across every project — health and a non-mutating self-audit.
      </p>

      {!health ? (
        <p className="empty-note">Loading system health…</p>
      ) : (
        <>
          <p className="hub-live">
            <span className={`doc-badge ${health.ok ? 'approved' : 'proposed'}`}>
              {health.ok ? 'healthy' : 'attention'}
            </span>
            {health.scheduler ? (
              <span>
                scheduler {health.scheduler.running ? 'running' : 'stopped'}
                {health.scheduler.lastSuccessAt
                  ? ` · last ok ${health.scheduler.lastSuccessAt.slice(0, 16).replace('T', ' ')}`
                  : ''}
              </span>
            ) : null}
          </p>
          <ul className="channel-list">
            {health.projects.map((p) => (
              <li key={p.id} className="channel-row">
                <div className="channel-copy">
                  <strong>{p.name}</strong>
                  <small>
                    {p.records} record{p.records === 1 ? '' : 's'}
                    {p.gaps > 0 ? ` · ${p.gaps} gap${p.gaps === 1 ? '' : 's'}` : ''}
                  </small>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="brief-actions">
        <button type="button" disabled={busy} onClick={() => void runAudit()}>
          {busy ? 'Auditing…' : 'Run self-audit (read-only)'}
        </button>
      </div>

      {audit ? (
        audit.findings.length === 0 ? (
          <p className="empty-note">Nothing to flag across projects.</p>
        ) : (
          <ul className="retro-findings">
            {audit.findings.map((f) => (
              <li key={`${f.projectId}-${f.kind}`}>
                <span className="charter-mark missing">{f.kind}</span> {f.slug}: {f.detail}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}
