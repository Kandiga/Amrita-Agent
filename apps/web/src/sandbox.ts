/**
 * Surface Stage-B security harness (docs/strategy/native-interactive-surface.md
 * §2.3, ADR-0019). This module ships BEFORE any generated-HTML preview UI does:
 * it fixes the sandbox contract so rich previews can only ever land inside it.
 *
 * Boundaries, non-negotiable:
 * - `sandbox` NEVER includes `allow-same-origin` — the preview document gets a
 *   unique opaque origin and can never read the parent's localStorage, cookies,
 *   or the daemon bearer token.
 * - A strict CSP is injected into the document itself: no network fetches, no
 *   external scripts, no frames, no forms.
 * - Previews are size-bounded; oversized HTML must go through the artifact
 *   spill path (D9), never inline.
 * - The sandbox boundary is the security model — the harness does NOT claim to
 *   sanitize the HTML (no false confidence), it confines it.
 *
 * No UI renders these yet; that lands with the Stage-B slice once an approval
 * flow exists. Shipping the harness first means the unsafe shortcut never has
 * a reason to exist.
 */

/** iframe sandbox attribute for previews. `allow-same-origin` is forbidden. */
export const PREVIEW_SANDBOX = 'allow-scripts';

/** CSP injected into every preview document: inline-only, zero network reach. */
export const PREVIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'unsafe-inline'; frame-src 'none'; form-action 'none'; base-uri 'none'";

/** Inline preview budget — bigger payloads must spill to artifact files (D9). */
export const MAX_PREVIEW_BYTES = 256 * 1024;

export interface HtmlPreviewSpec {
  kind: 'html-preview';
  id: string;
  projectId: string;
  title: string;
  /** Untrusted generated HTML. Confined by the sandbox, not trusted. */
  html: string;
}

export interface SandboxedPreview {
  /** Value for the iframe `sandbox` attribute. */
  sandbox: typeof PREVIEW_SANDBOX;
  /** Full srcdoc document with the CSP baked into <head>. */
  srcDoc: string;
}

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

/**
 * Wrap untrusted HTML into a confined srcdoc document. Throws on oversize
 * input (spill instead) — never truncates silently.
 */
export function buildSandboxedPreview(spec: HtmlPreviewSpec): SandboxedPreview {
  const bytes = new TextEncoder().encode(spec.html).length;
  if (bytes > MAX_PREVIEW_BYTES) {
    throw new Error(
      `preview html is ${bytes} bytes (limit ${MAX_PREVIEW_BYTES}); spill it to an artifact file instead`,
    );
  }
  assertSafeSandbox(PREVIEW_SANDBOX);
  const srcDoc = [
    '<!doctype html>',
    '<html>',
    '<head>',
    `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`,
    '<meta charset="utf-8">',
    '</head>',
    `<body>${spec.html}</body>`,
    '</html>',
  ].join('');
  return { sandbox: PREVIEW_SANDBOX, srcDoc };
}
