import { useCallback, useEffect, useState } from 'react';
import type {
  CodingRuntimeLite,
  ConnectorStatusLite,
  GithubImportLite,
  ProviderCatalogEntryLite,
  RuntimeStatusLite,
} from '../api.ts';
import { client } from '../client.ts';
import {
  CATALOG_STATE_LABEL,
  catalogBadgeClass,
  catalogOptionLabel,
  catalogStateHint,
  groupCatalog,
} from '../providers-view.ts';

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

const CONNECTOR_STATE_LABEL: Record<ConnectorStatusLite['state'], string> = {
  connected: 'connected',
  configured_but_failing: 'configured but failing',
  needs_setup: 'needs setup',
  needs_install: 'needs install',
  status_unknown: 'status unknown',
  experimental: 'experimental',
};

function connectorBadgeClass(state: ConnectorStatusLite['state']): string {
  if (state === 'connected') return 'runtime-ok';
  if (state === 'configured_but_failing') return 'runtime-warn';
  return 'runtime-off';
}

interface SettingsRuntimeHubProps {
  projectId?: string | undefined;
  projectName?: string | undefined;
  writeCtx: { projectId: string; conversationId: string } | null;
  onTasksChanged: () => void;
  onError: (e: unknown) => void;
}

/**
 * The Settings & Runtime Hub (ADR-0019): the brain model is selectable per
 * role and per project; coding runtimes are independent cards probed honestly;
 * future connector categories are labeled future — never green. No secret
 * value ever reaches this component: status booleans and env NAMES only.
 */
export function SettingsRuntimeHub({
  projectId,
  projectName,
  writeCtx,
  onTasksChanged,
  onError,
}: SettingsRuntimeHubProps) {
  const [status, setStatus] = useState<RuntimeStatusLite | null>(null);
  const [catalog, setCatalog] = useState<ProviderCatalogEntryLite[] | null>(null);
  const [connectors, setConnectors] = useState<ConnectorStatusLite[] | null>(null);
  const [drafts, setDrafts] = useState<Record<Role, { provider: string; model: string }>>({
    fast: { provider: '', model: '' },
    main: { provider: '', model: '' },
    deep: { provider: '', model: '' },
  });
  const [busy, setBusy] = useState(false);
  const [repoDraft, setRepoDraft] = useState('');
  const [importNote, setImportNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await client.runtimeStatus(projectId));
    } catch (e) {
      onError(e);
    }
    try {
      setCatalog(await client.providersCatalog());
    } catch (e) {
      onError(e);
    }
    try {
      setConnectors(await client.connectorsStatus());
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

  async function importGithub(): Promise<void> {
    const repo = repoDraft.trim();
    if (!writeCtx || !repo || busy) return;
    setBusy(true);
    setImportNote(null);
    try {
      const r: GithubImportLite = await client.githubImport({ ...writeCtx, repo });
      setImportNote(
        `${r.repo}: imported ${r.imported}, skipped ${r.skipped} already present (of ${r.total} open issues)`,
      );
      if (r.imported > 0) onTasksChanged();
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
                  {status.providers.map((p) => {
                    const entry = catalog?.find((c) => c.id === p.id);
                    return (
                      <option key={p.id} value={p.id}>
                        {entry ? catalogOptionLabel(entry) : p.id}
                      </option>
                    );
                  })}
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
        <h2>Brain providers — catalog</h2>
        <p className="hub-note">
          Every provider Amrita knows, with its honest state. "ready" only ever follows real
          evidence — a key present in the environment, a live CLI login probe, or a configured local
          endpoint. Keys live as env-var <em>names</em>; no secret value is ever shown here.
        </p>
        {catalog === null ? (
          <p className="empty-note">Probing provider catalog…</p>
        ) : catalog.length === 0 ? (
          <p className="empty-note">No providers registered.</p>
        ) : (
          groupCatalog(catalog).map((g) => (
            <div key={g.group} className="hub-catalog-group">
              <h3 className="hub-catalog-title">{g.title}</h3>
              {g.entries.map((entry) => {
                const hint = catalogStateHint(entry);
                return (
                  <div key={entry.id} className="hub-runtime">
                    <div className="hub-role-head">
                      <strong>{entry.title}</strong>
                      <span className={`doc-badge ${catalogBadgeClass(entry.state)}`}>
                        {CATALOG_STATE_LABEL[entry.state]}
                      </span>
                    </div>
                    <small>
                      default model {entry.defaultModel}
                      {entry.envName ? ` · key env ${entry.envName}` : ''}
                    </small>
                    <p className="hub-detail">{entry.detail}</p>
                    {hint ? <code className="hub-cmd">{hint}</code> : null}
                  </div>
                );
              })}
            </div>
          ))
        )}
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
        <h2>Setup Hub — connectors</h2>
        <p className="hub-note">
          External sources and tools, each from a typed manifest. "Connected" only ever follows a
          live probe — never a presence check, never a fake green badge.
        </p>
        {connectors === null ? (
          <p className="empty-note">Probing connector status…</p>
        ) : (
          connectors.map((c) => (
            <div key={c.manifest.slug} className="hub-runtime">
              <div className="hub-role-head">
                <strong>{c.manifest.title}</strong>
                <span className={`doc-badge ${connectorBadgeClass(c.state)}`}>
                  {CONNECTOR_STATE_LABEL[c.state]}
                </span>
              </div>
              <small>
                {c.manifest.kind} · {c.manifest.capabilities.join(', ') || 'no capabilities yet'}
              </small>
              <p className="hub-detail">{c.detail}</p>
              {c.state === 'needs_setup' && c.nextCommand ? (
                <code className="hub-cmd">{c.nextCommand}</code>
              ) : null}
              {c.manifest.slug === 'github' && c.state !== 'needs_setup' ? (
                <div className="hub-import">
                  <div className="hub-role-controls">
                    <input
                      value={repoDraft}
                      onChange={(e) => setRepoDraft(e.target.value)}
                      placeholder="owner/repo"
                      aria-label="GitHub repository to import issues from"
                    />
                    <button
                      type="button"
                      disabled={busy || !writeCtx || !repoDraft.trim()}
                      onClick={() => void importGithub()}
                    >
                      Import open issues{projectName ? ` into ${projectName}` : ''}
                    </button>
                  </div>
                  <small>
                    One-way and idempotent: each issue becomes a task tagged github:owner/repo#N;
                    already-imported issues are skipped. Amrita never writes to GitHub.
                  </small>
                  {importNote ? <p className="hub-detail">{importNote}</p> : null}
                </div>
              ) : null}
            </div>
          ))
        )}
        <div className="hub-connectors">
          <div className="hub-connector">
            <strong>API providers &amp; subscriptions</strong>
            <small>
              See the “Brain providers — catalog” card above for live, per-provider states and the
              exact setup command for each. Keys live as env-var names only.
            </small>
          </div>
          <div className="hub-connector hub-future">
            <strong>Hermes bridge · MCP/tool connectors</strong>
            <small>future — discovery-based, each behind its own ADR</small>
          </div>
        </div>
      </section>
    </>
  );
}
