/**
 * HARMONY-6 — the first REAL Brain ingestion path: calendar import. PURE
 * RFC-5545 subset parser (VEVENT: SUMMARY / DTSTART / DESCRIPTION / LOCATION),
 * fed by an operator-supplied .ics export — an honest "import" source (the
 * product direction's planned/manual/import states), never a fake live
 * connector. Bounded and defensive: garbage in → fewer events out, never a throw.
 */

export interface IcsEvent {
  title: string;
  /** ISO `YYYY-MM-DD` when derivable from DTSTART, else null. */
  date: string | null;
  body: string | null;
}

const MAX_EVENTS = 50;
const MAX_FIELD = 300;

/** Unfold RFC-5545 folded lines (CRLF + space/tab continuation). */
function unfold(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if ((raw.startsWith(' ') || raw.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += raw.slice(1);
    } else {
      out.push(raw);
    }
  }
  return out;
}

function unescapeText(v: string): string {
  return v
    .replace(/\\n/gi, ' ')
    .replace(/\\([,;\\])/g, '$1')
    .trim();
}

function isoDate(dtstart: string): string | null {
  const m = dtstart.trim().match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

export function parseIcsEvents(ics: string): IcsEvent[] {
  const events: IcsEvent[] = [];
  let current: { title?: string; date?: string | null; body?: string[] } | null = null;
  for (const line of unfold(ics)) {
    const upper = line.toUpperCase();
    if (upper.startsWith('BEGIN:VEVENT')) {
      current = { body: [] };
      continue;
    }
    if (upper.startsWith('END:VEVENT')) {
      if (current?.title) {
        events.push({
          title: current.title.slice(0, MAX_FIELD),
          date: current.date ?? null,
          body: current.body?.length ? current.body.join(' · ').slice(0, MAX_FIELD * 2) : null,
        });
        if (events.length >= MAX_EVENTS) break;
      }
      current = null;
      continue;
    }
    if (!current) continue;
    const sep = line.indexOf(':');
    if (sep < 1) continue;
    const key = line.slice(0, sep).split(';')[0]?.toUpperCase();
    const value = unescapeText(line.slice(sep + 1));
    if (!value) continue;
    if (key === 'SUMMARY') current.title = value;
    else if (key === 'DTSTART') current.date = isoDate(line.slice(sep + 1));
    else if (key === 'DESCRIPTION' || key === 'LOCATION') current.body?.push(value);
  }
  return events;
}
