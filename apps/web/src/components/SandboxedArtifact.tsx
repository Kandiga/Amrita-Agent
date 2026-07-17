import { useEffect, useRef, useState } from 'react';
import { client } from '../client.ts';
import {
  MAX_PREVIEW_BYTES,
  PREVIEW_SANDBOX,
  artifactPreviewPath,
  previewByteLength,
} from '../sandbox.ts';

/**
 * ADR-0057 finding 3: render untrusted generated HTML in a sandboxed iframe
 * loaded from the daemon's self-CSP'd `/artifact` route — NOT `srcdoc` (which
 * would inherit the app CSP and force it to allow inline scripts). The HTML is
 * POSTed to the daemon for a ticket URL; the iframe (opaque origin, no
 * same-origin) then loads it. The served document's own `connect-src 'none'`
 * CSP means the preview can render but cannot call `/rpc` or open a WebSocket.
 *
 * Streaming: the HTML grows live, so the PUT is debounced (trailing) to bound
 * round-trips; the previous frame stays painted until the next document loads,
 * so a live build still updates smoothly. Honest tradeoff vs. the old instant
 * srcdoc: a small per-update round-trip, bought for a strict app CSP.
 */
const DEBOUNCE_MS = 250;

export function SandboxedArtifact({
  html,
  title,
  className = 'canvas-frame',
}: {
  html: string;
  title: string;
  className?: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [tooBig, setTooBig] = useState(false);
  const [failed, setFailed] = useState(false);
  // The newest HTML we've been asked to render; a late PUT for stale HTML is dropped.
  const latest = useRef(html);
  latest.current = html;

  useEffect(() => {
    if (previewByteLength(html) > MAX_PREVIEW_BYTES) {
      setTooBig(true);
      return;
    }
    setTooBig(false);
    let cancelled = false;
    const timer = setTimeout(() => {
      const forHtml = html;
      client
        .call<{ id: string; ticket: string }>('artifact.preview.put', { html: forHtml })
        .then((ref) => {
          // Drop this result if newer HTML arrived while the PUT was in flight.
          if (cancelled || latest.current !== forHtml) return;
          setFailed(false);
          setSrc(artifactPreviewPath(ref.id, ref.ticket));
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [html]);

  if (tooBig) {
    return (
      <div className="canvas-toolarge">
        This build is too large to preview inline (over 256&nbsp;KB). Ask Amrita to trim it.
      </div>
    );
  }
  if (failed && src === null) {
    return <div className="canvas-wait">Could not open the preview — reload to retry.</div>;
  }
  if (src === null) {
    return <div className="canvas-wait">Rendering a sandboxed preview…</div>;
  }
  return <iframe className={className} title={title} sandbox={PREVIEW_SANDBOX} src={src} />;
}
