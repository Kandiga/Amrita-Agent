import type { AmritaEventLite } from '../api.ts';

/** One honest line per event — payload text/title/goal, never invented. */
function timelineText(ev: AmritaEventLite): string {
  const p = ev.payload;
  const v = p.text ?? p.title ?? p.goal ?? p.note ?? p.reason ?? p.resolution ?? '';
  return typeof v === 'string' ? v.slice(0, 80) : '';
}

/** Project activity, newest first — a render of the event log, not a separate feed. */
export function TimelinePanel({ events }: { events: AmritaEventLite[] }) {
  return (
    <section className="card">
      <h2>Activity</h2>
      {events.length === 0 ? (
        <p className="empty-note">No activity yet — everything this project does lands here.</p>
      ) : (
        <div className="timeline">
          {events.map((ev) => (
            <div key={ev.id} className="timeline-row">
              <span className="timeline-type">{ev.type}</span>
              <span className="timeline-text" dir="auto">
                {timelineText(ev)}
              </span>
              <small>{ev.ts.slice(0, 16).replace('T', ' ')}</small>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
