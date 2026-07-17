/**
 * Surface Stage-B security harness (ADR-0019/0020, hardened by ADR-0057
 * finding 3). Generated HTML previews are UNTRUSTED. They are confined, never
 * trusted, and — since ADR-0057 finding 3 — served from the daemon's dedicated
 * `/artifact/<id>/t/<ticket>` route with their OWN CSP, loaded here in a
 * `sandbox="allow-scripts"` iframe.
 *
 * Boundaries, non-negotiable:
 * - `sandbox` NEVER includes `allow-same-origin` — the preview document gets a
 *   unique opaque origin and can never read the parent's DOM, cookies, or the
 *   session; nor can it be scripted by the parent.
 * - The preview is a REAL fetched document (not `srcdoc`), so it does NOT
 *   inherit the app's CSP. The app CSP is strict (`script-src 'self'`); the
 *   preview's own served CSP (`connect-src 'none'`) lets its inline scripts
 *   render but blocks ALL network — it cannot call `/rpc` or open a WebSocket.
 * - Previews are size-bounded; oversized HTML must spill to a lane file.
 * - The sandbox boundary is the security model — this does NOT sanitize the
 *   HTML (no false confidence), it confines it.
 */

/** iframe sandbox attribute for previews. `allow-same-origin` is forbidden. */
export const PREVIEW_SANDBOX = 'allow-scripts';

/** Inline preview budget — bigger payloads must spill to artifact files (D9). */
export const MAX_PREVIEW_BYTES = 256 * 1024;

/** Reject any sandbox attribute that would give the preview a real origin. */
export function assertSafeSandbox(attrs: string): void {
  const tokens = attrs.split(/\s+/).filter(Boolean);
  if (tokens.includes('allow-same-origin')) {
    throw new Error('preview sandbox must never include allow-same-origin');
  }
  if (tokens.includes('allow-top-navigation')) {
    throw new Error('preview sandbox must never allow top navigation');
  }
}

/** Byte length of the HTML (the same limit the daemon enforces). */
export function previewByteLength(html: string): number {
  return new TextEncoder().encode(html).length;
}

/**
 * The same-origin path the sandboxed iframe loads. The ticket is the only
 * credential and is worthless on any other route; the app never puts a bearer
 * or the session in a URL. Ids/tickets come from the daemon (CSPRNG) — encode
 * defensively even so.
 */
export function artifactPreviewPath(id: string, ticket: string): string {
  return `/artifact/${encodeURIComponent(id)}/t/${encodeURIComponent(ticket)}`;
}
