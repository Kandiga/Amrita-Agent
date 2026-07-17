/**
 * ADR-0057 hardening — the single trusted-browser-origin authority (Boni
 * finding 1). A cookie session is a BROWSER credential; it must be honored
 * only for a request that provably originates from the trusted dashboard.
 *
 * Why an explicit Origin check and not just SameSite/CORS:
 *  - SameSite=Strict shares the eTLD+1 across ALL `localhost:*` ports, so a
 *    page on http://localhost:9999 is same-site and the cookie rides along.
 *  - WebSocket upgrades have NO CORS/preflight, so a cross-origin page could
 *    open a cookie-authenticated /events/ws or terminal socket unchecked.
 *  - The `Origin` header is set by the browser and cannot be forged by page
 *    JavaScript, so it is the reliable discriminator between the real
 *    dashboard and a hostile same-site page.
 *
 * Bearer clients (CLI/programmatic) never carry a cookie or an Origin and are
 * unaffected — this gate applies ONLY to cookie authentication.
 */

/** The port deploy/serve-web.mjs uses by default; the standard local dashboard. */
const DEFAULT_WEB_PORT = 7461;

export interface BrowserTrust {
  /** Exact-match trusted origins for cookie-auth and CORS decisions. */
  readonly origins: ReadonlySet<string>;
}

function splitOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function loopbackPair(port: number): string[] {
  return [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
}

/**
 * Build the COOKIE-session trusted-origin set from server-owned inputs only.
 *
 * SEC5-2: this is DISTINCT from the CORS allowlist. `AMRITA_ALLOWED_ORIGINS`
 * authorizes CORS for browser BEARER clients (e.g. a Cinema SPA on another
 * origin, see `corsAllowedOrigin`) and must NEVER silently grant cookie-session
 * authority — a bearer client holds its own secret and does not need a cookie.
 * Cookie trust comes only from:
 *  - `AMRITA_WEB_ORIGINS` — the dashboard origin(s), set by `amrita open` / the
 *    systemd unit for the real web port;
 *  - if that is unset, the standard local dashboard port ONLY (7461 on
 *    loopback) — never "any localhost port";
 *  - the daemon's own bound origin (direct dev access without the proxy).
 */
export function resolveBrowserTrust(opts: {
  env?: NodeJS.ProcessEnv;
  selfPort?: number;
}): BrowserTrust {
  const env = opts.env ?? process.env;
  const origins = new Set<string>();

  const web = splitOrigins(env.AMRITA_WEB_ORIGINS);
  if (web.length > 0) {
    for (const o of web) origins.add(o);
  } else {
    for (const o of loopbackPair(DEFAULT_WEB_PORT)) origins.add(o);
  }
  if (opts.selfPort && opts.selfPort > 0) {
    for (const o of loopbackPair(opts.selfPort)) origins.add(o);
  }
  return { origins };
}

/** Thrown at startup when the TLS/origin configuration cannot work (SEC5-3). */
export class WebSecurityConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebSecurityConfigError';
  }
}

/**
 * SEC5-3: fail closed on an incoherent TLS/origin configuration at STARTUP, so
 * the daemon never runs a mode where the Secure cookie can never be delivered.
 * TLS is decided by the SERVER (`AMRITA_WEB_TLS`), NEVER inferred from a
 * client-forgeable `X-Forwarded-Proto`. Throws `WebSecurityConfigError` with the
 * exact remediation; returns void on a valid config.
 */
export function validateWebSecurityConfig(env: NodeJS.ProcessEnv = process.env): void {
  const web = splitOrigins(env.AMRITA_WEB_ORIGINS);
  const tls = /^(1|true|yes|on)$/i.test((env.AMRITA_WEB_TLS ?? '').trim());
  const httpsOrigins = web.filter((o) => o.toLowerCase().startsWith('https://'));
  const httpOrigins = web.filter((o) => o.toLowerCase().startsWith('http://'));

  if (httpsOrigins.length > 0 && !tls) {
    throw new WebSecurityConfigError(
      `AMRITA_WEB_ORIGINS declares an HTTPS dashboard (${httpsOrigins.join(', ')}) but AMRITA_WEB_TLS is not enabled — the session cookie would not be issued Secure over TLS. Fix: set AMRITA_WEB_TLS=1 (TLS terminates in front of the daemon), or use an http:// origin for a local HTTP dashboard.`,
    );
  }
  if (tls && web.length > 0 && httpsOrigins.length === 0) {
    throw new WebSecurityConfigError(
      `AMRITA_WEB_TLS is set but AMRITA_WEB_ORIGINS has only http:// origins (${httpOrigins.join(', ')}) — a Secure cookie is never sent over http, so the browser could never authenticate. Fix: declare the https:// dashboard origin in AMRITA_WEB_ORIGINS, or unset AMRITA_WEB_TLS for a local HTTP dashboard.`,
    );
  }
}

/** Exact-match: is this browser origin one the daemon trusts? */
export function isTrustedBrowserOrigin(origin: string | undefined, trust: BrowserTrust): boolean {
  return typeof origin === 'string' && origin.length > 0 && trust.origins.has(origin);
}

/**
 * The gate applied to a COOKIE-authenticated action. `method` is the HTTP verb,
 * or the sentinel `'WS'` for a WebSocket upgrade.
 *
 *  - Mutations (non-GET) and WS upgrades REQUIRE a present, trusted Origin — a
 *    real browser always stamps Origin on a POST and on every WS handshake, so
 *    a missing Origin on these is anomalous and refused (fail closed).
 *  - Reads (GET/HEAD) tolerate a MISSING Origin (a same-origin GET may omit it)
 *    but still reject a present-but-untrusted one.
 */
export function cookieOriginAllowed(
  origin: string | undefined,
  method: string,
  trust: BrowserTrust,
): boolean {
  const isRead = method === 'GET' || method === 'HEAD';
  if (isRead && (origin === undefined || origin === '')) return true;
  return isTrustedBrowserOrigin(origin, trust);
}
