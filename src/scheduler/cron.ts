/** Minimal 5-field cron matcher: minute hour day-of-month month day-of-week.
 * Supports: * , - / and plain numbers. No seconds, local time. */

function parseField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart ? Number(stepPart) : 1;
    if (!step || step < 1) throw new Error(`bad step in "${part}"`);
    let lo = min;
    let hi = max;
    if (rangePart !== '*' && rangePart !== '') {
      if (rangePart!.includes('-')) {
        const [a, b] = rangePart!.split('-').map(Number);
        lo = a!;
        hi = b!;
      } else {
        lo = hi = Number(rangePart);
        if (stepPart) hi = max; // "5/10" → from 5 with step
      }
    }
    if (Number.isNaN(lo) || Number.isNaN(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`bad cron field "${field}"`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export interface CronSpec {
  minutes: Set<number>;
  hours: Set<number>;
  dom: Set<number>;
  months: Set<number>;
  dow: Set<number>;
}

export function parseCron(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron needs 5 fields, got "${expr}"`);
  return {
    minutes: parseField(fields[0]!, 0, 59),
    hours: parseField(fields[1]!, 0, 23),
    dom: parseField(fields[2]!, 1, 31),
    months: parseField(fields[3]!, 1, 12),
    dow: parseField(fields[4]!, 0, 7),
  };
}

export function cronMatches(spec: CronSpec, date: Date): boolean {
  const dow = date.getDay(); // 0=Sun; cron allows 7=Sun too
  return (
    spec.minutes.has(date.getMinutes()) &&
    spec.hours.has(date.getHours()) &&
    spec.dom.has(date.getDate()) &&
    spec.months.has(date.getMonth() + 1) &&
    (spec.dow.has(dow) || (dow === 0 && spec.dow.has(7)))
  );
}

/** Next matching minute after `from` (cap: 366 days). */
export function nextRun(expr: string, from = new Date()): Date | null {
  const spec = parseCron(expr);
  const cursor = new Date(from);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (cronMatches(spec, cursor)) return cursor;
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}
