# Amrita product direction (stable truths — v3 north star)

- Amrita is a **chat-first Project OS**: project brain and supervisor. Chat stays central;
  typed project state (brief, milestones, questions, risks, tasks, decisions, memory, timeline)
  is the product, with provenance links everywhere.
- **Open Design is NOT a plugin, dependency, embedded product, or engine.** It may be studied
  as inspiration only. Amrita has her **own Native Interactive Surface**
  (docs/strategy/native-interactive-surface.md): typed ArtifactSpecs, staged rendering —
  deterministic renderers now, sandboxed HTML later, approval-gated generated components last.
- **Claude Code is a managed execution runtime, never the product center.** Future coding
  agents (Codex, OpenCode, local) fit behind a typed `CodingAgentBridge` / lane contract —
  never ad-hoc UI buttons.
- **Provider/model/runtime selection is first-class and user-visible in the app.** Resolution
  is deterministic: session/turn > lane/task > project > global > auto. Claude Code
  model/effort/profile is configurable where the CLI supports it and honestly `unsupported`
  where it does not.
- **Honest integrations only** (project identity since v0.1): unconfigured says "needs setup"
  with the exact fix command; no fake green badges, no fake canvas/installer/provider states.
- **Secrets never enter** the store, events, artifacts, logs, UI, tests, or coding-agent
  handoffs. The DB holds env-var *names* only; the frontend sees redacted status booleans only.
- **Windows-first installer path** (docs/strategy/windows-installer-and-updates.md): Electron
  shell recommended; CLI/daemon mode preserved forever; nothing claimed as working without a
  real tested build.
- **Self-maintenance is audited:** rule/skill changes are explicit, diffable, reversible,
  committed separately, never secret-bearing, and record stable truths — task progress belongs
  in docs/progress/amrita-v2-upgrade-ledger.md, not in rules.
