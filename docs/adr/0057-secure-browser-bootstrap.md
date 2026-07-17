# ADR-0057 — Secure browser bootstrap: pairing + HttpOnly session; minimal public health; loopback + hardening headers

**Status:** accepted · 2026-07-17
**Findings:** community-onboarding QA 2026-07-17, findings 3 (bearer in URL fragment /
localStorage / stdout), 10 (web binds 0.0.0.0; `/health` leaks DB path, counts, lane
posture unauthenticated), 11 (no CSP / XCTO / Referrer-Policy / frame / COOP headers).

## Decision

1. **The daemon bearer never reaches the browser.** `AMRITA_AUTH_TOKEN` stays a
   server-side credential for CLI/programmatic RPC (`Authorization: Bearer`) only.
   The `#token=` URL-fragment handoff and the SPA's localStorage persistence are
   **removed** — `readTokenFromHash` now always rejects, and the web client never
   stores or sends a bearer.
2. **Browsers authenticate with an HttpOnly cookie session, bootstrapped by a
   pairing code** (the device-auth pattern this repo already endorses for Codex):
   - `auth.pair.mint` (RPC, bearer-gated — so only the local CLI/operator can mint)
     returns a CSPRNG code, **single-use, 120s TTL, atomic consume**, displayed in
     the terminal by `amrita open` for the user to TYPE into the UI. It is never
     placed in a URL, argv, log line, event, or browser storage.
   - `POST /pair {code}` (public, rate-limited 5/min/IP) consumes the code and sets
     `amrita_session=<192-bit CSPRNG>; HttpOnly; SameSite=Strict; Path=/`
     (+`Secure` behind TLS). Sessions live in daemon memory with a 7-day sliding
     expiry — a daemon restart simply requires re-pairing.
   - `GET /session` → `204` when the cookie is valid, `401` otherwise (the SPA's
     only auth probe). `POST /session/logout` clears it.
   - The auth guard accepts **bearer OR session cookie**. Cookie-authenticated
     mutating requests additionally require `content-type: application/json`
     (belt-and-braces CSRF on top of SameSite=Strict). WebSocket upgrades are
     cookie-authenticated same-origin; `?token=` stays for bearer callers only.
3. **Public `/health` is minimal:** unauthenticated → `{ok:true, name:'amritad'}`.
   The full `kernelHealthSchema` payload (dbPath, schema version, counts, lane
   posture) requires auth. Liveness probes (systemd `ExecStartPost`, `amrita open`
   readiness) only ever check the status code.
4. **The web server binds loopback by default.** `deploy/serve-web.mjs` gains
   `--host` / `AMRITA_WEB_HOST` (default `127.0.0.1`; the daemon already defaults
   to loopback). Exposing beyond loopback is an explicit operator decision.
5. **Hardening headers everywhere** (daemon responses + serve-web static):
   `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
   `Cross-Origin-Opener-Policy: same-origin`, and a CSP:
   `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self'
   'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:;
   connect-src 'self'; frame-src 'self' blob:; object-src 'none';
   base-uri 'none'; form-action 'self'; frame-ancestors 'self'`.

## Honest tradeoffs

- `script-src 'unsafe-inline'` is REQUIRED because ADR-0020 artifact previews are
  `srcdoc` iframes whose inline scripts inherit the parent document's CSP; a strict
  nonce policy would break the canvas. The credential is HttpOnly (XSS cannot read
  it) and `connect-src 'self'` closes the exfiltration channel, which is the real
  risk CSP mitigates here. Migrating artifacts to a dedicated route with a
  per-response CSP (enabling a strict app policy) is future work.
- The pairing code appears on the operator's terminal once. It is not the durable
  credential: 120 seconds, one use, worthless after consumption. This is the same
  exposure class as `codex --device-auth`.
- Sessions are in-memory by design (no new persistence, nothing secret-shaped in
  the store — ADR-0024 posture). Restart cost = one re-pair.

## Reversibility

Additive HTTP routes + one additive RPC method; the bearer path is untouched, so
reverting the SPA to header auth is a web-only change. No store migration.
