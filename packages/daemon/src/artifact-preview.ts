import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * ADR-0057 finding 3 — artifact previews isolated from the authenticated app.
 *
 * Generated HTML previews (ADR-0020) used to render as `srcdoc` iframes, which
 * INHERIT the parent app's CSP — forcing the app to keep `script-src
 * 'unsafe-inline'` so the preview's inline scripts could run. That weakened the
 * whole app: an injected inline script would run with the app's same-origin
 * authority.
 *
 * The fix is to serve each preview as a REAL fetched document with its OWN CSP
 * response header (no inheritance), inside a `sandbox="allow-scripts"` iframe
 * (opaque origin — no cookie, no parent DOM, no bearer). The preview's own CSP
 * has `connect-src 'none'`, so it cannot call `/rpc`, open a WebSocket, or reach
 * ANY network — proven in a real browser. The app CSP can then be strict.
 *
 * The store is in-memory, size-bounded, TTL-expiring, and LRU-capped (a live
 * stream re-puts the growing HTML many times). A per-id CSPRNG ticket is the
 * only key — worthless on any other route, exactly like the workspace ticket.
 */

/** Matches the web-side MAX_PREVIEW_BYTES; bigger builds spill to lane files. */
export const MAX_ARTIFACT_BYTES = 256 * 1024;
const ARTIFACT_TTL_MS = 30 * 60 * 1000;
const MAX_ARTIFACTS = 128;

/**
 * The CSP served WITH each artifact document. It is authoritative (a real
 * response, not srcdoc) so it does not depend on the app policy. `default-src
 * 'none'` + explicit `connect-src 'none'` means zero network reach; inline
 * script/style are allowed so the preview renders; it may only be framed by the
 * app (`frame-ancestors 'self'`).
 */
export const ARTIFACT_PREVIEW_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; " +
  "form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

export interface StoredArtifactRef {
  id: string;
  ticket: string;
  expiresAt: string;
}

interface Entry {
  html: string;
  ticket: string;
  expiresAt: number;
}

export class ArtifactPreviewStore {
  private readonly items = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly genId: () => string;
  private readonly genTicket: () => string;

  constructor(opts?: {
    ttlMs?: number;
    maxEntries?: number;
    genId?: () => string;
    genTicket?: () => string;
  }) {
    this.ttlMs = opts?.ttlMs ?? ARTIFACT_TTL_MS;
    this.maxEntries = opts?.maxEntries ?? MAX_ARTIFACTS;
    this.genId = opts?.genId ?? (() => randomBytes(12).toString('hex'));
    this.genTicket = opts?.genTicket ?? (() => randomBytes(24).toString('base64url'));
  }

  /** Store one preview; returns its id + ticket, or throws on oversize input. */
  put(html: string, now: number): StoredArtifactRef {
    const bytes = Buffer.byteLength(html, 'utf8');
    if (bytes > MAX_ARTIFACT_BYTES) {
      throw new Error(`artifact preview is ${bytes} bytes (limit ${MAX_ARTIFACT_BYTES})`);
    }
    this.prune(now);
    // LRU cap: a live stream re-puts many times — evict the oldest by insertion
    // order (Map preserves it) so memory stays bounded.
    while (this.items.size >= this.maxEntries) {
      const oldest = this.items.keys().next().value;
      if (oldest === undefined) break;
      this.items.delete(oldest);
    }
    const id = this.genId();
    const ticket = this.genTicket();
    this.items.set(id, { html, ticket, expiresAt: now + this.ttlMs });
    return { id, ticket, expiresAt: new Date(now + this.ttlMs).toISOString() };
  }

  /** Read a preview by id + constant-time ticket check; null on any mismatch/expiry. */
  read(id: string, ticket: string, now: number): string | null {
    const entry = this.items.get(id);
    if (!entry || now > entry.expiresAt) return null;
    const a = Buffer.from(entry.ticket);
    const b = Buffer.from(ticket);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return entry.html;
  }

  size(now: number): number {
    this.prune(now);
    return this.items.size;
  }

  private prune(now: number): void {
    for (const [id, e] of this.items) if (now > e.expiresAt) this.items.delete(id);
  }
}
