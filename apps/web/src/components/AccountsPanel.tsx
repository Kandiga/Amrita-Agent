import type { AccountRowWire } from '@amrita/protocol';
import { useCallback, useEffect, useState } from 'react';
import { client } from '../client.ts';
import type { WriteCtx } from '../lib.ts';

/**
 * Provider accounts + local endpoint (WP9).
 *
 * Provider setup used to be CLI-only. This lets the operator register an account
 * and point it at the ENV VAR **NAME** that holds its key — the name, never the
 * value. Secrets never enter the store, an event, or this request; the DB holds
 * env-var names and redacted status booleans only (project rule).
 */

const AUTH_MODES = ['api_key', 'subscription_cli', 'local_endpoint', 'oauth'] as const;

interface Props {
  writeCtx: WriteCtx | null;
  onError: (e: unknown) => void;
}

export function AccountsPanel({ writeCtx, onError }: Props) {
  const [accounts, setAccounts] = useState<AccountRowWire[]>([]);
  const [provider, setProvider] = useState('');
  const [authMode, setAuthMode] = useState<(typeof AUTH_MODES)[number]>('api_key');
  const [label, setLabel] = useState('');
  const [envDraft, setEnvDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  // local endpoint
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [keyEnv, setKeyEnv] = useState('');
  const [probeNote, setProbeNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setAccounts(await client.accountsList());
    } catch (e) {
      onError(e);
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function connect(): Promise<void> {
    if (!writeCtx || !provider.trim()) return;
    setBusy(true);
    try {
      await client.accountsConnect({
        ...writeCtx,
        provider: provider.trim(),
        authMode,
        ...(label.trim() ? { label: label.trim() } : {}),
      });
      setProvider('');
      setLabel('');
      await load();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function bindEnv(accountId: string): Promise<void> {
    const envName = (envDraft[accountId] ?? '').trim();
    if (!envName) return;
    setBusy(true);
    try {
      await client.accountBindSecretRef({ accountId, envName });
      setEnvDraft((d) => ({ ...d, [accountId]: '' }));
      await load();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function probeLocal(): Promise<void> {
    if (!writeCtx || !baseUrl.trim()) return;
    setBusy(true);
    setProbeNote(null);
    try {
      const res = await client.probeEndpoint({
        baseUrl: baseUrl.trim(),
        ...(keyEnv.trim() ? { keyEnv: keyEnv.trim() } : {}),
      });
      if (!res.ok) {
        setProbeNote(`Could not reach it: ${res.detail}`);
        return;
      }
      const chosenModel = model.trim() || res.models[0] || '';
      if (!chosenModel) {
        setProbeNote('Reached it, but it reported no models — enter one to save.');
        return;
      }
      await client.settingUpdate({
        ...writeCtx,
        key: 'providers.endpoint.local',
        value: {
          baseUrl: baseUrl.trim(),
          model: chosenModel,
          ...(keyEnv.trim() ? { keyEnv: keyEnv.trim() } : {}),
        },
      });
      setProbeNote(`Saved. ${res.models.length} model(s) discovered; using ${chosenModel}.`);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Accounts &amp; endpoints</h2>
      <p className="hub-note">
        Register a provider account and point it at the environment variable that holds its key. The
        variable NAME is stored — never the secret itself.
      </p>

      <ul className="channel-list">
        {accounts.length === 0 ? (
          <li className="empty-note">No accounts yet.</li>
        ) : (
          accounts.map((a) => (
            <li key={a.id} className="channel-row">
              <div className="channel-copy">
                <strong>
                  {a.provider}
                  {a.label ? ` · ${a.label}` : ''}
                </strong>
                <small>
                  {a.authMode} · {a.secretRef ? `bound to ${a.secretRef}` : 'no secret ref'}
                </small>
              </div>
              <div className="channel-side">
                <input
                  value={envDraft[a.id] ?? ''}
                  onChange={(e) => setEnvDraft((d) => ({ ...d, [a.id]: e.target.value }))}
                  placeholder="ENV_VAR_NAME"
                  aria-label={`Env var name for ${a.provider}`}
                  disabled={busy}
                />
                <button
                  type="button"
                  className="ghost"
                  disabled={busy || !(envDraft[a.id] ?? '').trim()}
                  onClick={() => void bindEnv(a.id)}
                >
                  Bind
                </button>
              </div>
            </li>
          ))
        )}
      </ul>

      <form
        className="search"
        onSubmit={(e) => {
          e.preventDefault();
          void connect();
        }}
      >
        <input
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          placeholder="provider (e.g. anthropic)"
          disabled={!writeCtx || busy}
        />
        <select
          value={authMode}
          onChange={(e) => setAuthMode(e.target.value as (typeof AUTH_MODES)[number])}
          disabled={!writeCtx || busy}
        >
          {AUTH_MODES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="label (optional)"
          disabled={!writeCtx || busy}
        />
        <button type="submit" disabled={!writeCtx || busy || !provider.trim()}>
          Add account
        </button>
      </form>

      <h3 className="retro-h3">Local / custom endpoint</h3>
      <p className="hub-note">An OpenAI-compatible base URL. Probed before it is saved.</p>
      <form
        className="search"
        onSubmit={(e) => {
          e.preventDefault();
          void probeLocal();
        }}
      >
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="http://127.0.0.1:1234/v1"
          disabled={!writeCtx || busy}
        />
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="model (optional)"
          disabled={!writeCtx || busy}
        />
        <input
          value={keyEnv}
          onChange={(e) => setKeyEnv(e.target.value)}
          placeholder="KEY_ENV_NAME (optional)"
          disabled={!writeCtx || busy}
        />
        <button type="submit" disabled={!writeCtx || busy || !baseUrl.trim()}>
          {busy ? 'Probing…' : 'Probe & save'}
        </button>
      </form>
      {probeNote ? <p className="review-raised">{probeNote}</p> : null}
    </section>
  );
}
