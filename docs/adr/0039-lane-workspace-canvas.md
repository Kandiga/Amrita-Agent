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

## Invariants & guards

- Path confinement is proved by a traversal test (`..`, absolute, symlink-out
  all refused); auth test proves the token gate.
- Kernel test proves the default workspace: created on disk, inside the allowed
  root, present in the emitted mandate; dry runs and non-real daemons assign none.
- The endpoint never lists or serves anything outside `scope.paths[0]`.

## Rollback

Additive: remove the route + the artifact kind; mandates with explicit paths
behave exactly as before.
