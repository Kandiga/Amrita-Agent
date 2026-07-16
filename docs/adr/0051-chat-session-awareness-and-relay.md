# ADR-0051: Chat session awareness + input relay

- **Status:** Accepted
- **Date:** 2026-07-16
- **Builds on:** ADR-0048 (orchestration), ADR-0050 (project Session Workspace)

## Context

Live QA (2026-07-16): a session asked an interactive menu question; the operator
told Amrita "תבחרי אופציה 2" and she answered, honestly, that she has no window
into the session. The manager could neither SEE her execution arms nor ACT on a
direct relay instruction — both halves of "Amrita is the managerial brain" were
missing at the chat layer.

## Decision

1. **Eyes — derived, never stored.** The chat context pack gains an
   `Active execution sessions` section: per non-terminal interactive lane
   (newest first, max 3), the agent, runtime state, goal, and the last ≤8
   redacted lines of the VISIBLE screen. It is assembled per turn from
   `getSessionSnapshot` — the existing runtime-state authority — so there is no
   second truth store, no cache, and no persistence. A probe failure degrades to
   "no brief", never a failed turn. An active session counts as project state
   (a bare project with a session still gets a pack).

2. **Hands — a deterministic pre-turn relay seam.** `classifyRelay`
   (execution-route.ts, pure) recognizes only two conservative shapes:
   an imperative option pick ("תבחרי אופציה 2", "בחר 3", bare "אופציה 2"), and
   explicit free-text relay that REQUIRES the session word ("שלחי לסשן: …").
   Past tense, questions, and target-only clauses ("בחר בסשן 2") do not match.
   `runRelay` executes BEFORE the provider call so the reply can truthfully
   confirm the outcome, and injects a value-free `SESSION RELAY` note into the
   system message (sent / refused-with-reason / ambiguous-ask-which /
   no-session). With multiple active sessions and no explicit target
   ("בסשן N", newest = 1), nothing is sent.

3. **One enforcement path.** The relay writes exclusively through the guarded
   `sendSessionInput` (ADR-0050): project ownership, agent/cwd identity, and the
   screen classifier still refuse login/trust/blocked/dead panes. The relay adds
   a coarse, value-free `lane.progress` audit note ("operator input relayed from
   chat") — the text itself is never logged. Kill-switch: `orchestration.enabled`
   disables both the section and the seam. No protocol, store, or wire change.

## Consequences

- "מה הסשן שואל?" is answerable from the pack; "תבחרי אופציה 2" happens before
  the reply and is confirmed honestly — the preamble forbids claiming no access.
- A relay instruction in chat can now type into a live session: bounded by the
  conservative grammar, the ADR-0050 screen guards, the single-target rule, and
  the audit note. The operator's own message is the authorization.
- Latency cost per chat turn: one lane query, plus ≤3 snapshot probes and at
  most one send — all failure-tolerant and skipped when orchestration is off.

## Verification

`packages/daemon/test/relay.test.ts` (grammar negatives/positives; pane receives
exactly the digits; login screen refusal keeps the turn alive; multi-session
ambiguity sends nothing; named target hits the right session; kill-switch;
plain chat never touches the session) and `context-pack.test.ts` (section
renders bounded, counts as state, absent when empty).
