# ADR-0035 — Skill registry: System / Shared / Project tiers with mandatory manifest, permissions, docs

- **Status:** accepted (2026-07-12)
- **Context:** reorganization stage R1 (`docs/strategy/reorganization-master-plan.md`
  §1.2); Hermes research §7 (per-channel toolset gating; guarded agent-created skills).

## Decision

Amrita gets a typed **skill registry** — the governance layer that every current and
future skill must pass through. Three tiers:

| Tier | Lives | Authority |
|---|---|---|
| `system` | code-registered in `@amrita/daemon` (like connector manifests) | shipped with Amrita, not user-editable |
| `shared` | `~/.amrita/skills/<name>/skill.json` | user-installed, all projects |
| `project` | `<project root>/.amrita/skills/<name>/skill.json` | scoped to one project |

**Mandatory for every skill — schema-enforced, not convention** (`skillManifestSchema`
in `@amrita/protocol`):

1. **Registry entry**: a parseable manifest (name slug, tier, version, description,
   owner). A directory without a valid manifest is listed as `unregistered`/`invalid`
   with a value-free reason and is **never loadable**.
2. **Permissions**: `permissions.toolsets` (deny-by-default — an empty list grants
   nothing) and optional `permissions.channels` (which channels may invoke it).
3. **Docs**: a non-empty `usage` text (≥ 20 chars). No docs → `invalid`, refused.

Honesty rules: the registry **registers and gates** — it does not execute. Amrita has no
skill executor yet; every surface says so (`state: active` means "registered and
loadable", never "runnable"). The first system skills describe capabilities that already
exist as RPC verbs (brain capture, GitHub import, conversation compress), so the registry
ships with real content and zero pretense.

Surface: RPC `skills.list {projectId?}` (+ wire schema), doctor `skills` section, CLI
`amrita skills`.

Future (documented, not built): agent-created skills get `origin: agent` + write-gating
and archive-never-delete curator invariants (Hermes lesson) when a skill executor lands.

## Rollback

Additive only: one protocol module, one daemon module, one RPC verb, doctor section, CLI
command. No store change — the filesystem + code registry are the manifest authority.
