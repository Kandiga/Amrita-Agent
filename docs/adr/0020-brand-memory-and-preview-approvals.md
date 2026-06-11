# ADR-0020: brand memory B1 and preview approvals

- **Status:** Accepted
- **Date:** 2026-06-11
- **Context:** The native-surface strategy (§2.4) calls for per-project brand/design memory so
  previews feel like *this project's* output, and §2.3 Stage B requires that generated HTML
  previews render only inside the shipped sandbox harness **behind an approval flow** — never
  silently. Both need durable, typed, project-scoped state; neither may invent data or store a
  secret. This is the seventh walk of the entity path (ADR-0003/0018 pattern).

## Decision

### Entities (migration `0005_brand_previews`, schema v5)

- **`project_brands`** — one upsert-document row per project (`project_id` PRIMARY KEY →
  projects CASCADE): `name?`, `audience?`, `tone?`, `style_notes_json` (string[]),
  `palette_json` (string[] — free-text notes like `"#0EA5E9 cyan accents"`, deliberately not a
  rigid color schema), `typography?`, `do_not_use_json` (string[] — "never repeat" corrections),
  `source_message_id?`, timestamps. Rebuilt verbatim from `brand.updated` events (the
  brief/ADR-0018 model). **No brand row means no brand** — the UI shows an honest empty state
  and the preview template uses neutral defaults labeled as such, never an invented identity.
- **`preview_approvals`** — `(project_id → projects CASCADE, preview_id, content_hash,
  source_message_id?, approved_at)`, PRIMARY KEY `(project_id, preview_id)`. Approving again
  upserts.

### Events

- `brand.updated` — the full brand document (replay rebuilds the row). A `.refine` requires at
  least one substantive field: an empty brand write is rejected, not stored.
- `preview.approved` — `{previewId, projectId, contentHash, sourceMessageId?}`. `previewId` is a
  deterministic surface id (e.g. `html-preview:<projectId>`), not a ULID.

### The approval lifecycle (deterministic previews, durable approvals)

Stage-B previews are **deterministic pure functions** of typed project state (brief + brand +
milestones/tasks), built client-side by `buildHtmlPreview`. Therefore the HTML itself is never
persisted — what is durable is the **approval**: "content-hash H of preview P is approved for
project X."

- **draft** — editing the brief/brand *is* the draft stage (the documented equivalent of a
  draft state; there is no separate draft artifact).
- **proposed** — the derived preview whose content hash has no matching approval row. Rendered
  in the sandbox with a `proposed` badge and an Approve action. Nothing is auto-approved.
- **approved** — hash matches the stored approval. If underlying state changes, the hash
  changes and the preview honestly **demotes itself to proposed** — an approval can never cover
  content the user did not see.

The content hash is a deterministic change-detection digest (FNV-1a over the rendered HTML),
not a cryptographic commitment — the threat model is "did it change since approval," and the
sandbox (not the hash) is the security boundary.

### Rendering security (unchanged contract, now exercised)

Every preview renders through `buildSandboxedPreview` (apps/web/src/sandbox.ts): iframe
`sandbox="allow-scripts"` (never `allow-same-origin` — asserted), zero-network CSP in the
srcdoc, 256 KB inline budget that throws toward the D9 spill path. The template generator also
HTML-escapes every interpolated project string, so user text cannot break out of the template
markup (defense in depth; the sandbox remains the boundary).

### Surfaces

- Store: `upsertBrand/getBrand`, `approvePreview/listPreviewApprovals` (+ projections).
- RPC: `projects.companion.get` gains `brand` and `previewApprovals`;
  `projects.brand.update`; `projects.previews.approve`.
- CLI: `amrita brand get|set`.
- Web: a Brand panel (editable, honest empty state) in Project Brain; the Surface renders the
  `html-preview` artifact with status badge + approve action.

## Intentionally deferred
LLM/agent-generated previews (the deterministic template is the v1 generator); preview
revocation UI (re-approval covers the flow; a `preview.revoked` event is additive); multiple
named previews per project (the id scheme already permits them); brand asset uploads
(logo files → artifact refs).

## Consequences
Previews are product-real (derived from this project's brief, brand, and plan), approvals are
durable and tamper-evident against state drift, cross-project isolation falls out of
project-keyed rows, and the sandbox contract finally has its first real consumer.
