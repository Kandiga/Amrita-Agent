# ADR-0034 — Project context probes: files & git, read-only and bounded

- **Status:** accepted (2026-07-12)
- **Context:** reorganization stage R1 (`docs/strategy/reorganization-master-plan.md`
  §1.1, "Files" + "Git"); Project Brain must know the project's working tree honestly.

## Decision

A new daemon module `context.ts` produces a typed, **read-only, bounded** snapshot of a
project's root:

- **git**: `isRepo`, `branch`, `dirtyCount`, `ahead`/`behind` (when an upstream exists),
  `lastCommit` (short SHA + subject). Probed via the same bounded no-shell spawn pattern
  as `runtimes.ts` (injectable prober; timeouts; inconclusive → honest `null`s, never a
  guess).
- **files**: top-level directory summary (name + file count) and a total file count,
  hard-capped (depth ≤ 2, ≤ 2,000 entries visited, `node_modules`/`.git`/dot-caches
  skipped). A project without a `root` returns `{ configured: false }` — needs-setup
  honesty, not an invented tree.

Surface: kernel `getProjectContext(projectId)` → RPC `projects.context` (+ wire schema)
→ Brain view "Project context" block + CLI. The harness `repo` knowledge source's detail
now states whether a root is configured (status stays `manual` — automatic repo→record
ingestion remains planned; ADR-0027's persistence trigger is therefore NOT yet fired,
and `knowledge_records` persistence stays deferred exactly as ADR-0027 documents).

## Invariants & guards

- No writes, ever — probes are `git status --porcelain`-class read commands and
  `readdir` walks; no secret value can appear in the result (paths + counts only).
- Everything bounded: probe timeout ≤ 2s each, walk caps as above.
- Unit-tested against fixture directories and injected probers (no real network; real
  `git` is allowed in tests only against a tmp fixture repo).

## Rollback

Additive only: one daemon module, one kernel method, one RPC verb + schema, one UI block.
