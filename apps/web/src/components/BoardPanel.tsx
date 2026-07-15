import type { PhaseRowWire, RouteVerdictWire, TaskPriority, TaskRowWire } from '@amrita/protocol';
import { useState } from 'react';
import { RpcError } from '../api.ts';
import {
  type BoardColumnId,
  PRIORITIES,
  buildBoard,
  isOverdue,
  keyForDrop,
  updateForDrop,
} from '../board.ts';
import { client } from '../client.ts';
import { type WriteCtx, textDir } from '../lib.ts';

/**
 * The board (ADR-0044).
 *
 * A projection of the task rows — it stores nothing of its own. Moving a card
 * emits ONE `task.updated`, which updates the canonical state, reaches every
 * other client over the project-scoped stream, and is in Amrita's context on her
 * very next turn. No second chat message, no cache to invalidate.
 *
 * ACCESSIBILITY IS THE CONTRACT, NOT THE ENHANCEMENT. Every move is doable from
 * the keyboard (a menu on each card); native drag is layered on top for a mouse.
 * A drag-only board is unusable on a phone and unusable with a keyboard, and this
 * one has to work on both.
 */

interface Props {
  tasks: TaskRowWire[];
  /** The project's own phases (ADR-0045). Empty ⇒ the board falls back to statuses. */
  phases: PhaseRowWire[];
  writeCtx: WriteCtx | null;
  /** Today, as YYYY-MM-DD — passed in so the board itself stays clock-free. */
  today: string;
  /** Cards the chat is currently focused on (ADR-0045). */
  focusedIds: string[];
  onFocus: (ids: string[]) => void;
  onChanged: () => void;
  onError: (e: unknown) => void;
}

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  high: 'High',
  normal: 'Normal',
  low: 'Low',
};

/** Mirrors the daemon's ROUTE_LABEL — one owner would be better, but it is a UI string. */
const ROUTE_LABEL: Record<RouteVerdictWire['route'], string> = {
  'do-now': 'Do now',
  delegate: 'Amrita can do this',
  'needs-connector': 'Needs a connector',
  'needs-approval': 'Needs approval',
  'human-only': 'Human only',
};

export function BoardPanel({
  tasks,
  phases,
  writeCtx,
  today,
  focusedIds,
  onFocus,
  onChanged,
  onError,
}: Props) {
  const columns = buildBoard(tasks, phases);
  const [dragging, setDragging] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** The card someone else changed under us (ADR-0045). */
  const [conflict, setConflict] = useState<string | null>(null);
  /** Per-card execution route (ADR-0045) — derived server-side, cached per view. */
  const [routes, setRoutes] = useState<Record<string, RouteVerdictWire>>({});

  async function move(task: TaskRowWire, to: BoardColumnId, index?: number): Promise<void> {
    if (!writeCtx) return;
    const column = columns.find((c) => c.id === to);
    if (!column) return;

    const orderKey = keyForDrop(column.tasks, index ?? column.tasks.length, task.id);
    const update = updateForDrop(task, to, orderKey, column.isPhase);

    // Moving INTO Waiting means saying what it is waiting ON. Blocked-ness is
    // never invented — the same rule as dropping a question or a risk.
    let blockedReason: string | null | undefined = update.blockedReason;
    if (update.needsReason) {
      const reason = window.prompt('What is this task waiting on?')?.trim();
      if (!reason) return; // cancelled — the card does not move
      blockedReason = reason;
    }

    setBusy(task.id);
    try {
      await client.tasksUpdate({
        ...writeCtx,
        taskId: task.id,
        // ADR-0045: the version THIS client last saw. If the row moved on (another tab,
        // the Scribe, the CLI), the write is refused instead of quietly eating their work.
        expectedVersion: task.version,
        orderKey: update.orderKey,
        ...(update.status ? { status: update.status } : {}),
        ...(update.phaseId !== undefined ? { phaseId: update.phaseId } : {}),
        ...(blockedReason !== undefined ? { blockedReason } : {}),
      });
      onChanged();
    } catch (e) {
      // ADR-0045: a conflict is not a crash — someone else changed this card. Say so
      // plainly and pull the fresh state, so the operator can decide what to do.
      if (e instanceof RpcError && e.code === 'conflict') {
        setConflict(task.id);
        onChanged(); // refetch, so the card redraws at the version that actually won
      } else {
        onError(e);
      }
    } finally {
      setBusy(null);
    }
  }

  /**
   * What can be done with this card (ADR-0045). Fetched on demand, never stored —
   * a route depends on a runtime, a root and a connector, all of which move.
   */
  async function loadRoute(task: TaskRowWire): Promise<void> {
    if (routes[task.id]) return;
    try {
      const v = await client.taskRoute(task.id);
      setRoutes((r) => ({ ...r, [task.id]: v }));
    } catch (e) {
      onError(e);
    }
  }

  async function delegate(task: TaskRowWire): Promise<void> {
    if (!writeCtx) return;
    setBusy(task.id);
    try {
      await client.delegateTask({ ...writeCtx, taskId: task.id });
      onChanged();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(null);
    }
  }

  async function setPriority(task: TaskRowWire, priority: TaskPriority | null): Promise<void> {
    if (!writeCtx) return;
    setBusy(task.id);
    try {
      await client.tasksUpdate({
        ...writeCtx,
        taskId: task.id,
        expectedVersion: task.version,
        priority,
      });
      onChanged();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card board-card">
      <h2>Board</h2>
      <div className="board">
        {columns.map((column) => (
          <div
            key={column.id}
            className="board-column"
            onDragOver={(e) => {
              if (dragging) e.preventDefault(); // permit the drop
            }}
            onDrop={(e) => {
              e.preventDefault();
              const task = tasks.find((t) => t.id === dragging);
              setDragging(null);
              if (task) void move(task, column.id);
            }}
          >
            <header className="board-column-head">
              <h3>
                {column.title} <span className="board-count">{column.tasks.length}</span>
              </h3>
              <small>{column.hint}</small>
            </header>

            {column.tasks.length === 0 ? (
              <p className="empty-note">Nothing in {column.title}.</p>
            ) : (
              <ul className="board-list">
                {column.tasks.map((task, index) => (
                  <li
                    key={task.id}
                    className={`board-task${busy === task.id ? ' busy' : ''}${
                      focusedIds.includes(task.id) ? ' focused' : ''
                    }`}
                    draggable={!!writeCtx}
                    onDragStart={() => setDragging(task.id)}
                    onDragEnd={() => setDragging(null)}
                    onDragOver={(e) => {
                      if (dragging && dragging !== task.id) e.preventDefault();
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation(); // drop ONTO a card = insert at its index
                      const moving = tasks.find((t) => t.id === dragging);
                      setDragging(null);
                      if (moving && moving.id !== task.id) void move(moving, column.id, index);
                    }}
                  >
                    {/* Selecting a card tells Amrita what you are looking at — she
                        should not need you to re-describe your own screen (ADR-0045). */}
                    <button
                      type="button"
                      className="board-task-title"
                      dir={textDir(task.title)}
                      aria-pressed={focusedIds.includes(task.id)}
                      onClick={() =>
                        onFocus(
                          focusedIds.includes(task.id)
                            ? focusedIds.filter((i) => i !== task.id)
                            : [...focusedIds, task.id],
                        )
                      }
                    >
                      {task.title}
                    </button>

                    {/* Why does this card exist? (ADR-0045) */}
                    {task.derivedFrom.length > 0 && (
                      <p className="board-task-why" dir="auto">
                        from {task.derivedFrom.map((d) => `${d.kind}: ${d.label}`).join(' · ')}
                      </p>
                    )}

                    {/* What can actually be DONE with it (ADR-0045). Never faked:
                        a missing connector says exactly what is missing and what
                        approving it would cost. */}
                    {routes[task.id] ? (
                      <div className="board-task-route">
                        <span className={`route-chip ${routes[task.id]?.route}`}>
                          {ROUTE_LABEL[routes[task.id]?.route ?? 'do-now']}
                        </span>
                        <span className="route-detail" dir="auto">
                          {routes[task.id]?.detail}
                        </span>
                        {routes[task.id]?.missing && (
                          <span className="route-risk" dir="auto">
                            Risk of approving: {routes[task.id]?.missing?.risk}
                          </span>
                        )}
                        {routes[task.id]?.route === 'delegate' && !task.laneId && (
                          <button
                            type="button"
                            disabled={!writeCtx || busy === task.id}
                            onClick={() => void delegate(task)}
                          >
                            Hand it to Amrita
                          </button>
                        )}
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="route-ask"
                        onClick={() => void loadRoute(task)}
                      >
                        What can be done with this?
                      </button>
                    )}

                    <p className="board-task-meta">
                      {task.owner && <span className="chip">{task.owner}</span>}
                      {task.dueDate && (
                        <span className={`chip${isOverdue(task, today) ? ' overdue' : ''}`}>
                          {isOverdue(task, today) ? 'overdue ' : 'due '}
                          {task.dueDate}
                        </span>
                      )}
                      {task.priority && task.priority !== 'normal' && (
                        <span className={`chip prio-${task.priority}`}>
                          {PRIORITY_LABEL[task.priority]}
                        </span>
                      )}
                      {/* ADR-0045: a guess must never look like something you said. */}
                      {task.certainty === 'inferred' && (
                        <span
                          className="chip inferred"
                          title="Amrita inferred this — you have not confirmed it"
                        >
                          inferred
                        </span>
                      )}
                    </p>

                    {task.blockedReason && (
                      <p className="board-task-blocked" dir={textDir(task.blockedReason)}>
                        Waiting on: {task.blockedReason}
                      </p>
                    )}

                    {conflict === task.id && (
                      <p className="board-task-conflict">
                        Someone else changed this card. Your move was not applied — this is the
                        version that won.{' '}
                        <button type="button" onClick={() => setConflict(null)}>
                          Got it
                        </button>
                      </p>
                    )}

                    {/* The keyboard path — the real contract. Drag is decoration. */}
                    <div className="board-task-actions">
                      <label className="sr-only" htmlFor={`move-${task.id}`}>
                        Move {task.title} to a column
                      </label>
                      <select
                        id={`move-${task.id}`}
                        value={column.id}
                        disabled={!writeCtx || busy === task.id}
                        onChange={(e) => void move(task, e.target.value as BoardColumnId)}
                      >
                        {columns.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.title}
                          </option>
                        ))}
                      </select>

                      <label className="sr-only" htmlFor={`prio-${task.id}`}>
                        Priority for {task.title}
                      </label>
                      <select
                        id={`prio-${task.id}`}
                        value={task.priority ?? ''}
                        disabled={!writeCtx || busy === task.id}
                        onChange={(e) =>
                          void setPriority(task, (e.target.value || null) as TaskPriority | null)
                        }
                      >
                        <option value="">No priority</option>
                        {PRIORITIES.map((p) => (
                          <option key={p} value={p}>
                            {PRIORITY_LABEL[p]}
                          </option>
                        ))}
                      </select>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
