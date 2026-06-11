import type { DoctorReportLite } from '../api.ts';

/** The daemon's doctor report as per-section status chips + exact fix commands. */
export function RuntimePanel({ doctor }: { doctor: DoctorReportLite | null }) {
  return (
    <section className="card">
      <h2>Runtime</h2>
      {doctor ? (
        doctor.sections.map((s) => {
          const worst = s.checks.some((c) => c.status === 'fail')
            ? 'fail'
            : s.checks.some((c) => c.status === 'warn')
              ? 'warn'
              : 'ok';
          return (
            <div key={s.title} className="doctor-section">
              <div className="doctor-head">
                <strong>{s.title}</strong>
                <span className={`doc-badge doc-${worst}`}>
                  {worst === 'ok' ? 'ok' : worst === 'warn' ? 'needs setup' : 'failing'}
                </span>
              </div>
              {s.checks
                .filter((c) => c.status !== 'ok')
                .map((c) => (
                  <p key={c.id} className="doctor-detail">
                    {c.label}
                    {c.detail ? ` — ${c.detail}` : ''}
                  </p>
                ))}
            </div>
          );
        })
      ) : (
        <p>Runtime checks not loaded yet.</p>
      )}
      {doctor && doctor.fixes.length > 0 ? (
        <details className="doctor-fixes">
          <summary>How to fix ({doctor.fixes.length})</summary>
          {doctor.fixes.map((fix) => (
            <code key={fix}>{fix}</code>
          ))}
        </details>
      ) : null}
    </section>
  );
}
