import { useState } from 'react';
import { pairWithCode } from '../auth.ts';

/**
 * ADR-0057: the full-screen pairing gate. Shown when the server says this
 * browser has no session. The user runs `amrita open` in a terminal, reads the
 * single-use code it prints, and types it here; the server answers with an
 * HttpOnly cookie this page can never read. No credential ever enters the DOM.
 */
export function PairingGate({ hadLegacyToken }: { hadLegacyToken: boolean }) {
  const [code, setCode] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'rejected' | 'rate_limited' | 'error'>(
    'idle',
  );

  async function submit(): Promise<void> {
    if (!code.trim() || state === 'busy') return;
    setState('busy');
    const r = await pairWithCode(code);
    if (r === 'paired') {
      window.location.reload(); // clean boot with the cookie in place
      return;
    }
    setState(r);
  }

  return (
    <main className="pairing-gate">
      <section className="card pairing-card">
        <h1>Amrita</h1>
        <h2>Pair this browser</h2>
        <p>
          Run <code>amrita open</code> in a terminal and type the pairing code it prints. Codes are
          single-use and expire after 2 minutes.
        </p>
        {hadLegacyToken ? (
          <p className="pairing-note">
            This browser held a legacy access token — it has been removed. Pairing replaces it with
            a secure cookie session.
          </p>
        ) : null}
        <form
          className="pairing-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="XXXX-XXXX"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            aria-label="Pairing code"
          />
          <button type="submit" disabled={!code.trim() || state === 'busy'}>
            {state === 'busy' ? 'Pairing…' : 'Pair'}
          </button>
        </form>
        {state === 'rejected' ? (
          <p className="pairing-error" role="alert">
            That code was not accepted — it may have expired or been used. Run `amrita open` for a
            fresh one.
          </p>
        ) : null}
        {state === 'rate_limited' ? (
          <p className="pairing-error" role="alert">
            Too many attempts — wait a minute, then run `amrita open` for a fresh code.
          </p>
        ) : null}
        {state === 'error' ? (
          <p className="pairing-error" role="alert">
            Could not reach the daemon — is it running? Try `amrita open` or `amrita doctor`.
          </p>
        ) : null}
      </section>
    </main>
  );
}
