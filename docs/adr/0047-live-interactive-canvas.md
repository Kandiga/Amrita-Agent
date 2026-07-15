# ADR-0047: The live interactive canvas

- **Status:** Accepted
- **Date:** 2026-07-15
- **Builds on:** ADR-0020 (Native Interactive Surface / Stage-B sandbox), ADR-0044 (`chat.turn` focus)

## Context

The canvas rendered agent-built HTML (CANVAS-1) but as a single, fixed, full-bleed frame. Natanel
wants a claude.ai-Design-grade surface: watch a build take shape **live** as Amrita streams it;
**move / resize / minimize** each build as a card; **select** a card so the next instruction targets
it; several cards at once for a **multi-page site or variations**; and full **mobile** behaviour. Open
Design remains inspiration only — this is Amrita's own surface, built on the existing sandbox.

## Decision

1. **Free-canvas cards are VIEW state, never events.** Card position/size/z-order/minimized live in a
   pure `canvas-layout.ts` and persist to `localStorage` per conversation. They are not domain truth,
   so they never enter the event store — "views are projections" applied to the UI's own chrome.

2. **Live build from the stream.** The claude-code chat provider already streams `text_delta` →
   `model.delta` → the client's `transcript.draft`. `extractStreamingArtifact` pulls the partial HTML
   out of an still-open ```` ```html ```` block and renders it as a "building…" card **with scripts
   stripped** — a half-written `<script>` would break parsing, and a game's init on a partial DOM
   would only error. The operator watches the structure/styles stream in; the completed message then
   yields the full **interactive** artifact via `extractAgentArtifacts`.

3. **Selection-aware artifacts — the one protocol change.** `chatFocusSchema` gains an `'artifact'`
   kind and an optional `label`, and `ids` is relaxed to allow the empty artifact case (a refine keeps
   domain kinds requiring ids and the artifact kind requiring a label). A selected card sets
   `focus {kind:'artifact', label:<title>}`; `renderFocus` tells the model the message is about THAT
   build and to return the complete updated HTML. Additive-optional: every historical `chat.turn`
   focus (a task with ids) still validates byte-for-byte.

4. **Multiple builds.** `agent-canvas.ts` already extracts every ```` ```html ```` block from a reply,
   so a multi-page site or several variations — one titled block each — become several cards. The
   `AMRITA_CAPABILITIES` preamble now instructs one block per page/variation, each with a distinct
   `<title>` (the card label), and how to modify a selected build.

5. **Mobile.** A free canvas is not a touch primitive: under 720px the CSS collapses absolute
   positioning to a readable full-width vertical stack; drag/resize handles hide.

## Consequences

One additive-optional protocol change (`chatFocusSchema`), covered by the wire contract. No store
change. The sandbox (opaque origin, zero-network CSP, 256 KB cap) remains the only security boundary —
scripts run confined, and oversize builds show an honest note instead of throwing. All new logic
(`canvas-layout.ts`, the streaming/multi extractors) is in pure `.ts` modules with unit tests; the
draggable card and canvas shells are `.tsx` shells over that tested logic.
