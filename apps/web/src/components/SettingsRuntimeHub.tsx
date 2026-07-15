import { PROVIDER_ROLES, type ProviderRole } from '@amrita/protocol';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import type {
  ConnectorStatusLite,
  GithubImportLite,
  ProviderCatalogEntryLite,
  RuntimeStatusLite,
} from '../api.ts';
import { client } from '../client.ts';
import {
  CATALOG_STATE_LABEL,
  CONNECTOR_STATE_LABEL,
  RUNTIME_STATE_LABEL,
  catalogBadgeClass,
  catalogOptionLabel,
  catalogStateHint,
  connectorBadgeClass,
  groupCatalog,
} from '../providers-view.ts';
import { AccountsPanel } from './AccountsPanel.tsx';
import { ChannelsPanel } from './ChannelsPanel.tsx';
import { PreferencesPanel } from './PreferencesPanel.tsx';
import { SystemBrainPanel } from './SystemBrainPanel.tsx';

const ROLES = PROVIDER_ROLES;
type Role = ProviderRole;

const ROLE_HINT: Record<Role, string> = {
  fast: 'quick, cheap turns (summaries, background work)',
  main: 'the default conversation brain',
  deep: 'hard reasoning and planning',
};

interface SettingsRuntimeHubProps {
  projectId?: string | undefined;
  projectName?: string | undefined;
  writeCtx: { projectId: string; conversationId: string } | null;
  onTasksChanged: () => void;
  onError: (e: unknown) => void;
  /** The Access (token) section, owned by the shell — rendered as a settings page. */
  accessSlot?: ReactNode;
  /** True on a 401: jump straight to the Access section. */
  focusAccess?: boolean;
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
  accessSlot,
  focusAccess,
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

  /** claude.ai-style settings sub-navigation (left nav on desktop). */
  const [section, setSection] = useState<
    | 'brain'
    | 'providers'
    | 'accounts'
    | 'runtimes'
    | 'connectors'
    | 'channels'
    | 'preferences'
    | 'system'
    | 'access'
  >('brain');
  // Discovered models per role, populated from providers.models when a provider is
  // picked — turns the free-text model box into a real (still typable) picker.
  const [models, setModels] = useState<Record<Role, string[]>>({ fast: [], main: [], deep: [] });

  const discoverModels = useCallback(async (role: Role, provider: string) => {
    if (!provider) return;
    try {
      const res = await client.providersModels(provider);
      setModels((m) => ({ ...m, [role]: res.models }));
    } catch {
      setModels((m) => ({ ...m, [role]: [] })); // honest: no discovery, keep free-text
    }
  }, []);

  // A 401 anywhere lands the user exactly where the fix lives.
  useEffect(() => {
    if (focusAccess && accessSlot) setSection('access');
  }, [focusAccess, accessSlot]);

  const NAV: { id: typeof section; label: string; hint: string }[] = [
    { id: 'brain', label: 'Amrita brain', hint: 'which model thinks for each role' },
    { id: 'providers', label: 'Providers', hint: 'every brain Amrita knows, honest states' },
    {
      id: 'accounts',
      label: 'Accounts',
      hint: 'provider accounts + local endpoint (env names only)',
    },
    { id: 'runtimes', label: 'Coding runtimes', hint: 'Claude Code and friends' },
    { id: 'connectors', label: 'Connectors', hint: 'sources like GitHub' },
    { id: 'channels', label: 'Channels', hint: 'Telegram, WhatsApp, web' },
    { id: 'preferences', label: 'Preferences', hint: 'how Amrita behaves during a turn' },
    { id: 'system', label: 'Global Amrita', hint: 'system brain health + self-audit' },
    ...(accessSlot
      ? [{ id: 'access' as const, label: 'Access', hint: 'runtime token for this browser' }]
      : []),
  ];

  // No runtime status yet — the nav and the Access section MUST stay reachable:
  // the most common reason status can't load is exactly a missing token, and
  // entering the token happens in Access. Never gate the door behind the lock.
  if (!status) {
    return (
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {NAV.map((n) => (
            <button
              type="button"
              key={n.id}
              className={section === n.id ? 'active' : ''}
              title={n.hint}
              onClick={() => setSection(n.id)}
            >
              {n.label}
            </button>
          ))}
        </nav>
        <div className="settings-content">
          {section === 'access' && accessSlot ? (
            accessSlot
          ) : (
            <section className="card">
              <h2>Runtime settings</h2>
              <p className="empty-note">
                Loading runtime status… If this never finishes, the runtime probably needs your
                access token — open the <strong>Access</strong> section.
              </p>
            </section>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings sections">
        {NAV.map((n) => (
          <button
            type="button"
            key={n.id}
            className={section === n.id ? 'active' : ''}
            title={n.hint}
            onClick={() => setSection(n.id)}
          >
            {n.label}
          </button>
        ))}
      </nav>
      <div className="settings-content">
        {section === 'access' ? accessSlot : null}
        {section === 'brain' ? (
          <section className="card">
            <h2>Amrita brain</h2>
            <p className="hub-note">
              Which model thinks for each role. Resolution: project override → global → auto.
              Switching never touches project memory — history and state live in Amrita's store, not
              in any provider.
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
                      onChange={(e) => {
                        const provider = e.target.value;
                        setDrafts((d) => ({ ...d, [role]: { ...d[role], provider } }));
                        void discoverModels(role, provider);
                      }}
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
                      list={`models-${role}`}
                      onChange={(e) =>
                        setDrafts((d) => ({ ...d, [role]: { ...d[role], model: e.target.value } }))
                      }
                      placeholder={
                        models[role].length > 0 ? 'model (pick or type)' : 'model (optional)'
                      }
                    />
                    <datalist id={`models-${role}`}>
                      {models[role].map((m) => (
                        <option key={m} value={m} />
                      ))}
                    </datalist>
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
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void clear(role, 'global')}
                      >
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
        ) : null}
        {section === 'providers' ? (
          <section className="card">
            <h2>Brain providers — catalog</h2>
            <p className="hub-note">
              Every provider Amrita knows, with its honest state. "ready" only ever follows real
              evidence — a key present in the environment, a live CLI login probe, or a configured
              local endpoint. Keys live as env-var <em>names</em>; no secret value is ever shown
              here.
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
        ) : null}
        {section === 'runtimes' ? (
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
        ) : null}
        {section === 'connectors' ? (
          <section className="card">
            <h2>Setup Hub — connectors</h2>
            <p className="hub-note">
              External sources and tools, each from a typed manifest. "Connected" only ever follows
              a live probe — never a presence check, never a fake green badge.
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
                    {c.manifest.kind} ·{' '}
                    {c.manifest.capabilities.join(', ') || 'no capabilities yet'}
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
                        One-way and idempotent: each issue becomes a task tagged
                        github:owner/repo#N; already-imported issues are skipped. Amrita never
                        writes to GitHub.
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
                  See the “Brain providers — catalog” card above for live, per-provider states and
                  the exact setup command for each. Keys live as env-var names only.
                </small>
              </div>
              <div className="hub-connector hub-future">
                <strong>Hermes bridge · MCP/tool connectors</strong>
                <small>future — discovery-based, each behind its own ADR</small>
              </div>
            </div>
          </section>
        ) : null}
        {section === 'accounts' ? <AccountsPanel writeCtx={writeCtx} onError={onError} /> : null}
        {section === 'channels' ? <ChannelsPanel writeCtx={writeCtx} onError={onError} /> : null}
        {section === 'preferences' ? (
          <PreferencesPanel writeCtx={writeCtx} onError={onError} />
        ) : null}
        {section === 'system' ? <SystemBrainPanel onError={onError} /> : null}
      </div>
    </div>
  );
}
