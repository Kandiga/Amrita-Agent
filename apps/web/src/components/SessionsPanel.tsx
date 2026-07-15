import { useState } from 'react';
import type { OperatorApprovalLite } from '../api.ts';
import { client } from '../client.ts';
import { type LaneView, isActive } from '../lanes-state.ts';
import { textDir } from '../lib.ts';
import type { SessionPanes } from '../session-state.ts';

interface SessionsPanelProps {
  /** Which agent this tab drives. */
  agent: 'claude' | 'codex';
  /** All lanes; the panel filters to this agent's `*-tmux` sessions. */
  lanes: LaneView[];
  conversationId: string;
  sessions: SessionPanes;
  approvals: OperatorApprovalLite[];
  realExecAvailable: boolean;
  onError: (e: unknown) => void;
}

const TITLE = { claude: 'Claude Code', codex: 'Codex' } as const;

/**
 * The Claude / Codex tab (ADR-0049) — open an INTERACTIVE session and watch the agent
 * work live in a tmux pane, send it input, and finish it. This is the observable,
 * operator-attended execution mode (autonomous work stays headless).
 */
export function SessionsPanel({
  agent,
  lanes,
  conversationId,
  sessions,
  approvals,
  realExecAvailable,
  onError,
}: SessionsPanelProps) {
  const kind = agent === 'claude' ? 'claude-code-tmux' : 'codex-tmux';
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const [inputs, setInputs] = useState<Record<string, string>>({});

  const mine = lanes.filter((l) => l.kind === kind);

  async function open(): Promise<void> {
    if (!goal.trim() || !conversationId || busy) return;
    setBusy(true);
    try {
      await client.openSession(conversationId, kind, goal.trim());
      setGoal('');
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function act(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      onError(e);
    }
  }

  return (
    <section className="sessions-panel">
      <header className="sessions-head">
        <h2>{TITLE[agent]} sessions</h2>
        <p className="muted">
          Open an interactive session and watch {TITLE[agent]} work live. You can type into it and
          finish it when it is done — this is the attended execution mode.
        </p>
      </header>

      {realExecAvailable ? (
        <div className="sessions-open">
          <textarea
            value={goal}
            dir={textDir(goal)}
            onChange={(e) => setGoal(e.target.value)}
            placeholder={`What should ${TITLE[agent]} do in this project?`}
            rows={2}
          />
          <button type="button" onClick={() => void open()} disabled={!goal.trim() || busy}>
            {busy ? 'Opening…' : 'Open session'}
          </button>
        </div>
      ) : (
        <p className="needs-setup">
          Real execution is off, so a session cannot run. Enable it (
          <code>AMRITA_LANES_ALLOW_REAL_EXECUTION=1</code>) and bind a project working folder.
        </p>
      )}

      {mine.length === 0 ? (
        <p className="muted empty">No {TITLE[agent]} sessions yet. Open one above.</p>
      ) : (
        <ul className="sessions-list">
          {mine.map((lane) => {
            const pane = sessions[lane.id] ?? '';
            const active = isActive(lane);
            const appr = approvals.find((a) => a.laneId === lane.id);
            const input = inputs[lane.id] ?? '';
            return (
              <li key={lane.id} className="session-card">
                <div className="session-meta">
                  <span className={`lane-status lane-${lane.status}`}>
                    {lane.exit ?? lane.status}
                  </span>
                  <span className="session-agent">{TITLE[agent]}</span>
                  <span className="session-goal" dir={textDir(lane.goal ?? '')}>
                    {lane.goal ?? '(no goal)'}
                  </span>
                </div>

                {appr ? (
                  <div className="session-approval">
                    <span>Waiting for your approval to run: {appr.action}</span>
                    <button
                      type="button"
                      onClick={() =>
                        void act(() =>
                          client.approvalsResolve({
                            approvalId: appr.approvalId,
                            decision: 'allow',
                          }),
                        )
                      }
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void act(() =>
                          client.approvalsResolve({
                            approvalId: appr.approvalId,
                            decision: 'deny',
                          }),
                        )
                      }
                    >
                      Deny
                    </button>
                  </div>
                ) : null}

                <pre className="session-pane" aria-label="live session output">
                  {pane || (active ? 'waiting for the session to produce output…' : 'no output')}
                </pre>

                {active ? (
                  <div className="session-controls">
                    <input
                      value={input}
                      dir={textDir(input)}
                      onChange={(e) => setInputs((s) => ({ ...s, [lane.id]: e.target.value }))}
                      placeholder="type into the session…"
                    />
                    <button
                      type="button"
                      disabled={!input.trim()}
                      onClick={() =>
                        void act(async () => {
                          await client.sessionSend(lane.id, input);
                          setInputs((s) => ({ ...s, [lane.id]: '' }));
                        })
                      }
                    >
                      Send
                    </button>
                    <button
                      type="button"
                      onClick={() => void act(() => client.sessionFinish(lane.id))}
                    >
                      Finish
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => void act(() => client.lanesCancel(lane.id))}
                    >
                      Cancel
                    </button>
                  </div>
                ) : lane.summary ? (
                  <p className="session-summary" dir={textDir(lane.summary)}>
                    {lane.summary}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
