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
5. **Hardening headers everywhere** (daemon responses + serve-web static). The
   app CSP is **STRICT** — `script-src 'self'` with **no `'unsafe-inline'`**:
   `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
   img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self';
   frame-src 'self' blob:; object-src 'none'; base-uri 'none';
   form-action 'self'; frame-ancestors 'self'` (+ `X-Content-Type-Options`,
   `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`).

## Hardening review (Boni, 2026-07-17) — findings 1–3

1. **Cross-site cookie use is blocked by an Origin authority** (`browser-origin.ts`).
   A cookie is a browser credential, so it is honored only when the browser-set
   (unforgeable) `Origin` is present and trusted. `SameSite=Strict` shares the
   eTLD+1 across every `localhost:PORT`, and a WS upgrade has no CORS/preflight —
   so without this a page on `http://localhost:9999` could open a
   cookie-authenticated `/events/ws` or terminal socket. Cookie trust (SEC5-2) =
   `AMRITA_WEB_ORIGINS` / the standard dashboard port default / the daemon's own
   bound origin — **NOT** `AMRITA_ALLOWED_ORIGINS`, which authorizes CORS for
   BEARER clients (e.g. Cinema) and must never silently grant cookie authority.
   The default is the standard dashboard port only, never "any localhost port".
   Bearer clients carry no Origin and are unaffected. The same authority gates
   cookie-authenticated HTTP mutations AND (SEC5-1) the browser session-lifecycle
   routes `POST /pair` and `POST /session/logout`: a trusted Origin + a JSON
   content-type is required (checked before the code is touched or the session
   revoked), so a hostile same-site page cannot spend a pairing code or force a
   logout/re-pair.
2. **`Secure` + `__Host-` under TLS, server-owned.** The cookie's security is
   `AMRITA_WEB_TLS`, resolved from server env — NEVER from a client-forgeable
   `X-Forwarded-Proto`. TLS mode issues `__Host-amrita_session` with `Secure`
   (Path=/, no Domain), pinning it to the exact host. **Deployment:** a TLS
   dashboard MUST set `AMRITA_WEB_TLS=1` (documented in `deploy/amritad.service`);
   local HTTP is the fail-closed default. SEC5-3/SEC5b: the daemon **refuses to
   start** on an incoherent config (`validateWebSecurityConfig`) — with the exact
   remediation, so a Secure cookie is never issued where the browser can never
   receive it, and a trusted origin can never fail to match a browser `Origin`.
   The rules: every `AMRITA_WEB_ORIGINS` entry must be an EXACT
   `scheme://host[:port]` origin (no path/query/fragment/credentials/trailing
   slash/default port); with `AMRITA_WEB_TLS=1`, `AMRITA_WEB_ORIGINS` is
   MANDATORY and every entry must be `https://` (no http/mixed, no loopback
   fallback); without TLS, no `https://` origin is allowed.
3. **Strict app CSP + artifact previews isolated from app authority.** Earlier
   this ADR claimed `connect-src 'self'` "closes the exfiltration channel" while
   the app kept `script-src 'unsafe-inline'`. That was **wrong**: `connect-src
   'self'` still permits a same-origin call, so an inline script injected into the
   app could invoke privileged `/rpc`/WS with the cookie. Corrected: the app CSP
   is strict (Vite emits only external module scripts, so nothing inline is
   needed), and generated HTML previews are no longer `srcdoc` (which INHERITS the
   app CSP — verified in a real browser: a strict parent blocks srcdoc inline
   scripts). They are POSTed to `artifact.preview.put` and served from the
   dedicated `GET /artifact/<id>/t/<ticket>` route with their OWN CSP
   (`default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'; …`)
   inside a `sandbox="allow-scripts"` iframe (opaque origin). Proven in-browser:
   the preview's inline script runs, but its `fetch('/rpc')` is blocked and it can
   read no parent state or cookie. `style-src 'unsafe-inline'` stays (React inline
   styles cannot call an API).

## Honest tradeoffs

- The artifact route adds a small per-update round-trip vs. the old instant
  `srcdoc` (the live "watch it build" preview refreshes on a ~250ms debounce
  instead of every keystroke of the stream). Bought in exchange for a strict app
  CSP. The store is in-memory, size-bounded (256 KB), TTL-expiring, and LRU-capped.
- The pairing code appears on the operator's terminal once. It is not the durable
  credential: 120 seconds, one use, worthless after consumption. This is the same
  exposure class as `codex --device-auth`.
- Sessions are in-memory by design (no new persistence, nothing secret-shaped in
  the store — ADR-0024 posture). Restart cost = one re-pair.

## Reversibility

Additive HTTP routes + additive RPC methods; the bearer path is untouched, so
reverting the SPA to header auth is a web-only change. No store migration.
