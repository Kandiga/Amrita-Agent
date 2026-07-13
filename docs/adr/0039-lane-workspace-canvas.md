# ADR-0039 — Lane workspaces on the live canvas

- **Status:** accepted (2026-07-12)
- **Context:** "Amrita built my landing page — where is it?" A real lane writes files
  into its workspace, but nothing serves or renders them: the canvas only shows
  artifacts derived from typed state, the UI's `lanes.start` sends no `scope.paths`
  (so real runs abort on workspace confinement), and there is no default workspace
  policy. What she builds is therefore invisible in the product.

## Decision

1. **Every real run has a workspace.** When a non-dry `lanes.start` names no
   `scope.paths` on a real-execution daemon, the kernel assigns
   `<first allowed root>/<laneId>`, creates it, and seals it into the mandate —
   so the `lane.mandate` event (and the DB row) carry the workspace, and the UI
   never needs to know filesystem paths.
2. **The daemon serves lane workspaces read-only.**
   `GET /lanes/<laneId>/workspace[/<path>]` (same bearer/`?token` gate as
   `/events`): realpath-confined to that lane's workspace, `no-store`,
   content-type by extension, `/` falls back to `index.html` or an honest
   generated file listing. No writes, no directory escapes (403), unknown lane
   or file → 404.
3. **The canvas renders it live.** The web surface derives a `workspace-preview`
   artifact per lane that has a workspace; the canvas iframe loads the daemon
   URL (sandboxed, `allow-scripts`, never `allow-same-origin`) and reloads on
   lane activity, so the page/game/tool grows on screen while the lane works.
   `deploy/serve-web.mjs` proxies `/lanes/*` like `/rpc`.

## Amendment: view tickets, not the bearer (commit-review finding)

Lane-built content is hostile-until-proven: a page can read its own URL, so the
global bearer never enters a frame URL. The canvas mints a **lane-scoped,
expiring (6h), read-only view ticket** (`lanes.workspace.ticket` RPC) and loads
`/lanes/<id>/workspace/t/<ticket>/…` — the ticket rides the PATH so the page's
relative subresources inherit it, and it is refused on every other route
(RPC/events). Every workspace response also carries
`Content-Security-Policy: sandbox allow-scripts; default-src 'self'; connect-src 'none'; …`
(no external fetch/beacon/subresources/forms), `Referrer-Policy: no-referrer`,
and `X-Content-Type-Options: nosniff`; the listing escaper is attribute-safe
(quotes included). Residual exposure of a leaked ticket: read-only access to
that one lane's files for ≤6h — the same files the page itself already contains.

## Invariants & guards

- Path confinement is proved by a traversal test (`..`, absolute, symlink-out
  all refused); auth test proves the token gate.
- Kernel test proves the default workspace: created on disk, inside the allowed
  root, present in the emitted mandate; dry runs and non-real daemons assign none.
- The endpoint never lists or serves anything outside `scope.paths[0]`.

## Rollback

Additive: remove the route + the artifact kind; mandates with explicit paths
behave exactly as before.
