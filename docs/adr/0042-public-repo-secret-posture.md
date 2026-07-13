# ADR-0042 — Public-repo secret posture + the secret-scan gate

- **Status:** accepted (2026-07-13)
- **Context:** the GitHub remote `Kandiga/Amrita-Agent` is public (and has been since
  creation, ~2026-06-10) — the owner believed it private and asked for a pre-publication
  secret check. An exhaustive adversarial audit (7 scanner dimensions × full history of
  114 commits across `v2-main`/`main`/`v0.1-final`, worktree, config, docs, fixtures,
  entropy blind spots, each with a passing planted-secret negative control) found **zero
  credentials** anywhere. The names-only design held: `packages/protocol/src/secrets.ts`
  (`ENV_SECRET_REF_RE = /^[A-Z][A-Z0-9_]*$/`) stores env-var NAMES not values,
  authoritative secrets live in `~/.amrita/secrets.env` (0600) outside the repo,
  `.gitignore` covers `.env*`/`secrets.env`/`*.db`, and no adapter has a hardcoded token.

## Decision

1. **No history rewrite.** Because the repo has been publicly cloneable for a month, a
   `filter-repo` rewrite un-exposes nothing (GitHub retains objects by SHA; clones/forks/
   caches persist) while breaking every clone. We **redact forward** instead.
2. **Redact third-party PII (forward commit).** `docs/HERMES_INSPIRATION_RESEARCH.md` named
   a third-party client (`openart-chanan` / "OpenArt bot") and documented exploitable
   weaknesses of the operator's *separate* live system (disabled backups, "bypassable"
   allowlist, private usage stats). All third-party identity and attack-useful specifics
   are redacted; the architectural lessons (the doc's actual purpose) are kept verbatim.
   The operator's own first name and the MIT-license legal name stay — the owner's choice.
3. **Executable secret-scan gate.** The quality bar already *mandated* "a precise secret
   scan before push" — but no artifact enforced it. `scripts/scan-secrets.mjs` (zero-dep,
   node built-ins only) is now that single owner: length-gated vendor-key patterns +
   private-key/JWT detection over git-tracked text files, with a fixture-marker allowlist
   so the repo's deliberate inverted test fixtures (`sk-ant-must-not-leak`, …) never trip
   it. Wired as `pnpm scan:secrets` and as a CI gate (`.github/workflows/secret-scan.yml`)
   on every push/PR. (v2-main previously had no `.github/` at all.)

## Non-repo findings (reported to the owner, NOT changed here)

- The deployed web proxy (`deploy/serve-web.mjs`) binds `0.0.0.0:7461` and the host firewall
  allows it — the bearer-gated control plane is internet-reachable. This is a **host/deploy**
  decision (binding to loopback would break the owner's live demo link), left to the owner.
- Commit author/committer metadata on 58 commits is `root@srv<id>.hstgr.cloud` (resolvable
  to the VPS). Go-forward identity is already `Kandiga@users.noreply.github.com`; the
  historical metadata is not a credential and is not rewritten (see decision 1).

## Invariants & guards

- `pnpm scan:secrets` exits non-zero on a probable credential; negative-control verified
  (fires on realistic vendor keys, ignores the tagged fixtures).
- CI runs the scan on every push/PR (pure node, no install, least-privilege `contents: read`).

## Rollback

Additive. Remove the workflow + script + npm entry to revert; the redaction is a normal
forward commit (revert like any other).
