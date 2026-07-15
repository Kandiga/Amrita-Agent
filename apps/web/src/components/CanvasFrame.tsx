import { buildSandboxedPreview } from '../sandbox.ts';

/**
 * The Stage-B sandboxed preview frame (ADR-0020): confined HTML with an opaque
 * origin and a zero-network CSP. Resilient to oversize input — buildSandboxedPreview
 * throws over 256 KB, so a big build shows an honest note instead of throwing into
 * the error boundary and blanking the app.
 */
export function CanvasFrame({ html, title }: { html: string; title: string }) {
  let sandboxed: ReturnType<typeof buildSandboxedPreview> | null = null;
  try {
    sandboxed = buildSandboxedPreview({
      kind: 'html-preview',
      id: 'canvas',
      projectId: 'canvas',
      title,
      html,
    });
  } catch {
    sandboxed = null;
  }
  if (!sandboxed) {
    return (
      <div className="canvas-toolarge">
        This build is too large to preview inline (over 256&nbsp;KB). Ask Amrita to trim it.
      </div>
    );
  }
  return (
    <iframe
      className="canvas-frame"
      title={title}
      sandbox={sandboxed.sandbox}
      srcDoc={sandboxed.srcDoc}
    />
  );
}
