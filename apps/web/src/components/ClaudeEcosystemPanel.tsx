import { useCallback, useEffect, useState } from 'react';
import type { CodingRuntimeLite, ConnectorStatusLite, SkillStatusLite } from '../api.ts';
import { client } from '../client.ts';
import type { LaneView } from '../lanes-state.ts';
import { textDir } from '../lib.ts';
import {
  CONNECTOR_STATE_LABEL,
  RUNTIME_STATE_LABEL,
  connectorBadgeClass,
  runtimeBadgeClass,
} from '../providers-view.ts';

/**
 * The Claude Ecosystem panel (ADR-0043).
 *
 * What it is: an honest, read-only window into what the Claude Code runtime
 * Amrita drives ACTUALLY has — install/auth state, the tools a real lane may
 * use, the registered skills, the configured MCP servers, and the live session
 * (= the running lane, which IS the remote Claude window per R4).
 *
 * What it deliberately is NOT: a terminal. Amrita invokes `claude -p` one-shot
 * per turn and `claude --print` one-shot per lane — there is no persistent
 * attachable process to stream a shell into. Rendering a fake prompt would be
 * the exact "fake green badge" this project forbids. Every state below comes
 * from a live daemon probe; nothing is simulated.
 */

type Tab = 'runtime' | 'abilities' | 'skills' | 'mcp' | 'session';

const TABS: { id: Tab; label: string }[] = [
  { id: 'runtime', label: 'Runtime' },
  { id: 'abilities', label: 'Abilities' },
  { id: 'skills', label: 'Skills' },
  { id: 'mcp', label: 'MCP' },
  { id: 'session', label: 'Session' },
];

interface ClaudeEcosystemPanelProps {
  open: boolean;
  onClose: () => void;
  projectId?: string | undefined;
  /** Live lanes for the open conversation — the real "Claude session" (R4). */
  lanes: LaneView[];
  onError: (e: unknown) => void;
}

export function ClaudeEcosystemPanel({
  open,
  onClose,
  projectId,
  lanes,
  onError,
}: ClaudeEcosystemPanelProps) {
  const [tab, setTab] = useState<Tab>('runtime');
  const [runtimes, setRuntimes] = useState<CodingRuntimeLite[] | null>(null);
  const [skills, setSkills] = useState<SkillStatusLite[] | null>(null);
  const [connectors, setConnectors] = useState<ConnectorStatusLite[] | null>(null);

  const load = useCallback(async () => {
    try {
      const [status, skillRows, connectorRows] = await Promise.all([
        client.runtimeStatus(projectId),
        client.skillsList(projectId),
        client.connectorsStatus(),
      ]);
      setRuntimes(status.codingRuntimes);
      setSkills(skillRows);
      setConnectors(connectorRows);
    } catch (e) {
      onError(e);
    }
  }, [projectId, onError]);

  // Probe only while open — a closed drawer must not poll the daemon.
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // Esc closes — standard dismissible-overlay affordance.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const claude = runtimes?.find((r) => r.id === 'claude-code');
  const codex = runtimes?.find((r) => r.id === 'codex');
  const mcpConnectors = (connectors ?? []).filter((c) => c.manifest.slug.endsWith('-mcp'));
  const activeLane = lanes.find((l) => !l.exit) ?? lanes[0];

  return (
    <>
      <button
        type="button"
        className="eco-backdrop"
        aria-label="Close the Claude ecosystem panel"
        onClick={onClose}
      />
      <section className="eco-panel" aria-label="Claude ecosystem">
        <header className="eco-head">
          <div className="eco-title">
            <span
              className={`eco-dot ${claude ? runtimeBadgeClass(claude.state) : 'runtime-off'}`}
            />
            <div>
              <strong>Claude Code</strong>
              <small>
                {claude
                  ? `${RUNTIME_STATE_LABEL[claude.state]}${claude.version ? ` · ${claude.version}` : ''}`
                  : 'probing…'}
              </small>
            </div>
          </div>
          <button type="button" className="eco-close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>

        <nav className="eco-tabs" aria-label="Ecosystem sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={tab === t.id ? 'active' : ''}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="eco-body">
          {tab === 'runtime' ? (
            <div className="eco-section">
              {runtimes === null ? (
                <p className="empty-note">Probing the local runtimes…</p>
              ) : (
                runtimes.map((rt) => (
                  <div key={rt.id} className="eco-row">
                    <div className="eco-row-head">
                      <strong>{rt.title}</strong>
                      <span className={`doc-badge ${runtimeBadgeClass(rt.state)}`}>
                        {RUNTIME_STATE_LABEL[rt.state]}
                      </span>
                    </div>
                    <p className="eco-detail">{rt.detail}</p>
                    {rt.version ? <code className="eco-code">{rt.version}</code> : null}
                    {rt.nextCommand ? <code className="eco-code">{rt.nextCommand}</code> : null}
                    {rt.realExecution ? (
                      <p className="eco-note">real lane execution enabled on this daemon</p>
                    ) : null}
                  </div>
                ))
              )}
              <p className="eco-foot">
                Amrita drives these CLIs one-shot per turn/lane (<code>claude -p</code>,{' '}
                <code>codex exec</code>) using your subscription login — no API key exists in this
                path. There is no persistent shell session to attach to.
              </p>
            </div>
          ) : null}

          {tab === 'abilities' ? (
            <div className="eco-section">
              <div className="eco-row">
                <div className="eco-row-head">
                  <strong>Chat turns</strong>
                  <span className="doc-badge runtime-off">no tools</span>
                </div>
                <p className="eco-detail">
                  A chat turn runs <code>claude -p</code> with no <code>--allowedTools</code>: she
                  can read the conversation and answer, but cannot touch files. This is structural,
                  not a setting.
                </p>
              </div>
              <div className="eco-row">
                <div className="eco-row-head">
                  <strong>Lane runs</strong>
                  <span
                    className={`doc-badge ${
                      claude?.allowedTools?.length ? 'runtime-ok' : 'runtime-off'
                    }`}
                  >
                    {claude?.allowedTools?.length
                      ? `${claude.allowedTools.length} tools`
                      : 'read-only'}
                  </span>
                </div>
                {claude?.allowedTools?.length ? (
                  <>
                    <div className="eco-tools">
                      {claude.allowedTools.map((t) => (
                        <span key={t} className="eco-tool">
                          {t}
                        </span>
                      ))}
                    </div>
                    <p className="eco-detail">
                      Granted to a real lane inside its workspace only, and every real run is
                      approval-gated. <code>Bash</code> is deliberately withheld.
                    </p>
                  </>
                ) : (
                  <p className="eco-detail">
                    The runner default is read-only (Read/Grep/Glob/LS). Set{' '}
                    <code>AMRITA_LANES_ALLOWED_TOOLS</code> on the daemon to grant more.
                  </p>
                )}
              </div>
              {codex ? (
                <div className="eco-row">
                  <div className="eco-row-head">
                    <strong>Codex lanes</strong>
                    <span className={`doc-badge ${runtimeBadgeClass(codex.state)}`}>
                      {RUNTIME_STATE_LABEL[codex.state]}
                    </span>
                  </div>
                  <p className="eco-detail">
                    Codex sandboxes by <em>directory</em> (<code>--sandbox workspace-write</code>),
                    not by a tool allowlist — it may write inside its workspace and nowhere else.
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}

          {tab === 'skills' ? (
            <div className="eco-section">
              {skills === null ? (
                <p className="empty-note">Loading the skill registry…</p>
              ) : skills.length === 0 ? (
                <p className="empty-note">No skills registered yet.</p>
              ) : (
                skills.map((s) => (
                  <div key={`${s.tier}:${s.name}`} className="eco-row">
                    <div className="eco-row-head">
                      <strong>{s.name}</strong>
                      <span
                        className={`doc-badge ${s.state === 'active' ? 'runtime-ok' : 'runtime-off'}`}
                      >
                        {s.tier}
                      </span>
                    </div>
                    <p className="eco-detail">{s.manifest?.description ?? s.detail}</p>
                    {s.manifest?.permissions.toolsets.length ? (
                      <div className="eco-tools">
                        {s.manifest.permissions.toolsets.map((t) => (
                          <span key={t} className="eco-tool">
                            {t}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))
              )}
              <p className="eco-foot">
                <strong>Registered, not executed.</strong> The registry gates and documents skills
                (ADR-0035); Amrita has no skill executor yet, and this panel will not pretend
                otherwise.
              </p>
            </div>
          ) : null}

          {tab === 'mcp' ? (
            <div className="eco-section">
              {connectors === null ? (
                <p className="empty-note">Reading the CLI configs…</p>
              ) : mcpConnectors.length === 0 ? (
                <p className="empty-note">No MCP surfaces registered.</p>
              ) : (
                mcpConnectors.map((c) => (
                  <div key={c.manifest.slug} className="eco-row">
                    <div className="eco-row-head">
                      <strong>{c.manifest.title}</strong>
                      <span className={`doc-badge ${connectorBadgeClass(c.state)}`}>
                        {CONNECTOR_STATE_LABEL[c.state]}
                      </span>
                    </div>
                    <p className="eco-detail">{c.detail}</p>
                    {c.nextCommand ? <code className="eco-code">{c.nextCommand}</code> : null}
                  </div>
                ))
              )}
              <p className="eco-foot">
                <strong>Configured is not connected.</strong> Amrita reads each CLI's config to list
                its MCP servers; it does not health-probe them, so it never shows a green badge it
                cannot prove.
              </p>
            </div>
          ) : null}

          {tab === 'session' ? (
            <div className="eco-section">
              {!activeLane ? (
                <div className="eco-empty">
                  <h3>No Claude session running</h3>
                  <p>
                    Amrita opens a Claude Code session when you give her real work — start a lane
                    from the <strong>Project</strong> board. Its live output streams here, and
                    whatever it builds appears on the canvas.
                  </p>
                </div>
              ) : (
                <>
                  <div className="eco-row">
                    <div className="eco-row-head">
                      <strong>{activeLane.kind}</strong>
                      <span
                        className={`doc-badge ${activeLane.exit ? 'runtime-off' : 'runtime-ok'}`}
                      >
                        {activeLane.exit ? `exit ${activeLane.exit}` : activeLane.status}
                      </span>
                    </div>
                    {activeLane.goal ? (
                      <p className="eco-detail" dir={textDir(activeLane.goal)}>
                        {activeLane.goal}
                      </p>
                    ) : null}
                  </div>
                  <div className="eco-console" aria-label="Claude session output">
                    {activeLane.progress.length === 0 ? (
                      <p className="eco-console-line">waiting for the first output…</p>
                    ) : (
                      activeLane.progress.map((n, i) => (
                        <p key={`${activeLane.id}-${i}`} className="eco-console-line" dir="auto">
                          {n.note}
                          {n.pct !== undefined ? ` (${n.pct}%)` : ''}
                        </p>
                      ))
                    )}
                  </div>
                  <p className="eco-foot">
                    This is the real Claude Code process Amrita spawned — its live event stream, not
                    a terminal emulator. It runs inside the lane contract: workspace-confined,
                    budgeted, approval-gated.
                  </p>
                </>
              )}
            </div>
          ) : null}
        </div>
      </section>
    </>
  );
}
