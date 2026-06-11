import { useCallback, useEffect, useState } from 'react';
import type { CodingRuntimeLite, RuntimeStatusLite } from '../api.ts';
import { client } from '../client.ts';

const ROLES = ['fast', 'main', 'deep'] as const;
type Role = (typeof ROLES)[number];

const ROLE_HINT: Record<Role, string> = {
  fast: 'quick, cheap turns (summaries, background work)',
  main: 'the default conversation brain',
  deep: 'hard reasoning and planning',
};

const RUNTIME_STATE_LABEL: Record<CodingRuntimeLite['state'], string> = {
  ready: 'ready',
  installed_unauthenticated: 'not logged in',
  installed_auth_unknown: 'auth not verified',
  not_installed: 'not installed',
  status_unknown: 'status unknown',
};

interface SettingsRuntimeHubProps {
  projectId?: string | undefined;
  projectName?: string | undefined;
  onError: (e: unknown) => void;
}

/**
 * The Settings & Runtime Hub (ADR-0019): the brain model is selectable per
 * role and per project; coding runtimes are independent cards probed honestly;
 * future connector categories are labeled future — never green. No secret
 * value ever reaches this component: status booleans and env NAMES only.
 */
export function SettingsRuntimeHub({ projectId, projectName, onError }: SettingsRuntimeHubProps) {
  const [status, setStatus] = useState<RuntimeStatusLite | null>(null);
  const [drafts, setDrafts] = useState<Record<Role, { provider: string; model: string }>>({
    fast: { provider: '', model: '' },
    main: { provider: '', model: '' },
    deep: { provider: '', model: '' },
  });
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await client.runtimeStatus(projectId));
    } catch (e) {
      onError(e);
    }
  }, [projectId, onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function apply(role: Role, scope: 'global' | 'project'): Promise<void> {
    const draft = drafts[role];
    if (!draft.provider || busy) return;
    setBusy(true);
    try {
      await client.roleSet({
        role,
        provider: draft.provider,
        ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
        ...(scope === 'project' && projectId ? { projectId } : {}),
      });
      await refresh();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function clear(role: Role, scope: 'global' | 'project'): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await client.roleClear({
        role,
        ...(scope === 'project' && projectId ? { projectId } : {}),
      });
      await refresh();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  if (!status) {
    return (
      <section className="card">
        <h2>Runtime settings</h2>
        <p className="empty-note">Loading runtime status…</p>
      </section>
    );
  }

  return (
    <>
      <section className="card">
        <h2>Amrita brain</h2>
        <p className="hub-note">
          Which model thinks for each role. Resolution: project override → global → auto. Switching
          never touches project memory — history and state live in Amrita's store, not in any
          provider.
        </p>
        {status.roles.map((r) => {
          const role = r.role as Role;
          const draft = drafts[role];
          return (
            <div key={r.role} className="hub-role">
              <div className="hub-role-head">
                <strong>{r.role}</strong>
                <span className="hub-role-effective">
                  → {r.resolvesTo}
                  {r.model ? ` (${r.model})` : ''}
                  <span className={`hub-via hub-via-${r.via}`}>{r.via}</span>
                </span>
              </div>
              <small>{ROLE_HINT[role]}</small>
              <div className="hub-role-controls">
                <select
                  value={draft.provider}
                  onChange={(e) =>
                    setDrafts((d) => ({ ...d, [role]: { ...d[role], provider: e.target.value } }))
                  }
                >
                  <option value="">choose provider…</option>
                  {status.providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.id}
                      {p.available ? '' : ' (unavailable)'}
                    </option>
                  ))}
                </select>
                <input
                  value={draft.model}
                  onChange={(e) =>
                    setDrafts((d) => ({ ...d, [role]: { ...d[role], model: e.target.value } }))
                  }
                  placeholder="model (optional)"
                />
              </div>
              <div className="hub-role-actions">
                <button
                  type="button"
                  disabled={busy || !draft.provider}
                  onClick={() => void apply(role, 'global')}
                >
                  Set global
                </button>
                {r.binding ? (
                  <button type="button" disabled={busy} onClick={() => void clear(role, 'global')}>
                    Clear global
                  </button>
                ) : null}
                {projectId ? (
                  <>
                    <button
                      type="button"
                      disabled={busy || !draft.provider}
                      onClick={() => void apply(role, 'project')}
                    >
                      Set for {projectName ?? 'project'}
                    </button>
                    {r.projectBinding ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void clear(role, 'project')}
                      >
                        Clear project override
                      </button>
                    ) : null}
                  </>
                ) : null}
              </div>
            </div>
          );
        })}
      </section>

      <section className="card">
        <h2>Coding runtimes</h2>
        <p className="hub-note">
          Execution hands, independent of the brain — Amrita supervises them whichever model is
          thinking.
        </p>
        {status.codingRuntimes.map((rt) => (
          <div key={rt.id} className="hub-runtime">
            <div className="hub-role-head">
              <strong>{rt.title}</strong>
              <span
                className={`doc-badge runtime-${rt.state === 'ready' ? 'ok' : rt.state === 'not_installed' || rt.state === 'status_unknown' ? 'off' : 'warn'}`}
              >
                {RUNTIME_STATE_LABEL[rt.state]}
              </span>
            </div>
            <small>
              {rt.version ? `${rt.version} · ` : ''}
              real execution {rt.realExecution ? 'enabled' : 'disabled (safe default)'}
            </small>
            <p className="hub-detail">{rt.detail}</p>
            {rt.nextCommand ? <code className="hub-cmd">{rt.nextCommand}</code> : null}
          </div>
        ))}
        <div className="hub-runtime hub-future">
          <div className="hub-role-head">
            <strong>Codex CLI · OpenCode · local agents</strong>
            <span className="doc-badge runtime-off">future</span>
          </div>
          <p className="hub-detail">
            Planned behind the same typed bridge contract — never an ad-hoc button.
          </p>
        </div>
      </section>

      <section className="card">
        <h2>Connectors</h2>
        {(() => {
          const real = status.providers.filter((p) => p.kind === 'real');
          const configured = real.filter((p) => p.configuredAccounts > 0).length;
          const available = real.filter((p) => p.available).length;
          return (
            <div className="hub-connectors">
              <div className="hub-connector">
                <strong>API providers</strong>
                <small>
                  {real.map((p) => p.id).join(', ')} — {configured} configured, {available} ready
                  (keys live as env names only; see Runtime panel for exact setup commands)
                </small>
              </div>
              <div className="hub-connector">
                <strong>Local runtime</strong>
                <small>mock — deterministic, always available, streams live</small>
              </div>
              <div className="hub-connector">
                <strong>Subscription connectors</strong>
                <small>
                  Claude Code (above) via its own official login. No unofficial "Max API", no
                  credential scraping — ever.
                </small>
              </div>
              <div className="hub-connector hub-future">
                <strong>Hermes bridge · MCP/tool connectors</strong>
                <small>future — discovery-based, each behind its own ADR</small>
              </div>
            </div>
          );
        })()}
      </section>
    </>
  );
}
