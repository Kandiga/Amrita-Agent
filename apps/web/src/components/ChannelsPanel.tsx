import type { ChannelStatusEntryWire, PairingRowWire } from '@amrita/protocol';
import { useCallback, useEffect, useState } from 'react';
import { client } from '../client.ts';
import type { WriteCtx } from '../lib.ts';

/**
 * Channels (WP5): Telegram / WhatsApp / web, with honest readiness.
 *
 * The daemon already computes each channel's state (web ready; telegram ready
 * only while its runner is live; whatsapp needs_setup) with the exact setup note.
 * This surfaces it read-only — no fake green — and lets the operator mint a
 * pairing code to bind an external chat to the current project, but only when the
 * channel is actually ready.
 */

interface Props {
  writeCtx: WriteCtx | null;
  onError: (e: unknown) => void;
}

export function ChannelsPanel({ writeCtx, onError }: Props) {
  const [channels, setChannels] = useState<ChannelStatusEntryWire[] | null>(null);
  const [pairings, setPairings] = useState<PairingRowWire[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [ch, pr] = await Promise.all([client.channelsList(), client.pairingList()]);
      setChannels(ch);
      setPairings(pr);
    } catch (e) {
      onError(e);
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function pair(channel: 'telegram' | 'whatsapp'): Promise<void> {
    if (!writeCtx) return;
    setBusy(true);
    try {
      await client.pairingCreate({ ...writeCtx, channel });
      await load();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Channels</h2>
      <p className="hub-note">
        Where Amrita can be reached. Each state is probed, never assumed — a channel is “ready” only
        when its runner is actually live.
      </p>
      {!channels ? (
        <p className="empty-note">Loading channels…</p>
      ) : (
        <ul className="channel-list">
          {channels.map((c) => (
            <li key={c.id} className="channel-row">
              <div className="channel-copy">
                <strong>{c.kind}</strong>
                <small>{c.note}</small>
              </div>
              <div className="channel-side">
                <span className={`doc-badge ${c.ready ? 'approved' : 'proposed'}`}>
                  {c.status === 'ready' ? 'ready' : 'needs setup'}
                </span>
                {(c.kind === 'telegram' || c.kind === 'whatsapp') && c.ready && writeCtx ? (
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy}
                    onClick={() => void pair(c.kind as 'telegram' | 'whatsapp')}
                  >
                    Pair…
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {pairings.length > 0 ? (
        <>
          <h3 className="retro-h3">Active pairings</h3>
          <ul className="channel-pairings">
            {pairings.map((p) => (
              <li key={p.code}>
                <code>{p.code}</code> · {p.channel} · {p.claimedAt ? 'claimed' : 'waiting'}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
