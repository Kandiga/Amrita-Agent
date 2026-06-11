import { useState } from 'react';
import { client } from '../client.ts';
import type { LaneView } from '../lanes-state.ts';
import { isActive } from '../lanes-state.ts';
import { textDir } from '../lib.ts';

interface LanesPanelProps {
  lanes: LaneView[];
  conversationId: string;
  realExecAvailable: boolean;
  onError: (e: unknown) => void;
}

/**
 * Start/observe/cancel lanes. Owns its own form state; lane cards are fed by
 * the live event stream via the `lanes` prop. Dry-run stays the safe default.
 */
export function LanesPanel({ lanes, conversationId, realExecAvailable, onError }: LanesPanelProps) {
  const [goal, setGoal] = useState('');
  const [dryRun, setDryRun] = useState(true);
  const [real, setReal] = useState(false);
  const [maxTurns, setMaxTurns] = useState('');
  const [maxMinutes, setMaxMinutes] = useState('');
  const [busy, setBusy] = useState(false);

  async function startLane(): Promise<void> {
    if (!goal.trim() || !conversationId || busy) return;
    setBusy(true);
    try {
      const budget: { maxTurns?: number; maxMinutes?: number } = {};
      const turns = Number.parseInt(maxTurns, 10);
      const minutes = Number.parseInt(maxMinutes, 10);
      if (Number.isFinite(turns) && turns > 0) budget.maxTurns = turns;
      if (Number.isFinite(minutes) && minutes > 0) budget.maxMinutes = minutes;
      await client.lanesStart({
        conversationId,
        goal: goal.trim(),
        dryRun,
        real,
        detach: true, // observe via the live event stream
        ...(Object.keys(budget).length > 0 ? { budget } : {}),
      });
      setGoal('');
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function cancelLane(laneId: string): Promise<void> {
    try {
      await client.lanesCancel(laneId);
    } catch (e) {
      onError(e);
    }
  }

  return (
    <section className="card lanes-card">
      <h2>Lanes</h2>
      <form
        className="lane-form"
        onSubmit={(e) => {
          e.preventDefault();
          void startLane();
        }}
      >
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          dir={textDir(goal)}
          placeholder="Lane goal (e.g. tidy the repo)"
          rows={2}
        />
        <div className="lane-budget">
          <input
            type="number"
            min="1"
            value={maxTurns}
            onChange={(e) => setMaxTurns(e.target.value)}
            placeholder="max turns"
          />
          <input
            type="number"
            min="1"
            value={maxMinutes}
            onChange={(e) => setMaxMinutes(e.target.value)}
            placeholder="max min"
          />
        </div>
        <label className="lane-check">
          <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
          Dry run (record mandate only)
        </label>
        <label
          className="lane-check"
          title="Real execution must be enabled on the daemon (AMRITA_LANES_ALLOW_REAL_EXECUTION)."
        >
          <input
            type="checkbox"
            checked={real}
            disabled={dryRun}
            onChange={(e) => setReal(e.target.checked)}
          />
          Run for real {realExecAvailable ? '' : '(daemon opt-in required)'}
        </label>
        <button type="submit" disabled={busy || !goal.trim() || !conversationId}>
          {busy ? '…' : 'Start lane'}
        </button>
      </form>
      <div className="lane-list">
        {lanes.length === 0 ? (
          <p>No lanes yet.</p>
        ) : (
          lanes.map((lane) => (
            <article key={lane.id} className={`lane lane-${lane.status}`}>
              <div className="lane-head">
                <span className={`lane-badge lane-badge-${lane.status}`}>{lane.status}</span>
                <small>{lane.id.slice(0, 12)}</small>
                {isActive(lane) ? (
                  <button
                    type="button"
                    className="lane-cancel"
                    onClick={() => void cancelLane(lane.id)}
                  >
                    Cancel
                  </button>
                ) : null}
              </div>
              {lane.goal ? (
                <p className="lane-goal" dir={textDir(lane.goal)}>
                  {lane.goal}
                </p>
              ) : null}
              {lane.progress.length > 0 ? (
                <p className="lane-progress">{lane.progress.at(-1)?.note}</p>
              ) : null}
              {lane.exit ? (
                <p className="lane-exit">
                  exit {lane.exit}
                  {lane.summary ? ` · ${lane.summary}` : lane.reason ? ` · ${lane.reason}` : ''}
                </p>
              ) : null}
            </article>
          ))
        )}
      </div>
    </section>
  );
}
