import type { ChatMessage } from './lib.ts';
import { type HtmlPreviewArtifact, contentHash } from './surface.ts';

/**
 * Turn HTML the AGENT writes in chat into a live canvas artifact (CANVAS-1).
 *
 * Root cause of "she couldn't show it on the canvas": the canvas only ever
 * rendered artifacts DERIVED from typed project state (brief/brand/tasks/lanes).
 * A chat reply that contains a full HTML page or game had no path onto the
 * canvas at all, so Amrita fell back to serving files with `python -m http.server`.
 * This extractor closes that gap: any complete HTML the agent produces becomes an
 * `html-preview` artifact and lands on the canvas — "ask for something and watch
 * it land" — rendered ONLY inside the zero-network sandbox (the security model is
 * the sandbox, not trust in the HTML).
 */

// A fenced ```html … ``` block. Tolerant of an optional language line and CRLF.
const HTML_FENCE = /```html\r?\n?([\s\S]*?)```/gi;

function looksLikeHtmlDoc(text: string): boolean {
  return /<!doctype html>|<html[\s>]/i.test(text);
}

function titleFrom(html: string): string {
  const t = html.match(/<title>([^<]{1,80})<\/title>/i)?.[1]?.trim();
  if (t) return t;
  const h1 = html.match(/<h1[^>]*>([^<]{1,80})<\/h1>/i)?.[1]?.trim();
  return h1 || 'Live build';
}

export interface StreamingArtifact {
  id: string;
  title: string;
  html: string;
  building: true;
}

/**
 * The build IN PROGRESS (Live Canvas Phase 2). While Amrita is still streaming her
 * reply, `draft` holds the partial text. This pulls the partial HTML out of an
 * OPEN (not-yet-closed) ```html block and returns it as a "building" artifact so
 * the operator watches the structure/layers appear live — before she finishes.
 *
 * Scripts are STRIPPED during streaming: a half-written <script> would break
 * parsing, and running a game's init on a partial DOM would just error. So the
 * live preview shows the structure/styles building up; the completed message then
 * yields the full INTERACTIVE artifact (extractAgentArtifacts). Returns null once
 * the block closes (the committed message takes over) or before there is anything.
 */
export function extractStreamingArtifact(
  draft: string | null | undefined,
): StreamingArtifact | null {
  if (!draft) return null;
  const open = draft.match(/```html\r?\n?/i);
  if (!open || open.index === undefined) return null;
  const after = draft.slice(open.index + open[0].length);
  // A closing fence means the block is complete — hand off to the committed path.
  if (after.includes('```')) return null;
  // Drop every <script> (complete or the trailing incomplete one) so partial JS
  // can never break the render; the structure and styles still stream in.
  const structural = after.replace(/<script\b[\s\S]*/gi, '');
  if (structural.replace(/\s+/g, '').length < 10) return null; // nothing meaningful yet
  return {
    id: 'agent-html:building',
    title: titleFrom(after) || 'Building…',
    html: structural,
    building: true,
  };
}

/** Complete agent HTML in the transcript → openable canvas artifacts (oldest→newest). */
export function extractAgentArtifacts(
  messages: readonly ChatMessage[],
  projectId: string,
): HtmlPreviewArtifact[] {
  const out: HtmlPreviewArtifact[] = [];
  for (const m of messages) {
    // Only COMPLETE agent messages — never the streaming draft, whose HTML is
    // half-written and would render broken and flicker on every delta.
    if (m.role !== 'agent' || m.pending) continue;

    const blocks: string[] = [];
    HTML_FENCE.lastIndex = 0;
    let match: RegExpExecArray | null = HTML_FENCE.exec(m.text);
    while (match !== null) {
      const body = match[1]?.trim();
      if (body) blocks.push(body);
      match = HTML_FENCE.exec(m.text);
    }
    // No fenced block, but the whole reply IS an HTML document.
    if (blocks.length === 0 && looksLikeHtmlDoc(m.text)) blocks.push(m.text.trim());

    blocks.forEach((html, i) => {
      out.push({
        kind: 'html-preview',
        id: `agent-html:${m.id}:${i}`,
        projectId,
        title: titleFrom(html),
        html,
        contentHash: contentHash(html),
        // Agent-built and shown live inside the sandbox — viewing needs no
        // approval (the sandbox is the boundary); approval is for publishing.
        status: 'approved',
      });
    });
  }
  return out;
}
