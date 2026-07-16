import { useState } from 'react';
import type { OperatorApprovalLite, SessionSnapshotLite } from '../api.ts';
import { client } from '../client.ts';
import { type LaneView, isActive } from '../lanes-state.ts';
import { textDir } from '../lib.ts';
import type { SessionPanes } from '../session-state.ts';
import { SessionTerminal } from './SessionTerminal.tsx';

interface SessionsPanelProps {
  /** Which agent this tab drives. */
  agent: 'claude' | 'codex';
  /** Project-wide lanes; conversationId is only the provenance for a new session. */
  lanes: LaneView[];
  projectId: string;
  conversationId: string;
  sessions: SessionPanes;
  approvals: OperatorApprovalLite[];
  realExecAvailable: boolean;
  /** Bearer for the terminal socket (ADR-0052); the daemon re-validates it. */
  authToken?: string | undefined;
  /** Refetch durable lane rows, approval state, and on-demand tmux snapshots. */
  onChanged: () => void | Promise<void>;
  onError: (e: unknown) => void;
}

const TITLE = { claude: 'Claude Code', codex: 'Codex' } as const;
type RuntimeState = SessionSnapshotLite['state'];

const RUNTIME_LABEL: Record<RuntimeState, string> = {
  'awaiting-approval': 'Awaiting approval',
  starting: 'Starting',
  'awaiting-auth': 'Authentication required',
  running: 'Running',
  finishing: 'Finishing',
  completed: 'Completed',
  aborted: 'Cancelled',
  unavailable: 'Screen unavailable',
};

function runtimeFor(
  lane: LaneView,
  pane: SessionPanes[string] | undefined,
  approval: OperatorApprovalLite | undefined,
): RuntimeState {
  if (lane.status === 'completed') return 'completed';
  if (lane.status === 'aborted') return 'aborted';
  if (approval) return 'awaiting-approval';
  return pane?.state ?? 'starting';
}

function inputPlaceholder(state: RuntimeState): string {
  if (state === 'awaiting-auth') return 'Complete authentication in the session first';
  if (state === 'awaiting-approval') return 'Approve the session before sending input';
  if (state === 'unavailable') return 'The tmux screen is unavailable';
  if (state === 'starting') return 'Wait for the agent prompt…';
  if (state === 'finishing') return 'The session is finishing…';
  return 'Type into the session…';
}

/**
 * Project-level interactive Session Workspace (ADR-0050). Durable lane rows recover
 * membership/lifecycle; redacted on-demand snapshots and project-scoped pane events
 * recover the live screen without persisting terminal output.
 */
export function SessionsPanel({
  agent,
  lanes,
  projectId,
  conversationId,
  sessions,
  approvals,
  realExecAvailable,
  authToken,
  onChanged,
  onError,
}: SessionsPanelProps) {
  const kind = agent === 'claude' ? 'claude-code-tmux' : 'codex-tmux';
  const [goal, setGoal] = useState('');
  /** ADR-0054: where the session works — the project folder (real files) or a jail. */
  const [workspace, setWorkspace] = useState<'project' | 'isolated'>('project');
  const [busy, setBusy] = useState(false);
  const [actingLane, setActingLane] = useState<string | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  /** Per-lane terminal reconnect epochs (ADR-0052). */
  const [termEpochs, setTermEpochs] = useState<Record<string, number>>({});

  const mine = lanes.filter((lane) => lane.kind === kind);

  async function refresh(): Promise<void> {
    try {
      await onChanged();
    } catch (e) {
      onError(e);
    }
  }

  async function open(): Promise<void> {
    if (!conversationId || busy) return;
    const trimmed = goal.trim();
    setBusy(true);
    try {
      // ADR-0054: an empty goal opens a clean operator CONSOLE — the full CLI,
      // nothing auto-typed; the operator drives from the first keystroke.
      await client.openSession(
        conversationId,
        kind,
        trimmed || `Operator console — the operator drives this ${TITLE[agent]} session directly.`,
        trimmed ? { workspace } : { workspace, sendGoal: false },
      );
      setGoal('');
      await onChanged();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function act(laneId: string, fn: () => Promise<void>): Promise<void> {
    if (actingLane) return;
    setActingLane(laneId);
    try {
      await fn();
      await onChanged();
    } catch (e) {
      onError(e);
    } finally {
      setActingLane(null);
    }
  }

  return (
    <section className="sessions-panel">
      <header className="sessions-head">
        <div>
          <h2>{TITLE[agent]} Session Workspace</h2>
          <p className="muted">
            Every interactive {TITLE[agent]} session in this project stays here when you switch
            conversations or reconnect. Terminal output is redacted and read directly from tmux —
            never stored in the project database.
          </p>
        </div>
        <button type="button" className="session-refresh" onClick={() => void refresh()}>
          Refresh screens
        </button>
      </header>

      {realExecAvailable ? (
        <div className="sessions-open">
          <textarea
            value={goal}
            dir={textDir(goal)}
            onChange={(e) => setGoal(e.target.value)}
            placeholder={`Optional goal — leave empty to open a clean ${TITLE[agent]} console you drive yourself.`}
            rows={2}
          />
          <div className="session-open-opts">
            <label className="session-workspace">
              Folder
              <select
                value={workspace}
                onChange={(e) =>
                  setWorkspace(e.target.value === 'isolated' ? 'isolated' : 'project')
                }
              >
                <option value="project">Project working folder</option>
                <option value="isolated">Isolated per-session folder</option>
              </select>
            </label>
            <button type="button" onClick={() => void open()} disabled={!conversationId || busy}>
              {busy ? 'Opening…' : goal.trim() ? 'Open session' : 'Open console'}
            </button>
          </div>
          <p className="muted session-open-hint">
            An empty goal opens the full {TITLE[agent]} CLI with nothing auto-typed — every
            /command, model picker and tool is yours. Each open still asks for one approval.
          </p>
        </div>
      ) : (
        <p className="needs-setup">
          Real execution is off, so a session cannot run. Enable it (
          <code>AMRITA_LANES_ALLOW_REAL_EXECUTION=1</code>) and bind a project working folder.
        </p>
      )}

      {mine.length === 0 ? (
        <p className="muted empty">No {TITLE[agent]} sessions in this project yet.</p>
      ) : (
        <ul className="sessions-list">
          {mine.map((lane) => {
            const pane = sessions[lane.id];
            const active = isActive(lane);
            const approval = approvals.find((item) => item.laneId === lane.id);
            const runtime = runtimeFor(lane, pane, approval);
            const input = inputs[lane.id] ?? '';
            const isActing = actingLane === lane.id;
            const canWrite = active && runtime === 'running' && pane?.live === true;
            // The embedded terminal IS the CLI (ADR-0052) — full keyboard control,
            // including auth screens (the human at the keyboard is who MAY answer
            // them). It waits only for the approval gate.
            const showTerminal = active && runtime !== 'awaiting-approval';
            return (
              <li key={lane.id} className="session-card">
                <div className="session-meta">
                  <span
                    className={`session-runtime session-runtime-${runtime}`}
                    aria-label={`Session state: ${RUNTIME_LABEL[runtime]}`}
                  >
                    {RUNTIME_LABEL[runtime]}
                  </span>
                  <span className="session-agent">{TITLE[agent]}</span>
                  <span className="session-goal" dir={textDir(lane.goal ?? '')}>
                    {lane.goal ?? '(no goal)'}
                  </span>
                </div>

                {approval ? (
                  <div className="session-approval">
                    <span>Waiting for your approval to run: {approval.action}</span>
                    <button
                      type="button"
                      disabled={isActing}
                      onClick={() =>
                        void act(lane.id, async () => {
                          await client.approvalsResolve({
                            approvalId: approval.approvalId,
                            decision: 'allow',
                          });
                        })
                      }
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      disabled={isActing}
                      onClick={() =>
                        void act(lane.id, async () => {
                          await client.approvalsResolve({
                            approvalId: approval.approvalId,
                            decision: 'deny',
                          });
                        })
                      }
                    >
                      Deny
                    </button>
                  </div>
                ) : null}

                {runtime === 'awaiting-auth' ? (
                  <output className="session-auth-warning">
                    Authentication is required in this tmux screen. Amrita will not type the goal,
                    credentials, or operator input into it. Complete login manually, then refresh.
                  </output>
                ) : null}

                {showTerminal ? (
                  <>
                    <div className="session-screen-head">
                      <span>Interactive terminal — full CLI control</span>
                      <button
                        type="button"
                        className="session-reconnect"
                        onClick={() =>
                          setTermEpochs((s) => ({ ...s, [lane.id]: (s[lane.id] ?? 0) + 1 }))
                        }
                      >
                        Reconnect
                      </button>
                    </div>
                    <SessionTerminal
                      projectId={projectId}
                      laneId={lane.id}
                      authToken={authToken}
                      epoch={termEpochs[lane.id] ?? 0}
                    />
                  </>
                ) : (
                  <>
                    <div className="session-screen-head">
                      <span>{pane?.live ? 'Live tmux screen' : 'Recovered session state'}</span>
                      {pane?.capturedAt ? (
                        <time dateTime={pane.capturedAt}>
                          {new Date(pane.capturedAt).toLocaleTimeString()}
                        </time>
                      ) : null}
                    </div>
                    <pre className="session-pane" aria-label="redacted live session output">
                      {pane?.text ||
                        (active
                          ? runtime === 'unavailable'
                            ? 'The tmux session is not available. You can safely cancel this lane.'
                            : 'Waiting for the session to produce output…'
                          : 'No live output remains for this completed session.')}
                    </pre>
                  </>
                )}

                {active ? (
                  <div className="session-controls">
                    {!showTerminal ? (
                      <>
                        <input
                          value={input}
                          dir={textDir(input)}
                          onChange={(e) =>
                            setInputs((state) => ({ ...state, [lane.id]: e.target.value }))
                          }
                          placeholder={inputPlaceholder(runtime)}
                          disabled={!canWrite || isActing}
                        />
                        <button
                          type="button"
                          disabled={!canWrite || !input.trim() || isActing}
                          onClick={() =>
                            void act(lane.id, async () => {
                              const result = await client.sessionSend(projectId, lane.id, input);
                              if (!result.sent)
                                throw new Error('The session no longer accepts input.');
                              setInputs((state) => ({ ...state, [lane.id]: '' }));
                            })
                          }
                        >
                          {isActing ? 'Working…' : 'Send'}
                        </button>
                      </>
                    ) : (
                      <span className="session-hint muted">
                        Type directly in the terminal — arrows, Esc and /commands all work.
                      </span>
                    )}
                    <button
                      type="button"
                      disabled={isActing || (!showTerminal && !canWrite)}
                      onClick={() =>
                        void act(lane.id, async () => {
                          const result = await client.sessionFinish(projectId, lane.id);
                          if (!result.finished) throw new Error('The session is no longer active.');
                        })
                      }
                    >
                      Finish
                    </button>
                    <button
                      type="button"
                      className="danger"
                      disabled={isActing}
                      onClick={() =>
                        void act(lane.id, async () => {
                          await client.sessionCancel(projectId, lane.id);
                        })
                      }
                    >
                      Cancel
                    </button>
                  </div>
                ) : lane.summary ? (
                  <p className="session-summary" dir={textDir(lane.summary)}>
                    {lane.summary}
                  </p>
                ) : null}

                {/* HARMONY-4: the kernel's cross-QA + compare, one click away. The
                    new lane opens under the OTHER agent's tab (same project). */}
                <div className="session-correlate">
                  {lane.status === 'completed' ? (
                    <button
                      type="button"
                      disabled={isActing || !conversationId}
                      onClick={() =>
                        void act(lane.id, async () => {
                          await client.startCorrelatedLane(conversationId, {
                            kind: agent === 'claude' ? 'codex-tmux' : 'claude-code-tmux',
                            goal: `Independently verify the finished work of this ${TITLE[agent]} session: ${lane.goal ?? lane.id}. Inspect the files in your working folder and report what passes and what does not.`,
                            verifiesLaneId: lane.id,
                          });
                        })
                      }
                    >
                      QA with {agent === 'claude' ? TITLE.codex : TITLE.claude}
                    </button>
                  ) : null}
                  {lane.goal && lane.status !== 'aborted' ? (
                    <button
                      type="button"
                      disabled={isActing || !conversationId}
                      onClick={() =>
                        void act(lane.id, async () => {
                          await client.startCorrelatedLane(conversationId, {
                            kind: agent === 'claude' ? 'codex-tmux' : 'claude-code-tmux',
                            goal: lane.goal ?? '',
                            groupId: lane.id,
                            role: 'compare',
                          });
                        })
                      }
                    >
                      Compare with {agent === 'claude' ? TITLE.codex : TITLE.claude}
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
