# Amrita v2 repository instructions

## Product and authority

- This repository owns Amrita's daemon, protocol, connector, and federation contracts. It is not the Cinema UI repository.
- `packages/protocol/` is the wire-contract authority. Keep contracts strict, bounded, versioned, and covered by protocol tests.
- Cinema's local execution authority remains in the sibling Aba Adama repository. This repo may delegate a subset but may not redefine the full local Cinema registry.
- `packages/protocol/src/cinema-audio.ts` contains shared Cinema app-to-bridge metadata contracts; those types do not authorize media bytes in federation.

## Engineering discipline

- Use root-cause, SSOT, evidence-first work and preserve unrelated dirty-worktree changes.
- For systemic changes, update or add an ADR, define fitness functions, and prove the boundary before feature code.
- Do not create duplicate protocol shapes or provider policy lists in callers.
- Keep secrets in refs or protected runtime stores; never print or commit credentials.
- Do not push, deploy, migrate data, rotate secrets, or spend paid credits without explicit approval.

## Verification

- Full typecheck: `pnpm typecheck`
- Full lint: `pnpm lint`
- Full tests: `pnpm test`
- Protocol build: `pnpm --filter @amrita/protocol build`
- Protocol focused tests: `pnpm exec vitest run packages/protocol/test/cinema.test.ts packages/protocol/test/cinema-audio.test.ts`
- Inspect `git diff --check`, scoped diffs, and exact command output before reporting completion.

## Cross-repository packaging

When Cinema consumes a protocol change, build and pack the private protocol package, vendor the exact tarball in the Cinema app, update its lockfile, and run both repositories' contract suites. Do not bypass packaging with a source import.
