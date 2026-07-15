import type { CinemaMandateRowWire } from '@amrita/protocol';
import { useCallback, useEffect, useState } from 'react';
import { client } from '../client.ts';
import { textDir } from '../lib.ts';

/**
 * Cinema module delegation (WP9, ADR-0029) — honest, bridge-gated.
 *
 * The chat/analysis verbs proxy to the external Cinema bridge (the sibling Aba
 * Adama repo) and need BRAIN_BRIDGE_TOKEN + a running bridge. This panel NEVER
 * fakes a connected state: it probes `cinema.providers` and, when the bridge is
 * absent, says exactly that. Mandates, by contrast, are a LOCAL read over this
 * daemon's own events, so they render regardless of the bridge.
 */

interface Props {
  conversationId: string;
  onError: (e: unknown) => void;
}

export function CinemaPanel({ conversationId, onError }: Props) {
  const [bridge, setBridge] = useState<'checking' | 'ready' | 'needs-setup'>('checking');
  const [mandates, setMandates] = useState<CinemaMandateRowWire[]>([]);

  const load = useCallback(async () => {
    // The bridge status is best-effort; an error is the honest needs-setup signal.
    try {
      await client.cinemaProviders();
      setBridge('ready');
    } catch {
      setBridge('needs-setup');
    }
    if (conversationId) {
      try {
        setMandates(await client.cinemaMandateList(conversationId));
      } catch (e) {
        onError(e);
      }
    }
  }, [conversationId, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="card">
      <h2>Cinema module</h2>
      <p className="hub-note">
        Amrita can delegate to the Cinema module over its bridge. Media execution stays in that
        module; here you see delegation status and the mandates Amrita has issued.
      </p>
      <p className="hub-live">
        {bridge === 'checking' ? (
          <span className="doc-badge proposed">checking…</span>
        ) : bridge === 'ready' ? (
          <span className="doc-badge approved">bridge reachable</span>
        ) : (
          <span className="doc-badge proposed">
            needs setup — set BRAIN_BRIDGE_TOKEN and start the bridge
          </span>
        )}
      </p>

      {mandates.length === 0 ? (
        <p className="empty-note">No mandates issued in this session.</p>
      ) : (
        <ul className="channel-list">
          {mandates.map((m) => (
            <li key={m.mandate.mandateId} className="channel-row">
              <div className="channel-copy">
                <strong dir={textDir(m.mandate.goal)}>{m.mandate.goal}</strong>
                <small>max risk {m.mandate.maxRisk}</small>
              </div>
              <span className={`doc-badge ${m.status === 'resolved' ? 'approved' : 'proposed'}`}>
                {m.status}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
