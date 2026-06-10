# Contributing

Thanks for looking at Amrita!

## Ground rules

- **Zero runtime dependencies** is a feature. PRs adding npm runtime deps need a very good reason; dev-deps are negotiable.
- TypeScript must stay **erasable-syntax only** (it runs natively on Node ≥ 23.6): no enums, no namespaces, no parameter properties; relative imports include the `.ts` extension; type-only imports use `import type`.
- Conversation-first is the product. Features must be reachable by talking to Amrita; UI chrome is a last resort.
- Integrations must be honest: official auth modes only, "needs setup" over fake "connected".

## Dev loop

```bash
npm install          # typescript + @types/node only
npm run typecheck
npm test             # node --test, isolated AMRITA_HOME per run
AMRITA_HOME=/tmp/amrita-dev node src/cli/main.ts chat
```

## Layout

```
src/shared      types, config, paths
src/core        providers, agent loop, tools, store, memory
src/projects    project manager + vault scaffolding
src/gateway     channel-agnostic routing + bindings
src/channels    telegram (reference adapter)
src/daemon      http server, SSE, magic-link auth
src/scheduler   cron
src/connectors  claude-code, open-design
src/plugins     prompt-engineer
web/            zero-build web client
```

Folders are package boundaries — keep imports flowing shared ← core ← (gateway/daemon/channels), never sideways into a channel.

## Tests

`test/core.test.ts` covers config, sessions/FTS, projects/vault, bindings, context budget, cron, auth, toolset permissions, and the agent loop against the deterministic `mock` provider. New subsystems ship with tests in the same style: real SQLite in a temp `AMRITA_HOME`, no mocking of our own modules.
