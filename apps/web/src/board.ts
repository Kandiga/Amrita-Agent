/**
 * The board — pure (ADR-0044).
 *
 * Columns and ordering are DERIVED from the task rows; the board stores nothing
 * of its own. That is the "views are projections" rule applied to the UI: drag a
 * card and one `task.updated` event moves it, and every other client — and the
 * agent's next turn — sees the same thing by reading the same rows.
 *
 * Lives in a `.ts` (not the component) because `apps/web` runs vitest with
 * `environment: 'node'` and a `.ts`-only glob: a `.tsx` is structurally
 * untestable here. Same reason `companion.ts`, `surface.ts` and `triage.ts` exist.
 */
import type { TaskPriority, TaskRowWire, TaskStatus } from '@amrita/protocol';

/**
 * The board has TWO modes, and which one you get is a property of the project:
 *
 *  - **phase mode** — the columns are the project's own phases ("Permits",
 *    "Vendors", "Load-in"). This is the real thing:
 *    "בלוח, העמודות יכולות להתאים לשלבי הפרויקט ולא להיות קבועות לכל העולם."
 *    "כך הלוח לא מופיע מתוך תבנית מוכנה. הוא נולד מההקשר הספציפי."
 *
 *  - **status mode** — the honest fallback for a project with no phases yet
 *    (now / waiting / later / done). Not a template imposed on the world; just
 *    what a board can say when the project has not told it anything else.
 *
 * In BOTH modes `waiting` is NOT a task status — the status enum stays
 * `now|later|done|dropped` (SQLite cannot alter a CHECK; see migration 0012). A
 * task is waiting when it has a `blockedReason`, which carries strictly more than
 * a status value could: not just THAT it is blocked, but on what.
 */
export type StatusColumnId = 'now' | 'waiting' | 'later' | 'done';
/** A column is either a status bucket or a real phase id. */
export type BoardColumnId = StatusColumnId | string;

export interface BoardColumn {
  id: BoardColumnId;
  title: string;
  hint: string;
  /** True when this column is one of the project's own phases. */
  isPhase: boolean;
  tasks: TaskRowWire[];
}

const COLUMN_META: Record<StatusColumnId, { title: string; hint: string }> = {
  now: { title: 'Now', hint: 'in flight this week' },
  waiting: { title: 'Waiting', hint: 'blocked on someone or something' },
  later: { title: 'Later', hint: 'queued, not started' },
  done: { title: 'Done', hint: 'finished' },
};

const STATUS_COLUMNS: StatusColumnId[] = ['now', 'waiting', 'later', 'done'];

/** Which STATUS column a task belongs in. Blocked beats status. */
export function columnOf(task: TaskRowWire): StatusColumnId | null {
  if (task.status === 'dropped') return null; // dropped tasks leave the board entirely
  if (task.status === 'done') return 'done';
  if (task.blockedReason) return 'waiting';
  return task.status === 'later' ? 'later' : 'now';
}

/** Sort by the fractional index, with never-dragged tasks last, then stable by id. */
function compareTasks(a: TaskRowWire, b: TaskRowWire): number {
  const ak = a.orderKey;
  const bk = b.orderKey;
  if (ak && bk) return ak < bk ? -1 : ak > bk ? 1 : a.id < b.id ? -1 : 1;
  if (ak) return -1;
  if (bk) return 1;
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1;
}

/** A phase, as the board needs it (just the shape — no dependency on the wire type). */
export interface BoardPhase {
  id: string;
  title: string;
  description?: string | null;
  status?: string;
}

/**
 * Build the board. With phases, the columns ARE the phases; without them, the four
 * status buckets. Dropped tasks never appear either way, and a done task always
 * reads as done — finishing a task should not hide it inside a phase column.
 */
export function buildBoard(
  tasks: readonly TaskRowWire[],
  phases: readonly BoardPhase[] = [],
): BoardColumn[] {
  const live = phases.filter((p) => p.status !== 'dropped');

  if (live.length === 0) {
    return STATUS_COLUMNS.map((id) => ({
      id,
      ...COLUMN_META[id],
      isPhase: false,
      tasks: tasks.filter((t) => columnOf(t) === id).sort(compareTasks),
    }));
  }

  const columns: BoardColumn[] = live.map((p) => ({
    id: p.id,
    title: p.title,
    hint: p.description ?? '',
    isPhase: true,
    tasks: tasks
      .filter((t) => t.status !== 'dropped' && t.status !== 'done' && t.phaseId === p.id)
      .sort(compareTasks),
  }));

  // Everything the phases do not claim still has to be visible — an unphased task
  // must never silently vanish from the board.
  const unphased = tasks.filter(
    (t) =>
      t.status !== 'dropped' &&
      t.status !== 'done' &&
      (!t.phaseId || !live.some((p) => p.id === t.phaseId)),
  );
  if (unphased.length > 0) {
    columns.push({
      id: 'now',
      title: 'Unphased',
      hint: 'not yet placed in a phase',
      isPhase: false,
      tasks: unphased.sort(compareTasks),
    });
  }

  columns.push({
    id: 'done',
    title: 'Done',
    hint: 'finished',
    isPhase: false,
    tasks: tasks.filter((t) => t.status === 'done').sort(compareTasks),
  });

  return columns;
}

// ── the fractional index ─────────────────────────────────────────────────────
//
// A drag must be ONE event touching ONE row. With integer positions, dropping a
// card between two others means renumbering every sibling below it — N writes,
// and two concurrent drags corrupt each other. A lexicographic fractional index
// instead computes a key strictly BETWEEN its neighbours, so the move is a single
// `task.updated` and concurrent drags can at worst tie (broken by id, above).

// Digits are 'a'..'z'. Two invariants make this terminate and stay correct:
//
//   1. a generated key NEVER ends with the smallest digit ('a'). If it did, no
//      key could ever be inserted before it — you would have to go "below zero",
//      which a lexicographic string cannot express. Every base case below returns
//      a middle digit, so the invariant holds by construction.
//   2. `keyBetween` is TOTAL: it always returns a key and never throws. A drag
//      handler that can throw is a drag handler that loses your card.

const DIGITS = 'abcdefghijklmnopqrstuvwxyz';
const ZERO = 0;
const LAST = DIGITS.length - 1;
/** One past the last digit — the conceptual "+infinity" bound. */
const INF = DIGITS.length;
const MAX_DEPTH = 64;

const digit = (c: string): number => DIGITS.indexOf(c);
const char = (i: number): string => DIGITS[i] as string;

/** Keep only legal digits. An empty/illegal key means "no bound on this side". */
function normalize(key: string | null | undefined): string {
  if (!key) return '';
  let out = '';
  for (const c of key) if (c >= 'a' && c <= 'z') out += c;
  return out;
}

/**
 * A key strictly between `before` and `after` — either may be null for the ends
 * of the list. Pure, deterministic and TOTAL.
 */
export function keyBetween(before?: string | null, after?: string | null): string {
  const lo = normalize(before);
  const hi = normalize(after);

  // Degenerate range (bad data, a race, a hand-written key): never throw inside a
  // drag. Append after `lo`, which is always legal.
  if (lo && hi && lo >= hi) return midpoint(lo, '', 0);

  const key = midpoint(lo, hi, 0);
  // Belt and braces: if anything about the inputs was pathological, fall back to
  // a key that is at least strictly greater than `lo`.
  if (lo && key <= lo) return `${lo}${char(Math.floor(INF / 2))}`;
  return key;
}

/**
 * The lexicographic midpoint of `lo` and `hi` over the digit alphabet.
 * `lo === ''` means "start of list"; `hi === ''` means "end of list".
 */
function midpoint(lo: string, hi: string, depth: number): string {
  if (depth > MAX_DEPTH) return `${lo}${char(Math.floor(INF / 2))}`;

  // Strip the shared prefix and recurse on the remainder.
  if (hi) {
    let n = 0;
    while (n < hi.length && (lo[n] ?? '') === hi[n]) n++;
    if (n > 0) return hi.slice(0, n) + midpoint(lo.slice(n), hi.slice(n), depth + 1);
  }

  // Prepending below a key that already starts at the zero digit: we cannot go
  // below 'a', so keep the 'a' and find room in the NEXT position instead. This
  // is what lets a column be prepended to indefinitely ('an' → 'ag' → 'aan' → …).
  if (!lo && hi && digit(hi[0] as string) === ZERO) {
    return char(ZERO) + midpoint('', hi.slice(1), depth + 1);
  }

  // The first digits now differ (or one side is exhausted).
  const dLo = lo ? digit(lo[0] as string) : ZERO - 1; // '' is below every digit
  const dHi = hi ? digit(hi[0] as string) : INF; // '' is above every digit

  if (dHi - dLo > 1) {
    // Room between them: take the middle digit.
    const mid = Math.max(Math.floor((dLo + dHi) / 2), ZERO);
    // …but never END on the zero digit (invariant 1), or nothing could ever be
    // inserted before this card again. Descend one level instead.
    if (mid === ZERO) return char(ZERO) + char(Math.floor(INF / 2));
    return char(mid);
  }

  // Adjacent digits: keep `lo`'s digit and descend into its remainder, looking
  // for room further right. This is what makes 200 inserts at the same spot grow
  // the key slowly instead of renumbering every sibling.
  if (lo) {
    return (lo[0] as string) + midpoint(lo.slice(1), '', depth + 1);
  }

  // `lo` is exhausted and `hi` starts at the zero digit: there is genuinely no
  // room before it (you cannot go below 'a'). Sit just after the start instead
  // of throwing — the id breaks the tie.
  return char(Math.floor(INF / 2));
}

/** True when a key can never have anything inserted before it (invariant 1). */
export function isTerminal(key: string): boolean {
  return key.endsWith(char(ZERO));
}

/**
 * The order key a task should get when dropped at `index` within `column`.
 * `movingId` is excluded so dragging a card within its own column measures
 * against its true neighbours, not itself.
 */
export function keyForDrop(
  column: readonly TaskRowWire[],
  index: number,
  movingId?: string,
): string {
  const others = movingId ? column.filter((t) => t.id !== movingId) : [...column];
  const clamped = Math.max(0, Math.min(index, others.length));
  const before = others[clamped - 1]?.orderKey ?? null;
  const after = others[clamped]?.orderKey ?? null;
  return keyBetween(before, after);
}

/**
 * The typed update a drop produces. Moving into/out of Waiting is a
 * `blockedReason` change, NOT a status change — the enum is untouched.
 *
 * A drop into Waiting needs a reason from the operator, so it returns
 * `needsReason` and the caller asks. Blocked-ness is never invented.
 */
export interface DropUpdate {
  status?: TaskStatus;
  orderKey: string;
  blockedReason?: string | null;
  /** Set when the card was dropped onto a PHASE column (ADR-0045). */
  phaseId?: string | null;
  needsReason?: true;
}

/**
 * What a drop writes.
 *
 * Dropping onto a PHASE column moves the task into that phase (and unblocks it —
 * you deliberately put it somewhere). Dropping onto a status column is the old
 * behavior. Neither ever widens the status enum.
 */
export function updateForDrop(
  task: TaskRowWire,
  to: BoardColumnId,
  orderKey: string,
  isPhase = false,
): DropUpdate {
  if (isPhase) {
    return { orderKey, phaseId: to, blockedReason: null, status: 'now' };
  }
  switch (to) {
    case 'waiting':
      // Already blocked → just a reorder. Otherwise the caller must supply why.
      return task.blockedReason ? { orderKey } : { orderKey, needsReason: true };
    case 'done':
      return { status: 'done', orderKey, blockedReason: null };
    case 'later':
      return { status: 'later', orderKey, blockedReason: null };
    case 'now':
      return { status: 'now', orderKey, blockedReason: null };
    default:
      // An unknown column id in status mode: do nothing but reorder.
      return { orderKey };
  }
}

/** Is a task overdue, relative to a caller-supplied today (no clock in here). */
export function isOverdue(task: TaskRowWire, today: string): boolean {
  return task.status !== 'done' && !!task.dueDate && task.dueDate < today;
}

export const PRIORITIES: TaskPriority[] = ['low', 'normal', 'high'];
