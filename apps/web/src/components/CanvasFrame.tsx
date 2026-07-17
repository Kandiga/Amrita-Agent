import { SandboxedArtifact } from './SandboxedArtifact.tsx';

/**
 * The Stage-B sandboxed preview frame (ADR-0020, hardened by ADR-0057
 * finding 3): confined generated HTML with an opaque origin and a zero-network
 * CSP, served from the dedicated `/artifact` route (never srcdoc), so the app
 * document keeps a STRICT CSP. Oversize/failed input degrades to an honest note
 * inside SandboxedArtifact instead of blanking the app.
 */
export function CanvasFrame({ html, title }: { html: string; title: string }) {
  return <SandboxedArtifact html={html} title={title} className="canvas-frame" />;
}
