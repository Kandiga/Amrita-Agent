import { useEffect, useState } from 'react';
import { client } from '../client.ts';
import type { WriteCtx } from '../lib.ts';

/**
 * Preferences (WP5): the daemon-read behaviour flags that had no UI.
 *
 * Each is a **default-ON kill switch** — the daemon treats only an explicit
 * `false` as off, so an unset key means the feature is active. The toggle
 * therefore shows "on" unless the stored value is exactly `false`, and writing
 * `false`/`true` is the only thing that changes behaviour.
 */

interface Toggle {
  key: string;
  label: string;
  hint: string;
}

const TOGGLES: Toggle[] = [
  {
    key: 'context.pack.enabled',
    label: 'Project-aware chat',
    hint: 'Inject the brief, tasks, risks and open questions into every chat turn. Off = transcript only.',
  },
  {
    key: 'scribe.enabled',
    label: 'Scribe auto-capture',
    hint: 'After a turn, propose typed Inbox items (task/decision/risk/…) from what was agreed. Off = no proposals.',
  },
  {
    key: 'scribe.autoOpenQuestions',
    label: 'Auto-open questions',
    hint: 'Let the Scribe open an inert question directly (≤3/turn) so the interview flows. Off = questions queue to the Inbox.',
  },
];

interface Props {
  writeCtx: WriteCtx | null;
  onError: (e: unknown) => void;
}

export function PreferencesPanel({ writeCtx, onError }: Props) {
  // undefined = not loaded yet; a boolean is the resolved on/off state.
  const [state, setState] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const entries = await Promise.all(
        TOGGLES.map(async (t) => {
          try {
            const { value } = await client.settingGet(t.key);
            return [t.key, value !== false] as const; // unset/true ⇒ on
          } catch {
            return [t.key, true] as const; // default-on
          }
        }),
      );
      if (live) setState(Object.fromEntries(entries));
    })();
    return () => {
      live = false;
    };
  }, []);

  async function toggle(key: string): Promise<void> {
    if (!writeCtx) return;
    const next = !(state[key] ?? true);
    setBusy(key);
    try {
      await client.settingUpdate({ ...writeCtx, key, value: next });
      setState((s) => ({ ...s, [key]: next }));
    } catch (e) {
      onError(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card">
      <h2>Preferences</h2>
      <p className="hub-note">
        How Amrita behaves during a turn. These take effect immediately; nothing here holds a
        secret.
      </p>
      {!writeCtx ? (
        <p className="empty-note">
          Open a project to change these — they are written as project events.
        </p>
      ) : null}
      <ul className="pref-list">
        {TOGGLES.map((t) => {
          const on = state[t.key] ?? true;
          return (
            <li key={t.key} className="pref-row">
              <div className="pref-copy">
                <strong>{t.label}</strong>
                <small>{t.hint}</small>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={t.label}
                className={`pref-switch${on ? ' on' : ''}`}
                disabled={!writeCtx || busy === t.key}
                onClick={() => void toggle(t.key)}
              >
                <span className="pref-knob" />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
