# ADR-0023: the research-lane seam and lane-kind runner routing

- **Status:** Accepted
- **Date:** 2026-06-11
- **Context:** The roadmap's research-lanes stage. Lanes have carried a free-string `kind`
  since Phase 0, but the kernel hardwired one runner (Claude Code) regardless of kind. A
  research lane — "go find sources for X" — is a different execution shape: network reads
  through a search provider, no process spawn, no workspace mutation. No search provider is
  configured or shipped in this slice; the seam must therefore be honest about that.

## Decision

### 1. Runner routing by `kind`
`KernelOptions` gains `extraLaneRunners?: LaneRunner[]`. The kernel keeps the existing
default runner for `claude-code` (and whatever kind the injected default declares — tests
inject `fake`), registers extras by their `kind`, and `startLane` dispatches on the lane's
kind. **An unrecognized kind now aborts honestly** ("no runner registered for lane kind …")
instead of silently running the Claude Code runner — the previous fall-through was a quiet
lie. Approval gating (ADR-0021), budgets, cancellation, and event lifecycle are unchanged —
they live in `runLaneToCompletion`, above the runner seam.

### 2. `ResearchLaneRunner` (`@amrita/lanes`, kind `research`)
Runs a mandate's goal through an injected `ResearchSearchProvider`
(`search(query, {limit, signal}) → {title, url, snippet?}[]`):

- **No provider configured** (the shipped default): the lane aborts with a needs-setup
  summary naming the seam — never a pretend search, never fabricated sources.
- **With a provider:** emits progress, respects cooperative cancellation, and returns a
  `done` MergeReport whose `followUps` carry `title — url` source lines (the merge surface
  the conversation already renders). An empty result set is reported as `partial` — "no
  sources found" is a real outcome, not a failure.
- The runner never throws provider errors upward as crashes: a provider failure is an
  `aborted` report with a value-free reason.

### 3. What this slice does NOT claim
No real search provider ships; nothing claims network research capability. A future
provider (e.g. Brave/Tavily) arrives as a connector manifest (ADR-0022) + a
`ResearchSearchProvider` implementation behind its own review, with the token as an
env-NAME secret ref. LLM synthesis of findings is likewise future work — this ADR is the
typed seam that makes both honest add-ons instead of rewires.

## Consequences
Lane kinds become real dispatch, so future runners (research today; Codex/OpenCode behind
the CodingAgentBridge later) register without touching orchestration. Tests prove the whole
research flow with injected fakes (provider → progress → report) and the honest abort
without one. The unknown-kind behavior change is intentional and documented here.
